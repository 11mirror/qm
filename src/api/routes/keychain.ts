import {
  renderAskNotice,
  type CredentialFieldInput,
  type CredentialFile,
  type GrantMode,
} from "../../credentials/keychain.ts";
import { parseScopeId } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { approvalCardDestination } from "../../credentials/keychain-approval.ts";
import { sendJson } from "../http.ts";
import { normalizeInboundExpiresAt } from "../expiry.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { audit, resolveCapabilityDestination } from "./shared.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import { cronIdOf } from "../../sessions/thread-ref.ts";

async function resolveScopeNames(
  app: ApiCtx["app"],
  deps: ApiCtx["deps"],
  scopeIds: Iterable<string>,
): Promise<Record<string, string>> {
  const wanted = [...new Set(scopeIds)];
  if (!wanted.length) return {};
  const names: Record<string, string> = {};
  const sessionScopes =
    (await Promise.resolve(deps.sessions?.distinctScopes()).catch(swallowAs("keychain scope names: sessions", null))) ??
    [];
  const byScope = new Map(sessionScopes.filter((s) => s.channelName).map((s) => [s.scopeId, s.channelName!]));
  const loadChannels = async () =>
    new Map(
      (await app.directoryChannels().catch(swallowAs("keychain scope names: channels", []))).map((c) => [
        c.channelId,
        c.name,
      ]),
    );
  const loadMembers = async () =>
    new Map(
      (await app.directoryMembers().catch(swallowAs("keychain scope names: members", []))).map((m) => [
        m.principalId,
        m.displayName,
      ]),
    );
  let channelsById: Map<string, string> | null = null;
  let membersById: Map<string, string> | null = null;
  for (const id of wanted) {
    const { kind, ref } = parseScopeId(id);
    const fromSessions = byScope.get(id);
    if (kind === "channel" && ref) {
      const name = fromSessions ?? (channelsById ??= await loadChannels()).get(ref);
      if (name) names[id] = `#${name.replace(/^#/, "")}`;
    } else if (kind === "personal" && ref) {
      const name = (membersById ??= await loadMembers()).get(ref);
      if (name) names[id] = name;
    } else if (fromSessions) {
      names[id] = fromSessions;
    }
  }
  return names;
}

type Keychain = NonNullable<ApiCtx["deps"]["keychain"]>;

const keychainRoute =
  (handle: (ctx: ApiCtx, kc: Keychain, capability: CapabilityClaims) => Promise<void>) =>
  async (ctx: ApiCtx): Promise<void> => {
    const { res, deps, capability } = ctx;
    if (!deps.keychain)
      return sendJson(res, 503, {
        error: "keychain_unavailable",
        message: "The keychain isn't set up on this server. An operator needs to set CONNECTOR_SECRET_KEY.",
      });
    if (!capability)
      return sendJson(res, 401, {
        error: "unauthorized",
        message: "keychain routes require an agent capability token",
      });
    const kc = deps.keychain;
    return handle(ctx, kc, capability);
  };

const saveCredential = keychainRoute(async ({ res, deps, body }, kc, { actorId, scopeId }) => {
  const b = body as Record<string, unknown>;
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
  let files: CredentialFile[] | undefined;
  if (Array.isArray(b.files)) {
    files = [];
    for (const f of b.files as Array<{ path?: unknown; contentBase64?: unknown; mode?: unknown } | null>) {
      if (typeof f?.path !== "string" || typeof f.contentBase64 !== "string") continue;
      const mode = f.mode;
      if (mode !== undefined && (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777))
        return sendJson(res, 400, {
          error: "bad_request",
          message: `files[].mode must be an integer between 0 and 511 (octal 0o777); got ${JSON.stringify(mode)} for ${f.path}`,
        });
      files.push({ path: f.path, contentBase64: f.contentBase64, ...(typeof mode === "number" ? { mode } : {}) });
    }
  }
  let fields: CredentialFieldInput[] | undefined;
  if (b.fields !== undefined) {
    if (
      !Array.isArray(b.fields) ||
      b.fields.length === 0 ||
      b.fields.some(
        (f) =>
          typeof (f as CredentialFieldInput)?.envKey !== "string" ||
          typeof (f as CredentialFieldInput)?.value !== "string",
      )
    ) {
      return sendJson(res, 400, { error: "bad_request", message: "each field needs string envKey and value" });
    }
    fields = b.fields as CredentialFieldInput[];
  }
  if (typeof b.service !== "string" || (typeof b.secret !== "string" && !files?.length && !fields?.length)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "service plus secret, files[], or fields[] required",
    });
  }
  const meta = await kc.save({
    ownerId: actorId,
    service: b.service,
    ...(typeof b.secret === "string" ? { secret: b.secret } : {}),
    ...(files?.length ? { files } : {}),
    ...(fields?.length ? { fields } : {}),
    ...(typeof b.envKey === "string" ? { envKey: b.envKey } : {}),
    ...(typeof b.target === "string" ? { target: b.target } : {}),
    ...(typeof b.host === "string" ? { host: b.host } : {}),
    ...(typeof b.accountLabel === "string" ? { accountLabel: b.accountLabel } : {}),
    origin: typeof b.origin === "string" ? b.origin : `agent-session:${scopeId}`,
    ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
  });
  audit(deps, {
    principalId: actorId,
    action: "keychain.save",
    resource: `${meta.service}:${meta.id}`,
    scopeLabel: scopeId,
  });
  return sendJson(res, 200, { credential: meta });
});

