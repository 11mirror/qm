import type { App } from "../../app.ts";
import { sendJson } from "../../http.ts";
import { badRequest, limitParam, notFound, orgAdmin } from "./common.ts";
import { type ApiCtx } from "../route.ts";
import { mentionedUserIds } from "../../../slack/mrkdwn.ts";

const SLACK_MIRROR_PAGE_MAX = 400;
const SLACK_MIRROR_PAGE_DEFAULT = 200;

async function mirrorNames(deps: ApiCtx["deps"]) {
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

export async function listSlackMirrorContainers(ctx: ApiCtx): Promise<void> {
  const { res, app } = ctx;
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { scope } = authz;
  authz.audit("slack_mirror.read", "slack-mirror");
  const raw = await app.listSurfaceContainers({ limit: SLACK_MIRROR_PAGE_MAX + 1 });
  const hasMore = raw.length > SLACK_MIRROR_PAGE_MAX;
  const channelsById = new Map((await app.directoryChannels()).map((c) => [c.channelId.toLowerCase(), c.name]));
  const containers = (hasMore ? raw.slice(0, SLACK_MIRROR_PAGE_MAX) : raw).map((c) => ({
    ...c,
    name: c.name ?? channelsById.get(c.container.toLowerCase()),
  }));
  return sendJson(res, 200, { scopeId: scope, containers, hasMore, limit: SLACK_MIRROR_PAGE_MAX });
}

export async function listSlackMirrorMessages(ctx: ApiCtx): Promise<void> {
  const { res, app, deps, url } = ctx;
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { scope } = authz;
  const container = (url.searchParams.get("container") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!container && !q) return badRequest(res, "container or q required");
  const limit = limitParam(url, SLACK_MIRROR_PAGE_DEFAULT, SLACK_MIRROR_PAGE_MAX);
  authz.audit("slack_mirror.messages.read", container || `search:${q}`);
  const names = await mirrorNames(deps);
  const withNames = (rows: Awaited<ReturnType<App["readSurfaceMessages"]>>) =>
    rows.map((m) => ({
      ...m,
      authorName: m.authorName ?? names.author(m.authorId),
      mentions: names.mentions(m.text, m.mentions),
    }));
  if (q) {
    const found = await app.searchSurface(q, { ...(container ? { container } : {}), limit: limit + 1 });
    const truncated = found.length > limit;
    const messages = withNames(truncated ? found.slice(0, limit) : found);
    return sendJson(res, 200, { scopeId: scope, mode: "search", query: q, messages, hasMore: truncated, limit });
  }
  const before = url.searchParams.get("before") ?? undefined;
  const raw = await app.readSurfaceMessages(container, {
    limit: limit + 1,
    includeDeleted: true,
    noFallback: true,
    ...(before ? { before } : {}),
  });
  const hasMore = raw.length > limit;
  const messages = withNames(hasMore ? raw.slice(raw.length - limit) : raw);
  return sendJson(res, 200, { scopeId: scope, mode: "timeline", container, messages, hasMore, limit });
}

interface DecisionLog {
  get(id: number): Promise<object | null>;
  list(opts: { limit: number }): Promise<object[]>;
  counts(opts?: { container?: string; channel?: string }): Promise<object>;
}

async function listDecisionLog(
  ctx: ApiCtx,
  store: DecisionLog | undefined,
  log: {
    action: string;
    filter: string;
    param: string;
    values: readonly string[];
    one: string;
    many: string;
    empty: object;
  },
): Promise<void> {
  const { res, deps, url } = ctx;
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { scope } = authz;
  if (!store) return sendJson(res, 200, { scopeId: scope, [log.many]: [], counts: log.empty });
  const container = (url.searchParams.get("container") ?? "").trim() || undefined;
  const id = Number(url.searchParams.get("id"));
  authz.audit(`${log.action}.read`, container ?? "all");
  if (id) {
    const row = await store.get(id);
    if (!row) return notFound(res);
    const workspaceUrl = deps.directory ? (await deps.directory.meta()).workspaceUrl : null;
    return sendJson(res, 200, { scopeId: scope, [log.one]: row, workspaceUrl });
  }
  const values = (url.searchParams.get(log.param) ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => log.values.includes(d));
  const before = Math.floor(Number(url.searchParams.get("before"))) || undefined;
  const beforeId = Math.floor(Number(url.searchParams.get("beforeId"))) || undefined;
  const limit = limitParam(url, 100, 200);
  const where = container ? { [log.filter]: container } : {};
  const [rows, counts] = await Promise.all([
    store.list({
      ...where,
      ...(values.length ? { [log.param]: values } : {}),
      ...(before ? { before } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    }),
    store.counts(where),
  ]);
  const hasMore = rows.length > limit;
  return sendJson(res, 200, {
    scopeId: scope,
    [log.many]: hasMore ? rows.slice(0, limit) : rows,
    counts,
    hasMore,
    limit,
  });
}

export const listAmbientJudgments = (ctx: ApiCtx): Promise<void> =>
  listDecisionLog(ctx, ctx.deps.ambientJudgments, {
    action: "ambient_judgments",
    filter: "container",
    param: "decision",
    values: ["act", "ignore", "fastlane"],
    one: "judgment",
    many: "judgments",
    empty: { act: 0, ignore: 0, fastlane: 0 },
  });

export const listAckEmojiPicks = (ctx: ApiCtx): Promise<void> =>
  listDecisionLog(ctx, ctx.deps.ackEmojiPicks, {
    action: "ack_emoji_picks",
    filter: "channel",
    param: "outcome",
    values: ["picked", "declined"],
    one: "pick",
    many: "picks",
    empty: { picked: 0, declined: 0 },
  });
