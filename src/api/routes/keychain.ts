import { connectorHostLabel } from "../../connectors/oauth.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";
import {
  renderAskNotice,
  credentialHandle,
  connectorHandle,
  type CredentialFieldInput,
  type CredentialFile,
  type GrantMode,
} from "../../credentials/keychain.ts";
import { parseScopeId } from "../../types.ts";
import { samePerson } from "../../directory/person.ts";
import { approvalCardDestination } from "../../credentials/keychain-approval.ts";
import { fail } from "../http.ts";
import { normalizeInboundExpiresAt } from "../expiry.ts";
import { type ApiCtx, ok, reply, type Route, type RouteResult } from "./route.ts";
import type { CapabilityClaims } from "../../auth/capability-token.ts";
import { audit, resolveCapabilityDestination } from "./shared.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import { cronIdOf } from "../../sessions/thread-ref.ts";
import { bareChannelName } from "../../util/text.ts";

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
      if (name) names[id] = `#${bareChannelName(name)}`;
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
  (handle: (ctx: ApiCtx, kc: Keychain, capability: CapabilityClaims) => Promise<RouteResult>) =>
  async (ctx: ApiCtx): Promise<RouteResult> => {
    const { deps, capability } = ctx;
    if (!deps.keychain)
      throw fail(
        503,
        "keychain_unavailable",
        "The keychain isn't set up on this server. An operator needs to set CONNECTOR_SECRET_KEY.",
      );
    if (!capability) throw fail(401, "unauthorized", "keychain routes require an agent capability token");
    const kc = deps.keychain;
    return handle(ctx, kc, capability);
  };

const saveCredential = keychainRoute(async ({ deps, body }, kc, { actorId, scopeId }) => {
  const b = body as Record<string, unknown>;
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) throw fail(400, "bad_request", expiresAt.message);
  let files: CredentialFile[] | undefined;
  if (Array.isArray(b.files)) {
    files = [];
    for (const f of b.files as Array<{ path?: unknown; contentBase64?: unknown; mode?: unknown } | null>) {
      if (typeof f?.path !== "string" || typeof f.contentBase64 !== "string") continue;
      const mode = f.mode;
      if (mode !== undefined && (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777))
        throw fail(
          400,
          "bad_request",
          `files[].mode must be an integer between 0 and 511 (octal 0o777); got ${JSON.stringify(mode)} for ${f.path}`,
        );
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
    )
      throw fail(400, "bad_request", "each field needs string envKey and value");
    fields = b.fields as CredentialFieldInput[];
  }
  if (typeof b.service !== "string" || (typeof b.secret !== "string" && !files?.length && !fields?.length))
    throw fail(400, "bad_request", "service plus secret, files[], or fields[] required");
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
  return ok({ credential: meta });
});

const listCredentials = keychainRoute(async (_ctx, kc, { actorId }) => {
  return ok({ credentials: await kc.listByOwner(actorId) });
});

const keychainOverview = keychainRoute(async ({ app, deps }, kc, { actorId }) => {
  const credentials = await kc.listByOwner(actorId);
  const connectorCredentials = (await kc.listConnectorsByOwners([actorId])).get(actorId) ?? [];
  const grants = await kc.listGrants({ ownerId: actorId });
  const asks = (await kc.listAsks({ ownerId: actorId })).filter((ask) => ask.status === "pending");
  const scopeNames = await resolveScopeNames(app, deps, [
    ...grants.map((grant) => grant.audienceScopeId),
    ...asks.map((ask) => ask.requesterScopeId),
  ]);
  return ok({ credentials, connectorCredentials, grants, asks, scopeNames });
});

const removal = (action: string, remove: (kc: Keychain, actorId: string, id: string) => Promise<boolean>) =>
  keychainRoute(async ({ deps, params }, kc, { actorId, scopeId }) => {
    const id = params.id!;
    const removed = await remove(kc, actorId, id);
    if (removed) audit(deps, { principalId: actorId, action, resource: id, scopeLabel: scopeId });
    return removed ? ok({ ok: true }) : reply(404, { error: "not_found" });
  });

const deleteCredential = removal("keychain.delete", (kc, actorId, id) => kc.remove(actorId, id));

const listGrants = keychainRoute(async (_ctx, kc, { actorId, scopeId }) => {
  const mine = await kc.listGrants({ ownerId: actorId });
  const here = await kc.listGrants({ audienceScopeId: scopeId });
  const byId = new Map([...mine, ...here].map((g) => [g.id, g]));
  return ok({ grants: [...byId.values()] });
});

const revokeGrant = removal("keychain.revoke", (kc, actorId, id) => kc.revokeGrant(actorId, id));

type KeychainStore = NonNullable<ApiCtx["deps"]["keychain"]>;

async function askableCredentials(
  kc: KeychainStore,
  ownerId: string,
): Promise<Array<{ credential: string; service: string; account?: string; handle: string }>> {
  const [entries, connectors] = await Promise.all([kc.listByOwners([ownerId]), kc.listConnectorsByOwners([ownerId])]);
  return [
    ...(entries.get(ownerId) ?? []).map((c) => ({
      credential: c.id,
      service: c.service,
      ...(c.accountLabel ? { account: c.accountLabel } : {}),
      handle: credentialHandle(c),
    })),
    ...(connectors.get(ownerId) ?? []).map((c) => ({
      credential: c.credentialId,
      service: connectorHostLabel(c.host),
      ...(c.accountType ? { account: c.accountType } : {}),
      handle: connectorHandle(c.host, c.accountType),
    })),
  ];
}

