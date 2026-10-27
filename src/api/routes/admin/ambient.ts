import type { DecisionLogStore } from "../../../surface-cache/decision-log-store.ts";
import { badRequest, limitParam, notFound, orgAdmin } from "./common.ts";
import { type ApiCtx, ok, type RouteResult } from "../route.ts";
import { mentionedUserIds } from "../../../slack/mrkdwn.ts";

const CONTEXT_PAGE_MAX = 400;
const CONTEXT_PAGE_DEFAULT = 200;

async function directoryNames(deps: ApiCtx["deps"]) {
  const members = deps.directory ? await deps.directory.list() : [];
  const byId = new Map<string, string>();
  for (const m of members) {
    if (!m.displayName) continue;
    byId.set(m.principalId, m.displayName);
    if (m.slackId) byId.set(m.slackId, m.displayName);
  }
  return {
    author: (id?: string): string | undefined => (id ? byId.get(id) : undefined),
    mentions(text?: string, existing?: Record<string, string>): Record<string, string> | undefined {
      const out: Record<string, string> = { ...existing };
      for (const id of mentionedUserIds(text ?? "")) {
        if (out[id]) continue;
        const name = byId.get(id);
        if (name) out[id] = name;
      }
      return Object.keys(out).length ? out : existing;
    },
  };
}

export async function listAmbientContainers(ctx: ApiCtx): Promise<RouteResult> {
  const { app } = ctx;
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  authz.audit("ambient_context.read", "ambient-context");
  const raw = await app.listSurfaceContainers({ limit: CONTEXT_PAGE_MAX + 1 });
  const hasMore = raw.length > CONTEXT_PAGE_MAX;
  const channelsById = new Map((await app.directoryChannels()).map((c) => [c.channelId.toLowerCase(), c.name]));
  const containers = (hasMore ? raw.slice(0, CONTEXT_PAGE_MAX) : raw).map((c) => ({
    ...c,
    name: c.name ?? channelsById.get(c.container.toLowerCase()),
  }));
  return ok({ scopeId: scope, containers, hasMore, limit: CONTEXT_PAGE_MAX });
}

export async function listAmbientMessages(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps, url } = ctx;
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  const container = (url.searchParams.get("container") ?? "").trim();
  if (!container) throw badRequest("container required");
  const limit = limitParam(url, CONTEXT_PAGE_DEFAULT, CONTEXT_PAGE_MAX);
  authz.audit("ambient_context.messages.read", container);
  const names = await directoryNames(deps);
  const before = url.searchParams.get("before") ?? undefined;
  const raw = await app.readSurfaceMessages(container, {
    limit: limit + 1,
    includeDeleted: true,
    noFallback: true,
    ...(before ? { before } : {}),
  });
  const hasMore = raw.length > limit;
  const messages = (hasMore ? raw.slice(raw.length - limit) : raw).map((m) => ({
    ...m,
    authorName: m.authorName ?? names.author(m.authorId),
    mentions: names.mentions(m.text, m.mentions),
  }));
  return ok({ scopeId: scope, container, messages, hasMore, limit });
}

async function listDecisionLog<Outcome extends string>(
  ctx: ApiCtx,
  store: DecisionLogStore<object, Outcome, object> | undefined,
  log: {
    action: string;
    param: string;
    values: readonly Outcome[];
    one: string;
    many: string;
    empty: object;
  },
): Promise<RouteResult> {
  const { deps, url } = ctx;
  const authz = await orgAdmin(ctx);
  const { scope } = authz;
  if (!store) return ok({ scopeId: scope, [log.many]: [], counts: log.empty });
  const container = (url.searchParams.get("container") ?? "").trim() || undefined;
  const id = Number(url.searchParams.get("id"));
  authz.audit(`${log.action}.read`, container ?? "all");
  if (id) {
    const row = await store.get(id);
    if (!row) throw notFound();
    const workspaceUrl = deps.directory ? (await deps.directory.meta()).workspaceUrl : null;
    return ok({ scopeId: scope, [log.one]: row, workspaceUrl });
  }
  const values = (url.searchParams.get(log.param) ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d): d is Outcome => (log.values as readonly string[]).includes(d));
  const before = Math.floor(Number(url.searchParams.get("before"))) || undefined;
  const beforeId = Math.floor(Number(url.searchParams.get("beforeId"))) || undefined;
  const limit = limitParam(url, 100, 200);
  const where = container ? { scope: container } : {};
  const [rows, counts] = await Promise.all([
    store.list({
      ...where,
      ...(values.length ? { outcomes: values } : {}),
      ...(before ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    }),
    store.counts(where),
  ]);
  const hasMore = rows.length > limit;
  return ok({
    scopeId: scope,
    [log.many]: hasMore ? rows.slice(0, limit) : rows,
    counts,
    hasMore,
    limit,
  });
}

export const listAmbientJudgments = (ctx: ApiCtx): Promise<RouteResult> =>
  listDecisionLog(ctx, ctx.deps.ambientJudgments, {
    action: "ambient_judgments",
    param: "decision",
    values: ["act", "ignore", "fastlane"],
    one: "judgment",
    many: "judgments",
    empty: { act: 0, ignore: 0, fastlane: 0 },
  });

export const listAckEmojiPicks = (ctx: ApiCtx): Promise<RouteResult> =>
  listDecisionLog(ctx, ctx.deps.ackEmojiPicks, {
    action: "ack_emoji_picks",
    param: "outcome",
    values: ["picked", "declined"],
    one: "pick",
    many: "picks",
    empty: { picked: 0, declined: 0 },
  });
