type Row = Record<string, any>;

export const pick = <T>(map: Record<string, T>, key: unknown, fallback: T): T =>
  Object.hasOwn(map, String(key)) ? map[String(key)]! : fallback;

export const fmtTime = (ts: number | string | Date) => new Date(ts).toLocaleString();

const sameLocalDate = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtClock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function relTime(ts: number | string | null | undefined) {
  if (!ts) return "Never";
  const d = new Date(ts);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins >= 0 && mins < 1) return "now";
  if (mins >= 0 && mins < 60) return mins + (mins === 1 ? " min" : " mins");
  if (sameLocalDate(d, now)) return "Today " + fmtClock(d);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameLocalDate(d, yesterday)) return "Yesterday " + fmtClock(d);
  const date = d.toLocaleDateString(
    [],
    d.getFullYear() === now.getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
  return date + ", " + fmtClock(d);
}

export const fmtMs = (n: number | null | undefined) => {
  if (n == null) return "n/a";
  return n >= 1000 ? (n / 1000).toFixed(2) + " s" : Math.round(n) + " ms";
};

export const fmtPct = (n: number | null | undefined) => ((n || 0) * 100).toFixed(1) + "%";

export function fmtBytes(n: number) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

export function fmtTokens(n: number | null | undefined) {
  if (!n) return "0 tokens";
  if (n < 20) return "< 20 tokens";
  if (n < 1000) return n.toLocaleString() + " tokens";
  if (n < 1000000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k tokens";
  return (n / 1000000).toFixed(1) + "m tokens";
}

export function plural(n: unknown, one: string, many = one + "s") {
  return `${Number(n || 0).toLocaleString()} ${Number(n || 0) === 1 ? one : many}`;
}

export const shortId = (id: unknown, len = 8) => String(id || "").slice(0, len) || "-";

export const titleCase = (s: unknown) =>
  String(s || "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());

export const labelRole = (role: unknown) => (role === "org_admin" ? "admin" : String(role || "").replace(/_/g, " "));

export const scopeKind = (scopeId: unknown) => String(scopeId || "").split(":")[0] || "scope";

export function stringify(x: unknown) {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

export function firstLine(text: unknown, max = 120) {
  const lines = String(text || "").split("\n");
  const line = lines.find((x) => x.trim()) || lines[0] || "";
  const compact = line.trim().replace(/\s+/g, " ");
  return compact.length > max ? compact.slice(0, Math.max(0, max - 3)) + "..." : compact;
}

export function fileKind(path: unknown) {
  const name = String(path || "");
  return name.includes(".") ? "." + name.split(".").pop()!.toLowerCase() : "file";
}

export function fileName(path: unknown) {
  return (
    String(path || "")
      .split("/")
      .filter(Boolean)
      .pop() || "download"
  );
}

export function uploadErrorMessage(text: string, fallback: string) {
  try {
    const parsed = JSON.parse(text);
    return parsed.message || parsed.error || fallback;
  } catch {
    return text.trim() || fallback;
  }
}

export function cronName(c: Row | null | undefined, previewAction = false) {
  if (!c) return "Cron";
  if (c.title || c.message) return c.title || c.message;
  if (previewAction && c.action) return firstLine(c.action, 96);
  return "Cron " + shortId(c.id);
}

export const wakeOriginLabel = (trigger: unknown) =>
  pick(
    { cron: "Cron", monitor: "Monitor wake", webhook: "Webhook wake" },
    String(trigger || "").toLowerCase(),
    "Background wake",
  );

export const destinationSummary = (dest: Row | null | undefined) =>
  dest ? (dest.type || "destination") + " -> " + (dest.target || "-") : "None";

export const destinationDetails = (dest: Row | null | undefined) =>
  [dest?.audienceScopeId, dest?.onBehalfOf && "on behalf of " + dest.onBehalfOf].filter(Boolean).join(" / ");

export function packRepoLabel(url: string | null | undefined) {
  return (
    (url || "")
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join("/") ||
    url ||
    ""
  );
}

export function createdByCell(s: Row) {
  if (s.pack) return { text: packRepoLabel(s.pack.url) || "pack " + shortId(s.pack.id, 8), cls: "mono" };
  if (s.createdBy && s.createdBy.indexOf("system:") === 0) return { text: "built-in", cls: "subline" };
  return { text: s.createdBy || "None", cls: "mono" };
}

export function egressDetail(r: Row) {
  const bits = [];
  if (r.source === "broker") {
    if (r.slug) bits.push("cred:" + r.slug);
    if (r.upstreamStatus != null) bits.push("↑" + r.upstreamStatus);
  } else {
    if (r.via) bits.push(r.via);
    if (r.port != null) bits.push(":" + r.port);
    if (r.peerIp) bits.push(r.peerIp);
  }
  return bits.join(" · ") || "None";
}

export type HistoryKind = "conversation" | "cron" | "background";
export const KIND_LABEL: Record<HistoryKind, string> = {
  conversation: "Conversations",
  cron: "Cron runs",
  background: "Background",
};
export const historyCategory = (kind: string) => (kind === "cron" || kind === "background" ? "background" : kind);
export const historyModeLabel = (kind: string) => pick(KIND_LABEL, kind, KIND_LABEL.conversation);
export function historyKindMatches(s: Row, kind: string) {
  if (kind === "conversation") return s.category !== "background";
  if (kind === "cron") return s.origin?.kind === "cron";
  if (kind === "background") return s.category === "background" && s.origin?.kind !== "cron";
  return true;
}