const listCredentials = keychainRoute(async ({ res }, kc, { actorId }) => {
  return sendJson(res, 200, { credentials: await kc.listByOwner(actorId) });
});

const keychainOverview = keychainRoute(async ({ res, app, deps }, kc, { actorId }) => {
  const credentials = await kc.listByOwner(actorId);
  const connectorCredentials = (await kc.listConnectorsByOwners([actorId])).get(actorId) ?? [];
  const grants = await kc.listGrants({ ownerId: actorId });
  const asks = (await kc.listAsks({ ownerId: actorId })).filter((ask) => ask.status === "pending");
  const scopeNames = await resolveScopeNames(app, deps, [
    ...grants.map((grant) => grant.audienceScopeId),
    ...asks.map((ask) => ask.requesterScopeId),
  ]);
  return sendJson(res, 200, { credentials, connectorCredentials, grants, asks, scopeNames });
});

const removal = (action: string, remove: (kc: Keychain, actorId: string, id: string) => Promise<boolean>) =>
  keychainRoute(async ({ res, deps, params }, kc, { actorId, scopeId }) => {
    const id = params.id!;
    const ok = await remove(kc, actorId, id);
    if (ok) audit(deps, { principalId: actorId, action, resource: id, scopeLabel: scopeId });
    return ok ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "not_found" });
  });

const deleteCredential = removal("keychain.delete", (kc, actorId, id) => kc.remove(actorId, id));

const listGrants = keychainRoute(async ({ res }, kc, { actorId, scopeId }) => {
  const mine = await kc.listGrants({ ownerId: actorId });
  const here = await kc.listGrants({ audienceScopeId: scopeId });
  const byId = new Map([...mine, ...here].map((g) => [g.id, g]));
  return sendJson(res, 200, { grants: [...byId.values()] });
});

const revokeGrant = removal("keychain.revoke", (kc, actorId, id) => kc.revokeGrant(actorId, id));

