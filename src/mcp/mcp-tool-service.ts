// Turns registered MCP servers into callable agent tools.
//
// Maintains a cached snapshot of each enabled server's tool list (refreshed
// when the registry changes and on a slow interval), and executes calls with
// the server's configured credential. Every call is audited. Tool names are
// namespaced `<serverId>_<toolName>` so two servers can't collide with each
// other or with built-in tools.

import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { errMessage, reportFailureAs } from "../util/errors.ts";
import { setPublicOAuthClients, type PublicOAuthClient } from "../connectors/oauth.ts";
import { LRUCache } from "lru-cache";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpListing } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";
import type { McpHostContext } from "../types.ts";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../util/canonical-json.ts";
import { mintMcpAttestation } from "./mcp-attestation.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const CATALOG_TTL_MS = 60_000;
const CATALOG_CACHE_MAX = 1_000;
const CATALOG_MAX_TOOLS = 5_000;
const CATALOG_SEARCH_LIMIT = 50;
const CATALOG_OPERATIONS = ["search", "describe", "invoke"];
const DROPPED_OPTIONAL_PARAMS = ["intent", "locale"];
const ATTESTATION_TTL_MS = 60_000;

function modelInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const dropped = DROPPED_OPTIONAL_PARAMS.filter((name) => Object.hasOwn(properties, name) && !required.has(name));
  if (!dropped.length) return schema;
  const kept = { ...(properties as Record<string, unknown>) };
  for (const name of dropped) delete kept[name];
  return { ...schema, properties: kept };
}

function mcpToolNeedsApproval(
  server: Pick<McpServer, "approval">,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
): boolean {
  const policy = server.approval ?? "annotations";
  if (policy !== "annotations") return policy === "all";
  return annotations?.destructiveHint === true && annotations.readOnlyHint !== true;
}

export function mcpPublicOAuthClients(servers: McpServer[]): PublicOAuthClient[] {
  return servers.flatMap((s) =>
    s.enabled && s.auth === "oauth-user" && s.clientId && s.oauthAuthorizeUrl && s.oauthTokenUrl && s.credentialHost
      ? [
          {
            name: s.id,
            host: s.credentialHost,
            authUrl: s.oauthAuthorizeUrl,
            tokenUrl: s.oauthTokenUrl,
            scopes: s.oauthScopes ?? [],
            clientId: s.clientId,
            resource: s.url,
            label: s.name,
          },
        ]
      : [],
  );
}

export interface McpToolDescriptor {
  /** Namespaced tool name exposed to the model, e.g. "salesforce_query". */
  name: string;
  serverId: string;
  serverName: string;
  serverAbout?: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  needsApproval: boolean;
  signIn?: true;
  catalog?: true;
}

export interface McpToolService {
  /** Current snapshot of injectable tools across enabled servers. */
  toolDefs(): McpToolDescriptor[];
  toolDefsFor(principalId?: string): Promise<McpToolDescriptor[]>;
  /** Call a namespaced tool. Returns the tool's text output (clamped). */
  call(
    name: string,
    args: Record<string, unknown>,
    principalId?: string,
    approval?: string,
    invocation?: McpInvocation,
  ): Promise<McpToolCallResult>;
  needsApproval(name: string, args: Record<string, unknown>, principalId?: string): Promise<boolean>;
  /** Force a registry re-read + tools/list refresh (admin save path, tests). */
  refresh(): Promise<void>;
  probe(server: McpServer, principalId?: string): Promise<McpListing>;
  close(): void;
}

export interface McpToolCallResult {
  text: string;
  outputReceipt?: string;
  outputSha256?: string;
  contextSha256?: string;
}

export interface McpInvocation {
  callId: string;
  context: McpHostContext;
}

interface AttestedCall {
  token: string;
  claims: {
    serverId: string;
    toolName: string;
    argumentsSha256: string;
    callId: string;
  };
}

class SignInRequired extends Error {}

type RemoteTool = NonNullable<McpServer["tools"]>[number];

