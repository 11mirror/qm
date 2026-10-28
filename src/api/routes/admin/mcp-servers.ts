import {
  isValidMcpServerId,
  type McpApprovalPolicy,
  type McpServer,
  type McpServerAuthMode,
} from "../../../mcp/mcp-server-store.ts";
import { isAccountType, PROVIDERS } from "../../../connectors/oauth.ts";
import { discoverOAuth, httpsUrl, parseScopes, type DiscoveredOAuth } from "../../../mcp/oauth-discovery.ts";
import { type ApiCtx, ok, reply, type RouteResult } from "../route.ts";
import { badRequest, notFound, orgAdmin } from "./common.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials", "oauth-user"];
const APPROVAL_POLICIES: McpApprovalPolicy[] = ["annotations", "all", "none"];

const given = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

function redact(server: McpServer): Omit<McpServer, "bearerToken" | "clientSecret"> & {
  hasBearerToken: boolean;
  hasClientSecret: boolean;
} {
  const { bearerToken, clientSecret, ...rest } = server;
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret };
}

export async function getMcpServers(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  if (!ctx.deps.mcpServers) throw notFound();
  authz.audit("mcp-servers.read", "mcp-servers");
  const servers = await ctx.deps.mcpServers.list();
  return ok({
    servers: servers.map(redact),
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, description, readOnly, needsApproval }) => ({
      name,
      serverId,
      description,
      readOnly,
      needsApproval,
    })),
  });
}