const createAsk = keychainRoute(async (ctx, kc, capability) => {
  const { res, app, deps, body } = ctx;
  const actorId = capability.actorId;
  const b = body as { credential?: unknown; purpose?: unknown; requestedMode?: unknown; expiresAt?: unknown };
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) return sendJson(res, 400, { error: "bad_request", message: expiresAt.message });
  if (
    typeof b.credential !== "string" ||
    typeof b.purpose !== "string" ||
    (b.requestedMode !== undefined && b.requestedMode !== "once" && b.requestedMode !== "standing")
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'expected { credential, purpose, requestedMode?: "once"|"standing" }',
    });
  }
  const scope = parseScopeId(capability.scopeId);
  if (scope.kind !== "channel" && scope.kind !== "personal" && scope.kind !== "group") {
    return sendJson(res, 403, { error: "forbidden", message: "asks require a personal or shared conversation" });
  }
  const cred = await kc.getCredential(b.credential);
  if (!cred) return sendJson(res, 404, { error: "not_found", message: "unknown credential" });
  const requester = await app.directoryMember(actorId);
  if (
    !(await app.belongsToScope(actorId, capability.scopeId)) ||
    !(await app.belongsToScope(cred.ownerId, capability.scopeId)) ||
    (scope.kind !== "personal" &&
      (requester?.type !== "internal" || (await app.directoryMember(cred.ownerId))?.type !== "internal"))
  ) {
    return sendJson(res, 403, {
      error: "forbidden",
      message: "the requester and credential owner must have current access to this conversation",
    });
  }
  const context = (await app.listContexts(cred.ownerId)).find((c) => c.scopeId === capability.scopeId);
  const cronId = cronIdOf(capability.threadRef);
  const cron = cronId ? await app.getCron(cronId) : null;
  const dest = resolveCapabilityDestination(capability, undefined);
  const requesterDestination =
    (dest.ok && dest.destination) || (cron?.ownerScopeId === capability.scopeId ? cron.destination : undefined);
  const originRun = capability.runId ? await deps.runs?.get(capability.runId) : null;
  const run = originRun?.sessionId === capability.threadRef ? originRun : null;
  const requesterSeq = run?.turnUserSeq;
  const requesterMessageTs = run?.request.origin.kind === "human" ? run.request.origin.messageTs : undefined;
  const { ask, existing } = await kc.createAsk({
    ...(capability.triggered ? { triggered: true } : {}),
    credentialId: cred.id,
    requesterId: actorId,
    requesterScopeId: capability.scopeId,
    ...(requesterSeq != null ? { requesterSeq } : {}),
    ...(requesterMessageTs ? { requesterMessageTs } : {}),
    ...(requesterDestination ? { requesterDestination } : {}),
    ...(capability.threadRef ? { requesterThreadRef: capability.threadRef } : {}),
    purpose: b.purpose,
    ...(b.requestedMode !== undefined ? { requestedMode: b.requestedMode as GrantMode } : {}),
    ...(expiresAt.value !== undefined ? { expiresAt: expiresAt.value } : {}),
  });
  const notice = renderAskNotice({
    ask,
    credential: cred,
    ...(requester?.displayName ? { requesterName: requester.displayName } : {}),
    ...(scope.kind === "channel" && context?.name ? { channelName: context.name } : {}),
    ...(scope.kind === "group" && context?.name ? { scopeName: context.name } : {}),
    ...(cron?.ownerScopeId === capability.scopeId ? { taskTitle: cron.title ?? cron.id } : {}),
  });
  const cardDestination = approvalCardDestination(ask);
  if (cardDestination)
    await deps.outbound
      ?.send({ destination: cardDestination, text: notice, idempotencyKey: `ask:${ask.id}:notice` })
      .catch((error: unknown) => reportFailure("keychain: post credential request card", error, `ask=${ask.id}`));
  if (!existing) {
    audit(deps, {
      principalId: actorId,
      action: "keychain.ask",
      resource: `${ask.id} (${cred.service}:${cred.id}→${cred.ownerId})`,
      scopeLabel: capability.scopeId,
    });
  }
  return sendJson(res, 200, { ask, existing });
});

const listAsks = keychainRoute(async ({ res }, kc, { actorId, scopeId }) => {
  const all = await kc.listAsks({});
  const asks = all.filter(
    (a) => samePerson(a.requesterId, actorId) || samePerson(a.ownerId, actorId) || a.requesterScopeId === scopeId,
  );
  return sendJson(res, 200, { asks });
});

async function handleApproval(ctx: ApiCtx): Promise<void> {
  const { res, deps, body, params } = ctx;
  const b = (body ?? {}) as { principalId?: unknown; decision?: unknown };
  if (!deps.keychainApprovals || typeof b.principalId !== "string" || !b.principalId)
    return sendJson(res, 404, { error: "not_found" });
  if (b.decision !== "once" && b.decision !== "standing" && b.decision !== "deny")
    return sendJson(res, 400, {
      error: "bad_request",
      message: 'expected { principalId, decision: "once"|"standing"|"deny" }',
    });
  const { keychainApprovals } = deps;
  const decision = b.decision;
  const principalId = b.principalId;
  return sendJson(res, 200, await keychainApprovals.decide(params.id!, { externalId: principalId }, decision));
}

export const keychainRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/keychain/credentials", actor: "system", auth: "either", handle: saveCredential },
  { method: "GET", path: "/v1/keychain/credentials", auth: "either", handle: listCredentials },
  { method: "GET", path: "/v1/keychain/overview", auth: "either", handle: keychainOverview },
  { method: "DELETE", path: "/v1/keychain/credentials/:id", actor: "system", auth: "either", handle: deleteCredential },
  { method: "GET", path: "/v1/keychain/grants", auth: "either", handle: listGrants },
  { method: "POST", path: "/v1/keychain/grants/:id/revoke", actor: "system", auth: "either", handle: revokeGrant },
  { method: "POST", path: "/v1/keychain/asks", actor: "system", auth: "either", handle: createAsk },
  { method: "GET", path: "/v1/keychain/asks", auth: "either", handle: listAsks },
  {
    method: "POST",
    path: "/v1/keychain/approvals/:id",
    actor: "body.principalId",
    auth: "source",
    handle: handleApproval,
  },
];