async function resolveAskTarget(
  ctx: ApiCtx,
  kc: KeychainStore,
  scopeId: string,
  owner: string,
  service: string,
): Promise<{ credentialId: string } | { status: number; body: Record<string, unknown> }> {
  const found = await ctx.app.resolveRecipient(owner);
  let people: DirectoryMember[] = [];
  if (found.kind === "one") people = [found.member];
  else if (found.kind === "ambiguous") people = found.candidates;
  const inScope = await Promise.all(people.map((person) => ctx.app.belongsToScope(person.principalId, scopeId)));
  const present = people.filter((_, i) => inScope[i]);
  if (present.length !== 1)
    return {
      status: present.length ? 409 : 404,
      body: {
        error: present.length ? "ambiguous_owner" : "unknown_owner",
        message: present.length
          ? "More than one person in this conversation matches that owner; retry with one principalId."
          : "No one in this conversation matches that owner.",
        ...(present.length
          ? { owners: present.map((p) => ({ principalId: p.principalId, name: p.displayName })) }
          : {}),
      },
    };
  const candidates = await askableCredentials(kc, present[0]!.principalId);
  const wanted = service.trim().toLowerCase();
  const matches = candidates.filter((c) => [c.service, c.handle].some((name) => name.toLowerCase() === wanted));
  if (matches.length === 1) return { credentialId: matches[0]!.credential };
  return {
    status: matches.length ? 409 : 404,
    body: {
      error: matches.length ? "ambiguous_credential" : "unknown_credential",
      message: matches.length
        ? "Several of their credentials match; retry with the chosen candidate's credential id."
        : "None of their credentials matches that service; pick one of the candidates.",
      candidates: matches.length ? matches : candidates,
    },
  };
}

const createAsk = keychainRoute(async (ctx, kc, capability) => {
  const { app, deps, body } = ctx;
  const actorId = capability.actorId;
  const b = body as {
    credential?: unknown;
    owner?: unknown;
    service?: unknown;
    purpose?: unknown;
    requestedMode?: unknown;
    expiresAt?: unknown;
  };
  const expiresAt = normalizeInboundExpiresAt(b.expiresAt);
  if (!expiresAt.ok) throw fail(400, "bad_request", expiresAt.message);
  const named = typeof b.owner === "string" && typeof b.service === "string";
  if (
    (typeof b.credential !== "string" && !named) ||
    typeof b.purpose !== "string" ||
    (b.requestedMode !== undefined && b.requestedMode !== "once" && b.requestedMode !== "standing")
  )
    throw fail(
      400,
      "bad_request",
      'expected { owner, service, purpose, requestedMode?: "once"|"standing" } or { credential, purpose, … }',
    );
  const scope = parseScopeId(capability.scopeId);
  if (scope.kind !== "channel" && scope.kind !== "personal" && scope.kind !== "group")
    throw fail(403, "forbidden", "asks require a personal or shared conversation");
  const requester = await app.directoryMember(actorId);
  if (
    !(await app.belongsToScope(actorId, capability.scopeId)) ||
    (scope.kind !== "personal" && requester?.type !== "internal")
  )
    throw fail(403, "forbidden", "the requester and credential owner must have current access to this conversation");
  let credentialId = typeof b.credential === "string" ? b.credential : undefined;
  if (credentialId === undefined) {
    const target = await resolveAskTarget(ctx, kc, capability.scopeId, b.owner as string, b.service as string);
    if ("status" in target) return reply(target.status, target.body);
    credentialId = target.credentialId;
  }
  const cred = await kc.getCredential(credentialId);
  if (!cred) throw fail(404, "not_found", "unknown credential");
  if (
    !(await app.belongsToScope(cred.ownerId, capability.scopeId)) ||
    (scope.kind !== "personal" && (await app.directoryMember(cred.ownerId))?.type !== "internal")
  )
    throw fail(403, "forbidden", "the requester and credential owner must have current access to this conversation");
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
  return ok({ ask, existing });
});

const listAsks = keychainRoute(async (_ctx, kc, { actorId, scopeId }) => {
  const all = await kc.listAsks({});
  const asks = all.filter(
    (a) => samePerson(a.requesterId, actorId) || samePerson(a.ownerId, actorId) || a.requesterScopeId === scopeId,
  );
  return ok({ asks });
});

async function handleApproval(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, body, params } = ctx;
  const b = (body ?? {}) as { principalId?: unknown; decision?: unknown };
  if (!deps.keychainApprovals || typeof b.principalId !== "string" || !b.principalId)
    return reply(404, { error: "not_found" });
  if (b.decision !== "once" && b.decision !== "standing" && b.decision !== "deny")
    return reply(400, {
      error: "bad_request",
      message: 'expected { principalId, decision: "once"|"standing"|"deny" }',
    });
  const { keychainApprovals } = deps;
  const decision = b.decision;
  const principalId = b.principalId;
  return ok(await keychainApprovals.decide(params.id!, { externalId: principalId }, decision));
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
