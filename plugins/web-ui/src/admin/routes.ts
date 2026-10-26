import { ADMIN_VIEWS, SCOPED_VIEWS } from "./sections.ts";
import { scopeKind } from "./format.ts";
import { spendWindow } from "./spend.ts";

export const DEFAULT_VIEW = "history";

const QUERY_KEYS = [
  "principal",
  "cron",
  "own",
  "mem",
  "range",
  "from",
  "to",
  "cursor",
  "container",
  "ts",
  "decision",
  "jid",
] as const;

export type AdminState = {
  view: string;
  scope: string;
  session?: string | null;
  turn?: string | number | null;
  historyKind?: string;
  page?: number;
  setup?: string | null;
  slack?: string | null;
  deepLink?: boolean;
} & Partial<Record<(typeof QUERY_KEYS)[number], string | null>>;

export function stateToUrl(st: AdminState, base: string) {
  const p = new URLSearchParams();
  const withQuery = (path: string) => {
    const q = p.toString();
    return q ? path + "?" + q : path;
  };
  if ((st.view || DEFAULT_VIEW) === "history") {
    if (st.session) {
      if (st.turn != null) p.set("turn", String(st.turn));
      return withQuery(base + "/history/s/" + encodeURIComponent(st.session));
    }
    const scopeSegment = st.scope && scopeKind(st.scope) !== "org" ? encodeURIComponent(st.scope) : null;
    const scopeInPath = scopeSegment && !/%2F|%5C/i.test(scopeSegment);
    if (scopeSegment && !scopeInPath) p.set("scope", st.scope);
    if (st.own) p.set("own", st.own);
    if (st.cron) p.set("cron", st.cron);
    if (st.historyKind && st.historyKind !== "conversation") p.set("kind", st.historyKind);
    if (st.cursor) p.set("cursor", st.cursor);
    return withQuery(scopeInPath ? base + "/history/scopes/" + scopeSegment : base + "/history");
  }
  const slackSetup = ["connectors", "slack-settings"].includes(st.view);
  if (slackSetup && st.setup === "slack") p.set("setup", "slack");
  if (slackSetup && ["setup", "install", "connected"].includes(st.slack ?? "")) p.set("slack", st.slack!);
  if (st.scope && SCOPED_VIEWS.has(st.view)) p.set("scope", st.scope);
  if (st.view === "errors" && st.page && st.page > 1) p.set("page", String(st.page));
  if (st.principal) p.set("principal", st.principal);
  if (st.view === "crons" && st.cron) p.set("cron", st.cron);
  if (st.own && SCOPED_VIEWS.has(st.view)) p.set("own", st.own);
  if (st.view === "memory" && st.mem) p.set("mem", st.mem);
  const window = st.view === "spend" ? spendWindow(st) : null;
  if (window && window.preset === null) {
    p.set("from", window.from);
    p.set("to", window.to);
  } else if (window && st.range) p.set("range", window.preset!);
  const logKeys = ["container", "decision", "jid"] as const;
  const extra = { slack: st.container ? (["container", "ts"] as const) : [], judgments: logKeys, ackemoji: logKeys }[
    st.view
  ];
  for (const key of extra || []) if (st[key]) p.set(key, st[key]!);
  return withQuery(st.view === "general" ? base : base + "/" + encodeURIComponent(st.view || DEFAULT_VIEW));
}

function decodePathSegment(seg: string | undefined) {
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

export function urlToState(base: string, orgId: string, currentScope: string): AdminState {
  const p = new URLSearchParams(location.search);
  const rel = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname;
  const segs = rel.replace(/^\/+/, "").split("/");
  const fromPath = decodePathSegment(segs[0]);
  let pathSession = null;
  let pathScope = null;
  if (fromPath === "history") {
    if (segs[1] === "s") pathSession = decodePathSegment(segs[2]);
    else if (segs[1] === "scopes") pathScope = decodePathSegment(segs[2]);
  }
  const slackStep = ["setup", "install", "connected"].includes(p.get("slack") ?? "");
  const raw = p.get("setup") === "slack" || slackStep ? "slack-settings" : p.get("view") || fromPath;
  const session = pathSession || p.get("session") || null;
  const kindRaw = p.get("kind") ?? "";
  const turnRaw = p.get("turn");
  let view = DEFAULT_VIEW;
  if (raw && ADMIN_VIEWS.has(raw)) view = raw;
  else if (session) view = "history";
  else if (!raw) view = "general";
  return {
    view,
    setup: p.get("setup"),
    slack: p.get("slack"),
    scope: pathScope || p.get("scope") || (view === "history" || view === "errors" ? "org:" + orgId : currentScope),
    session,
    turn: turnRaw == null || turnRaw === "" ? null : turnRaw,
    historyKind: ["conversation", "cron", "background"].includes(kindRaw) ? kindRaw : "conversation",
    page: Math.max(1, parseInt(p.get("page") ?? "", 10) || 1),
    ...Object.fromEntries(QUERY_KEYS.map((key) => [key, p.get(key) || null])),
  };
}