function catalogDescriptor(server: McpServer): McpToolDescriptor {
  return {
    name: server.id,
    serverId: server.id,
    serverName: server.name,
    remoteName: "",
    catalog: true,
    description: `${server.name}: a catalog of tools behind one interface. Search for a tool, describe it to see its parameters, then invoke it. Tools marked "needs approval" pause until the person approves that exact call.`,
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: CATALOG_OPERATIONS,
          description: "search finds tools; describe shows one tool's parameters; invoke runs one tool.",
        },
        query: {
          type: "string",
          description: "search: words to match in tool names and descriptions; omit to list every tool.",
        },
        tool: { type: "string", description: "describe and invoke: a tool name from search." },
        arguments: {
          type: "object",
          description: "invoke: the tool's arguments, matching its parameters from describe.",
        },
      },
      required: ["operation"],
    },
    readOnly: server.readOnly,
    needsApproval: false,
  };
}

function resultText(result: CallToolResult): string {
  return mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
}

function callResource(def: McpToolDescriptor, args: Record<string, unknown>): string {
  if (!def.catalog) return `${def.serverId}/${def.remoteName}`;
  return `${def.serverId}/${typeof args.tool === "string" ? args.tool : String(args.operation)}`;
}

function headersFor(server: McpServer, principalId: string | undefined, approval?: string): Record<string, string> {
  if (!server.attestActor || server.credentialScope === "per-user") return {};
  if (!principalId) throw new Error(`MCP server ${server.id} needs a signed-in person`);
  return { "x-qm-actor": principalId, ...(approval ? { "x-qm-approval": approval } : {}) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function completeHostContext(invocation: McpInvocation | undefined, principalId: string | undefined): McpInvocation {
  const value = invocation;
  const context = value?.context;
  const slackComplete =
    context?.surface !== "slack" ||
    Boolean(context.slackSource?.accountId && context.slackSource.teamId && context.slackSource.userId);
  if (
    !value?.callId ||
    !context?.actorId ||
    context.actorId !== principalId ||
    !context.scopeId ||
    !context.session?.id ||
    !context.session.threadRef ||
    !context.surface ||
    !context.runtime?.harnessId ||
    !context.runtime.modelId ||
    !slackComplete
  ) {
    throw new Error("attested MCP call requires complete host context matching the initiating person");
  }
  return value;
}

function catalogSearch(server: McpServer, tools: RemoteTool[], query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = tools.filter((t) => {
    const text = `${t.name} ${t.description}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
  if (!hits.length) return `No ${server.name} tools match "${query}".`;
  const lines = hits.slice(0, CATALOG_SEARCH_LIMIT).map((t) => {
    const summary = (t.description.split("\n")[0] ?? "").slice(0, 200);
    return `- ${t.name}${mcpToolNeedsApproval(server, t.annotations) ? " (needs approval)" : ""}: ${summary}`;
  });
  if (hits.length > CATALOG_SEARCH_LIMIT)
    lines.push(`…and ${hits.length - CATALOG_SEARCH_LIMIT} more; narrow the query.`);
  return lines.join("\n");
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  userTokens?: Pick<ConnectorTokenStore, "connectorAccessToken" | "connectorTokenStatus">;
  now?: () => number;
  refreshIntervalMs?: number;
  signInUrl?: (serverId: string) => string;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  let snapshot: McpToolDescriptor[] = [];
  let perUserServers = new Map<string, McpServer>();
  const catalogs = new LRUCache<string, Promise<RemoteTool[]>>({ max: CATALOG_CACHE_MAX, ttl: CATALOG_TTL_MS });

  async function attestedHeaders(
    server: McpServer,
    toolName: string,
    args: Record<string, unknown>,
    principalId: string | undefined,
    approval: string | undefined,
    invocation: McpInvocation | undefined,
  ): Promise<{ headers: Record<string, string>; attested?: AttestedCall }> {
    const headers = headersFor(server, principalId, approval);
    if (!server.attestContext) return { headers };
    if (
      !server.catalog ||
      !server.attestActor ||
      (server.credentialScope ?? "shared") !== "shared" ||
      (server.auth !== "bearer" && server.auth !== "client-credentials")
    ) {
      throw new Error(`MCP server ${server.id} has an invalid attestation configuration`);
    }
    if (!server.attestationPrivateKey || !server.attestationPublicKey || !server.attestationKeyId) {
      throw new Error(`MCP server ${server.id} has no attestation keypair`);
    }
    const complete = completeHostContext(invocation, principalId);
    const issuedAt = now();
    const argumentsSha256 = sha256(canonicalJson(args));
    const claims = {
      kind: "qm.mcp-call-context",
      version: 1,
      actorId: complete.context.actorId,
      scopeId: complete.context.scopeId,
      sessionId: complete.context.session.id,
      threadRef: complete.context.session.threadRef,
      surface: complete.context.surface,
      ...(complete.context.slackSource
        ? {
            slackSource: {
              accountId: complete.context.slackSource.accountId,
              teamId: complete.context.slackSource.teamId,
              userId: complete.context.slackSource.userId,
            },
          }
        : {}),
      ...(complete.context.runId ? { runId: complete.context.runId } : {}),
      ...(complete.context.attempt !== undefined ? { attempt: complete.context.attempt } : {}),
      runtime: complete.context.runtime,
      serverId: server.id,
      toolName,
      argumentsSha256,
      callId: complete.callId,
      ...(approval ? { approvalKey: approval } : {}),
      issuedAt,
      expiresAt: issuedAt + ATTESTATION_TTL_MS,
      nonce: randomUUID(),
    };
    const token = await mintMcpAttestation(claims, server.attestationPrivateKey, "call-context");
    return {
      headers: { ...headers, "x-qm-context": token },
      attested: {
        token,
        claims: { serverId: server.id, toolName, argumentsSha256, callId: complete.callId },
      },
    };
  }

  async function withOutputReceipt(
    server: McpServer,
    output: string,
    call: AttestedCall | undefined,
  ): Promise<McpToolCallResult> {
    if (!call) return { text: output };
    if (!server.attestationPrivateKey) throw new Error(`MCP server ${server.id} has no attestation private key`);
    const issuedAt = now();
    const outputSha256 = sha256(output);
    const contextSha256 = sha256(call.token);
    const receipt = await mintMcpAttestation(
      {
        kind: "qm.mcp-output-receipt",
        version: 1,
        ...call.claims,
        contextSha256,
        outputSha256,
        issuedAt,
        nonce: randomUUID(),
      },
      server.attestationPrivateKey,
      "output-receipt",
    );
    return { text: output, outputReceipt: receipt, outputSha256, contextSha256 };
  }

  function signInMessage(server: McpServer): string {
    const url = opts.signInUrl?.(server.id);
    return url
      ? `Sign in to ${server.name} first: [Connect ${server.name}](${url}). Then try again.`
      : `Sign in to ${server.name} from the Connectors page first, then try again.`;
  }
  let closed = false;

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `mcp.${action}`,
      resource,
      scopeLabel: "mcp-connectors",
      status,
    });
  }

  function clientFor(server: McpServer): McpClient {
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    const client = createMcpClient({ url: server.url, auth: authOf(server) });
    clients.set(server.id, { client, server });
    return client;
  }

  async function callerClient(server: McpServer, principalId?: string): Promise<McpClient> {
    if ((server.credentialScope ?? "shared") === "shared") return clientFor(server);
    if (server.credentialScope !== "per-user") throw new Error("invalid MCP credential scope");
    if (!principalId || !server.credentialHost || !opts.userTokens) {
      throw new Error(`MCP server ${server.id} requires a connected user account`);
    }
    const token = await opts.userTokens.connectorAccessToken(
      server.credentialHost,
      principalId,
      server.credentialAccountType,
    );
    if (!token) {
      if (server.auth === "oauth-user") throw new SignInRequired(signInMessage(server));
      throw new Error(`Connect your account for MCP server ${server.id} before using this tool`);
    }
    return createMcpClient({ url: server.url, auth: { mode: "bearer", token } });
  }

  async function catalogTools(server: McpServer, principalId?: string): Promise<RemoteTool[]> {
    const client = await callerClient(server, principalId);
    const perPerson = server.attestActor || server.credentialScope === "per-user";
    const key = `${server.id}\0${server.updatedAt}\0${perPerson ? (principalId ?? "") : ""}`;
    const cached = catalogs.get(key);
    if (cached) return cached;
    const listing = client
      .listTools({ headers: headersFor(server, principalId), maxTools: CATALOG_MAX_TOOLS })
      .then((listed) => listed.tools);
    catalogs.set(key, listing);
    listing.catch(() => {
      if (catalogs.peek(key) === listing) catalogs.delete(key);
    });
    return listing;
  }

  async function catalogEntry(server: McpServer, principalId: string | undefined, name: unknown): Promise<RemoteTool> {
    if (typeof name !== "string" || !name) throw new Error("tool is required");
    const entry = (await catalogTools(server, principalId)).find((t) => t.name === name);
    if (!entry) throw new Error(`Unknown ${server.name} tool: ${name}. Search for it first.`);
    return entry;
  }

  async function callCatalog(
    server: McpServer,
    args: Record<string, unknown>,
    principalId: string | undefined,
    approval: string | undefined,
    invocation: McpInvocation | undefined,
  ): Promise<McpToolCallResult> {
    if (args.operation === "search") {
      const query = typeof args.query === "string" ? args.query : "";
      return { text: catalogSearch(server, await catalogTools(server, principalId), query) };
    }
    const entry = await catalogEntry(server, principalId, args.tool);
    if (args.operation === "describe") {
      return {
        text: JSON.stringify({
          name: entry.name,
          description: entry.description,
          needsApproval: mcpToolNeedsApproval(server, entry.annotations),
          parameters: modelInputSchema(entry.inputSchema),
        }),
      };
    }
    if (args.operation !== "invoke") throw new Error(`operation must be one of ${CATALOG_OPERATIONS.join(", ")}`);
    const input = args.arguments ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("arguments must be an object");
    if (mcpToolNeedsApproval(server, entry.annotations) && !approval)
      throw new Error(`${entry.name} needs the person's approval; call it again so they get an approval card.`);
    const client = await callerClient(server, principalId);
    const call = await attestedHeaders(
      server,
      entry.name,
      input as Record<string, unknown>,
      principalId,
      approval,
      invocation,
    );
    const result = await client.callTool(entry.name, input as Record<string, unknown>, call.headers);
    record("call", `${server.id}/${entry.name}`, approval ? "ok approved" : "ok", principalId);
    return withOutputReceipt(server, resultText(result), call.attested);
  }

  async function refresh(): Promise<void> {
    catalogs.clear();
    const all = await opts.servers.list();
    setPublicOAuthClients(mcpPublicOAuthClients(all));
    const servers = all.filter((s) => s.enabled);
    const next: McpToolDescriptor[] = [];
    const nextPerUser = new Map<string, McpServer>();
    for (const server of servers) {
      try {
        let tools: NonNullable<McpServer["tools"]>;
        let about = server.about;
        if (server.catalog) {
          next.push(catalogDescriptor(server));
          continue;
        }
        if (server.auth === "oauth-user") {
          nextPerUser.set(server.id, server);
          next.push({
            name: `${server.id}_sign_in`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            serverName: server.name,
            remoteName: "sign_in",
            signIn: true,
            description: `Connect your own ${server.name} account and load its tools. Call this before anything else on ${server.name}.`,
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
            needsApproval: false,
          });
          tools = server.tools ?? [];
          if (!tools.length) continue;
        } else {
          const listing = await clientFor(server).listTools({ headers: headersFor(server, undefined) });
          tools = listing.tools;
          about = listing.about ?? about;
        }
        for (const tool of tools) {
          next.push({
            name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
            serverId: server.id,
            serverName: server.name,
            ...(about ? { serverAbout: about } : {}),
            remoteName: tool.name,
            description: tool.description || `${tool.name} on ${server.name}`,
            inputSchema: modelInputSchema(tool.inputSchema),
            readOnly: server.readOnly,
            needsApproval: mcpToolNeedsApproval(server, tool.annotations),
          });
        }
        record("list", server.id, `ok tools=${tools.length}`);
      } catch (e) {
        record("list", server.id, `error: ${errMessage(e)}`);
      }
    }
    // De-duplicate on the namespaced name; first server wins deterministically.
    const seen = new Set<string>();
    snapshot = next.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
    perUserServers = nextPerUser;
  }

  async function connected(server: McpServer, principalId: string | undefined): Promise<boolean> {
    if (!principalId || !server.credentialHost || !opts.userTokens) return false;
    const status = await opts.userTokens
      .connectorTokenStatus(server.credentialHost, principalId, server.credentialAccountType)
      .catch(reportFailureAs("mcp: connector status", null));
    return Boolean(status?.connected && !status.needsReconnect);
  }

  async function toolDefsFor(principalId?: string): Promise<McpToolDescriptor[]> {
    const current = snapshot;
    const gated = perUserServers;
    if (!gated.size) return current;
    const withTools = new Set(current.filter((t) => gated.has(t.serverId) && !t.signIn).map((t) => t.serverId));
    const ready = new Set<string>();
    await Promise.all(
      [...withTools].map(async (id) => {
        if (await connected(gated.get(id)!, principalId)) ready.add(id);
      }),
    );
    return current.filter((t) => !gated.has(t.serverId) || Boolean(t.signIn) !== ready.has(t.serverId));
  }

  const refreshInBackground = (): void => {
    if (!closed) void refresh().catch(reportFailureAs("mcp: refresh tools", undefined));
  };
  const unsubscribe = opts.servers.onChange(refreshInBackground);
  const timer = setInterval(refreshInBackground, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  refreshInBackground();

  return {
    toolDefs: () => snapshot,
    toolDefsFor,
    async needsApproval(name, args, principalId) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      if (!def.catalog) return def.needsApproval;
      if (args.operation !== "invoke") return false;
      try {
        const server = await opts.servers.get(def.serverId);
        if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
        return mcpToolNeedsApproval(server, (await catalogEntry(server, principalId, args.tool)).annotations);
      } catch (e) {
        record("call", callResource(def, args), `approval check error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    async call(name, args, principalId, approval, invocation) {
      const def = snapshot.find((t) => t.name === name);
      if (!def) throw new Error(`unknown MCP tool: ${name}`);
      const server = await opts.servers.get(def.serverId);
      if (!server || !server.enabled) throw new Error(`MCP server ${def.serverId} is not available`);
      try {
        if (def.catalog) return await callCatalog(server, args, principalId, approval, invocation);
        const client = await callerClient(server, principalId);
        if (def.signIn) {
          const { tools, about } = await client.listTools();
          const current = await opts.servers.get(server.id);
          if (current) await opts.servers.put({ ...current, tools, about: about ?? current.about });
          await refresh();
          record("call", `${def.serverId}/sign_in`, `ok tools=${tools.length}`, principalId);
          return {
            text: `Signed in to ${server.name}. Tools now available on server "${server.id}": ${tools.map((t) => t.name).join(", ")}`,
          };
        }
        const call = await attestedHeaders(server, def.remoteName, args, principalId, approval, invocation);
        const result = await client.callTool(def.remoteName, args, call.headers);
        record("call", `${def.serverId}/${def.remoteName}`, approval ? "ok approved" : "ok", principalId);
        return withOutputReceipt(server, resultText(result), call.attested);
      } catch (e) {
        if (e instanceof SignInRequired) {
          record("call", callResource(def, args), "sign-in required", principalId);
          return { text: e.message };
        }
        record("call", callResource(def, args), `error: ${errMessage(e)}`, principalId);
        throw e;
      }
    },
    refresh,
    async probe(server, principalId) {
      return createMcpClient({ url: server.url, auth: authOf(server) }).listTools({
        headers: headersFor(server, principalId),
        ...(server.catalog ? { maxTools: CATALOG_MAX_TOOLS } : {}),
      });
    },
    close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
