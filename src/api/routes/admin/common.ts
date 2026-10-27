import type { App } from "../../app.ts";
import type { ServerDeps } from "../../deps.ts";
import { parseScopeId, scopeId as makeScopeId, type Principal } from "../../../types.ts";
import { fail, type HttpError } from "../../http.ts";
import { audit, authorizeAdmin, requireScopedAdmin } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { tenant } from "../../../tenant.ts";
import { ALL_PROVIDERS_AVAILABLE, type ModelProviderAvailability } from "../../../model/pi-models.ts";

export interface AdminAuthz {
  actor: Principal;
  scope: string;
  orgWide: boolean;
  audit: (action: string, resource: string, scopeLabel?: string) => void;
}

export const auditAs = (deps: ServerDeps, principalId: string, action: string, resource: string, scopeLabel: string) =>
  audit(deps, { principalId, action, resource, scopeLabel });

function authorized(ctx: ApiCtx, actor: Principal, scope: string, read?: string): AdminAuthz {
  const authz: AdminAuthz = {
    actor,
    scope,
    orgWide: parseScopeId(scope).kind === "org",
    audit: (action, resource, scopeLabel = scope) => auditAs(ctx.deps, actor.id, action, resource, scopeLabel),
  };
  if (read) authz.audit(`${read}.read`, read);
  return authz;
}

export async function adminAt(ctx: ApiCtx, scope: string, read?: string): Promise<AdminAuthz | null> {
  const actor = await authorizeAdmin(ctx, scope);
  return actor && authorized(ctx, actor, scope, read);
}

export const orgAdmin = (ctx: ApiCtx, read?: string): Promise<AdminAuthz | null> =>
  adminAt(ctx, tenant().orgScope, read);

export async function scopedAdmin(ctx: ApiCtx, read?: string): Promise<AdminAuthz | null> {
  const authz = await requireScopedAdmin(ctx);
  return authz && authorized(ctx, authz.actor, authz.scope, read);
}

export const badRequest = (message: string): HttpError => fail(400, "bad_request", message);

export const notFound = (): HttpError => fail(404, "not_found");

export const limitParam = (url: URL, fallback: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(Number(url.searchParams.get("limit"))) || fallback));

export const CRON_SUMMARY_FIELDS = [
  "id",
  "ownerScopeId",
  "title",
  "action",
  "message",
  "owner",
  "enabled",
  "archived",
  "schedule",
] as const;

export const ADMIN_CRON_FIELDS = [...CRON_SUMMARY_FIELDS, "createdBy", "createdAt", "lastFiredAt"] as const;

export const pick = <T, K extends keyof T>(record: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((key) => [key, record[key]])) as Pick<T, K>;

export async function modelKeys(
  deps: Pick<ServerDeps, "providerKeys" | "modelCredentials">,
): Promise<ModelProviderAvailability> {
  return deps.modelCredentials ? deps.modelCredentials.availability() : (deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE);
}

type StringKey<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];

export async function requireScopedResource<T, K extends StringKey<T>>(
  ctx: ApiCtx,
  load: () => Promise<T | null | undefined> | T | null | undefined,
  scopeKey: K,
  noun: string,
  scopeMismatch: "forbid" | "fallback" = "forbid",
): Promise<(AdminAuthz & { record: T }) | null> {
  const authz = await scopedAdmin(ctx);
  if (!authz) return null;
  const record = await load();
  if (!record) {
    throw notFound();
  }
  const recordScope = record[scopeKey] as string;
  if (authz.orgWide || recordScope === authz.scope) return { ...authz, record };
  if (scopeMismatch === "forbid") {
    throw fail(403, "forbidden", `${noun} is outside the requested scope`);
  }
  return { ...authorized(ctx, authz.actor, recordScope), record };
}

export async function discoverScopes(
  app: App,
  deps: ServerDeps,
  extraScopeIds: Iterable<string> = [],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>([[tenant().orgScope, "org-wide"]]);
  const [scopes, participants, grants] = await Promise.all([
    deps.sessions?.distinctScopes() ?? [],
    deps.sessions?.distinctParticipants() ?? [],
    deps.admin?.listGrants() ?? [],
  ]);
  for (const s of scopes) {
    if (!labels.has(s.scopeId) || (s.channelName && !labels.get(s.scopeId))) {
      labels.set(s.scopeId, s.channelName ? `#${s.channelName}` : "");
    }
  }
  const people = [...participants, ...grants.map((g) => g.principalId)];
  for (const principalId of people) {
    const personal = makeScopeId("personal", principalId);
    if (!labels.has(personal)) labels.set(personal, "");
  }
  for (const id of extraScopeIds) {
    if (!labels.has(id)) labels.set(id, "");
  }
  if ([...labels.values()].some((l) => !l)) {
    const [members, channels] = await Promise.all([app.directoryMembers(), app.directoryChannels()]);
    const membersById = new Map(members.map((m) => [m.principalId, m.displayName]));
    const channelsById = new Map(channels.map((c) => [c.channelId, c.name]));
    for (const [id, label] of labels) {
      if (label) continue;
      const { kind, ref } = parseScopeId(id);
      if (kind === "personal" && ref) {
        labels.set(id, membersById.get(ref) ?? "");
      } else if (kind === "channel" && ref) {
        const name = channelsById.get(ref);
        if (name) labels.set(id, `#${name}`);
      }
    }
  }
  return labels;
}