export async function putMcpServer(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  if (!ctx.deps.mcpServers) throw notFound();
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id))
    throw badRequest("id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter");
  const b = ctx.body as Partial<McpServer> & { validate?: boolean };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("url must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw badRequest("url must be http(s)");
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw badRequest("url must not carry credentials, query, or fragment");
  const auth = (b.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) throw badRequest(`auth must be one of ${AUTH_MODES.join(", ")}`);
  const existing = await ctx.deps.mcpServers.get(id);
  const approval = b.approval ?? existing?.approval ?? "annotations";
  if (!APPROVAL_POLICIES.includes(approval))
    throw badRequest(`approval must be one of ${APPROVAL_POLICIES.join(", ")}`);
  const oauthUser = auth === "oauth-user";
  const catalog = (b.catalog ?? existing?.catalog) === true;
  const attestActor = (b.attestActor ?? existing?.attestActor) === true;
  if ((catalog || attestActor) && oauthUser)
    throw badRequest("catalog and attestActor are not available with oauth-user auth");
  if (oauthUser && PROVIDERS[id]) throw badRequest(`id ${id} is reserved by a built-in connector`);
  const credentialScope = oauthUser ? "per-user" : (b.credentialScope ?? existing?.credentialScope ?? "shared");
  if (credentialScope !== "shared" && credentialScope !== "per-user")
    throw badRequest("credentialScope must be shared or per-user");
  if (attestActor && (!catalog || credentialScope !== "shared" || (auth !== "bearer" && auth !== "client-credentials")))
    throw badRequest(
      "attestActor requires catalog, shared credentials, and bearer or client-credentials auth, so only QM can assert the person",
    );
  const credentialHost = b.credentialHost ?? existing?.credentialHost ?? (oauthUser ? parsed.hostname : undefined);
  if (
    oauthUser &&
    typeof credentialHost === "string" &&
    Object.values(PROVIDERS).some((p) =>
      p.hosts.some((h) => credentialHost === h || credentialHost.endsWith(`.${h}`) || h.endsWith(`.${credentialHost}`)),
    )
  )
    throw badRequest("credentialHost is already used by another connector");
  for (const field of ["oauthAuthorizeUrl", "oauthTokenUrl"] as const) {
    if (oauthUser && b[field] !== undefined && !httpsUrl(b[field])) throw badRequest(`${field} must be an HTTPS URL`);
  }
  let oauthAuthorizeUrl = httpsUrl(b.oauthAuthorizeUrl) ?? (oauthUser ? existing?.oauthAuthorizeUrl : undefined);
  let oauthTokenUrl = httpsUrl(b.oauthTokenUrl) ?? (oauthUser ? existing?.oauthTokenUrl : undefined);
  const credentialAccountType = b.credentialAccountType ?? existing?.credentialAccountType ?? "default";
  if (!isAccountType(credentialAccountType))
    throw badRequest("credentialAccountType must be default, personal, or company");
  if (
    credentialScope === "per-user" &&
    (typeof credentialHost !== "string" ||
      !credentialHost ||
      credentialHost !== credentialHost.trim() ||
      credentialHost.length > 253 ||
      /[\s/\\?#@]/.test(credentialHost))
  )
    throw badRequest("per-user credentials require a credentialHost");
  if (
    credentialScope === "per-user" &&
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  )
    throw badRequest("per-user credentials require HTTPS (except loopback)");
  let discovered: DiscoveredOAuth | undefined;
  if (oauthUser && (!oauthAuthorizeUrl || !oauthTokenUrl)) {
    discovered = await discoverOAuth(parsed);
    oauthAuthorizeUrl ??= discovered.authorize;
    oauthTokenUrl ??= discovered.token;
  }
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    credentialScope,
    ...(credentialScope === "per-user" ? { credentialHost, credentialAccountType } : {}),
    ...(auth === "bearer" ? { bearerToken: given(b.bearerToken) ?? existing?.bearerToken } : {}),
    ...(oauthUser
      ? {
          clientId: given(b.clientId)?.trim() ?? existing?.clientId,
          oauthAuthorizeUrl,
          oauthTokenUrl,
          oauthScopes: parseScopes(b.oauthScopes) ?? existing?.oauthScopes ?? discovered?.scopes ?? [],
        }
      : {}),
    ...(auth === "client-credentials"
      ? {
          clientId: given(b.clientId) ?? existing?.clientId,
          clientSecret: given(b.clientSecret) ?? existing?.clientSecret,
        }
      : {}),
    ...(approval === "annotations" ? {} : { approval }),
    ...(catalog ? { catalog } : {}),
    ...(attestActor ? { attestActor } : {}),
    readOnly: b.readOnly !== false,
    enabled: b.enabled !== false,
    updatedAt: Date.now(),
    updatedBy: authz.actor.id,
  };
  if (auth === "bearer" && !server.bearerToken) throw badRequest("bearer auth requires bearerToken");
  if (auth === "client-credentials" && (!server.clientId || !server.clientSecret))
    throw badRequest("client-credentials auth requires clientId and clientSecret");
  if (oauthUser && (!server.clientId || !server.oauthAuthorizeUrl || !server.oauthTokenUrl))
    throw badRequest(
      "oauth-user auth requires clientId plus HTTPS oauthAuthorizeUrl and oauthTokenUrl, or OAuth metadata to discover them" +
        (discovered?.errors.length ? ` (discovery: ${discovered.errors.join("; ")})` : ""),
    );
  let toolNames: string[] | undefined;
  if (b.validate !== false && !oauthUser && ctx.deps.mcpToolService) {
    try {
      const listing = await ctx.deps.mcpToolService.probe(server, authz.actor.id);
      toolNames = listing.tools.map((t) => t.name);
      if (listing.about) server.about = listing.about;
    } catch (e) {
      return reply(400, {
        error: "unreachable",
        message: `tools/list against ${parsed.host} failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  await ctx.deps.mcpServers.put(server);
  authz.audit("mcp-servers.update", id);
  return ok({ ok: true, server: redact(server), ...(toolNames ? { tools: toolNames } : {}) });
}

export async function deleteMcpServer(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  if (!ctx.deps.mcpServers) throw notFound();
  const id = ctx.params.id ?? "";
  if (!(await ctx.deps.mcpServers.get(id))) throw notFound();
  await ctx.deps.mcpServers.delete(id);
  authz.audit("mcp-servers.delete", id);
  return ok({ ok: true });
}
