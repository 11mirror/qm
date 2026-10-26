import { el, metaChip } from "./dom.ts";
import { fmtPct, fmtTokens, stringify } from "./format.ts";

type Row = Record<string, any>;

export interface CacheUsage {
  cacheRead: number;
  cacheWrite: number;
  uncachedInput: number;
}

export interface ContextSection {
  key: string;
  label: string;
  note: string;
  text: string;
  tokens: number;
  chars: number;
}

const estimateTokens = (text: string) => (text.length ? Math.max(1, Math.round(text.length / 4)) : 0);

function blockText(o: any): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o !== "object") return String(o);
  if (Array.isArray(o)) return o.map(blockText).join("\n");
  if (typeof o.text === "string" && (o.type === "text" || o.type == null)) return o.text;
  if (o.type === "image") {
    const data = typeof o.source?.data === "string" && o.source.data ? " · " + o.source.data : "";
    return "[image " + (o.source?.media_type || "image") + data + "]";
  }
  if (o.type === "tool_use")
    return "[tool_use " + (o.name || "tool") + (o.id ? " · " + o.id : "") + "]\n" + stringify(o.input ?? {});
  if (o.type === "tool_result")
    return `[tool_result${o.tool_use_id ? " " + o.tool_use_id : ""}${o.is_error ? " · error" : ""}]\n${blockText(o.content)}`;
  if (o.type === "thinking") {
    const signature = typeof o.signature === "string" ? "\n[signature " + o.signature + "]" : "";
    return "[thinking]\n" + (typeof o.thinking === "string" ? o.thinking : "") + signature;
  }
  if (o.type === "redacted_thinking")
    return "[redacted_thinking" + (typeof o.data === "string" ? " " + o.data : "") + "]";
  if (o.type === "document") return "[document " + (o.title || o.name || "attachment") + "]";
  return stringify(o);
}

function messageEntryText(m: any) {
  const obj = m && typeof m === "object";
  const content = blockText(obj ? m.content : m);
  const name = obj && m.name ? " (" + m.name + ")" : "";
  return (
    "[" + String(obj ? m.role || "message" : "message") + name + "]\n" + (content.length ? content : "(no content)")
  );
}

function systemToText(system: unknown) {
  if (system == null) return { text: "", cacheSplit: false };
  if (typeof system === "string") return { text: system, cacheSplit: false };
  if (!Array.isArray(system)) return { text: stringify(system), cacheSplit: false };
  let out = "",
    cacheSplit = false;
  system.forEach((b, i) => {
    const t = b && typeof b === "object" && typeof b.text === "string" ? b.text : blockText(b);
    out += (i ? "\n" : "") + t;
    const cc = b && typeof b === "object" ? b.cache_control : null;
    if (!cc) return;
    const ttl = typeof cc === "object" && cc.ttl ? " " + cc.ttl : "";
    out += "\n\n────── cache breakpoint (" + (cc.type || "ephemeral") + ttl + ") ──────\n";
    cacheSplit = true;
  });
  return { text: out, cacheSplit };
}

function transportText(transport: Row | null | undefined) {
  if (!transport || typeof transport !== "object") return "";
  const lines = [];
  if (transport.modelId) lines.push("model: " + transport.modelId);
  const h = transport.headers;
  if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) lines.push(k + ": " + v);
  if (!lines.length) return "";
  return (
    lines.join("\n") +
    "\n\n(auth + anthropic-version headers are added by the provider SDK below the capture point, so they aren't shown)"
  );
}

export const requestBody = (q: Row | null | undefined) => (q && q.promptEnvelope != null ? q.promptEnvelope : null);

export function contextSections(request: unknown, transport?: Row | null): ContextSection[] {
  const req: Row = request && typeof request === "object" ? request : {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const params = Object.fromEntries(Object.entries(req).filter(([k]) => !["system", "messages", "tools"].includes(k)));
  const paramCount = Object.keys(params).length;
  const count = (n: number, word: string) => n + " " + word + (n === 1 ? "" : "s");
  const sys = systemToText(req.system);
  const messageNote = messages.length
    ? count(messages.length, "message")
    : "not re-captured per step; the transcript is the record";
  const sections: [string, string, string, string][] = [
    ["transport", "Transport", "model + headers", transportText(transport)],
    ["system", "System prompt", sys.cacheSplit ? "verbatim · cache split shown" : "verbatim", sys.text],
    ["messages", "Messages", messageNote, messages.map(messageEntryText).join("\n\n")],
    [
      "tools",
      "Tool schemas",
      Array.isArray(req.tools) ? count(req.tools.length, "tool") : "tools",
      req.tools == null ? "" : stringify(req.tools),
    ],
    ["params", "Request params", count(paramCount, "field"), paramCount ? stringify(params) : ""],
  ];
  return sections
    .filter(([, , , text]) => text)
    .map(([key, label, note, text]) => ({ key, label, note, text, tokens: estimateTokens(text), chars: text.length }));
}

function callCacheUsage(q: Row | null | undefined): CacheUsage | null {
  const u = q && q.usage;
  if (!u || typeof u !== "object") return null;
  return {
    cacheRead: Number(u.cacheRead) || 0,
    cacheWrite: Number(u.cacheWrite) || 0,
    uncachedInput: Number(u.input) || 0,
  };
}

export function sumCacheUsage(requests: Row[] | null | undefined): CacheUsage | null {
  const usages = (requests || []).map(callCacheUsage).filter((u): u is CacheUsage => !!u);
  const sum = (key: keyof CacheUsage) => usages.reduce((n, u) => n + u[key], 0);
  return usages.length
    ? { cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), uncachedInput: sum("uncachedInput") }
    : null;
}

const usageTotal = (u: CacheUsage) => u.cacheRead + u.cacheWrite + u.uncachedInput;

export function fmtContextSize(q: Row | null | undefined, sections: ContextSection[]) {
  const u = callCacheUsage(q);
  return u && usageTotal(u) > 0
    ? fmtTokens(usageTotal(u))
    : "~" + fmtTokens(sections.reduce((n, s) => n + s.tokens, 0));
}

const cacheHitRatio = (u: CacheUsage | null | undefined) =>
  u && usageTotal(u) > 0 ? u.cacheRead / usageTotal(u) : null;

export function isStablePrefixMiss(u: CacheUsage | null | undefined) {
  const ratio = cacheHitRatio(u);
  return ratio !== null && u!.cacheWrite >= 1024 && ratio < 0.1;
}

export function cacheMetaItems(u: CacheUsage | null | undefined) {
  if (!u) return [];
  const ratio = cacheHitRatio(u);
  const miss = isStablePrefixMiss(u);
  const out = [metaChip("cache " + (ratio === null ? "n/a" : fmtPct(ratio)), miss ? "danger" : "")];
  if (miss) out.push(metaChip("stable-prefix miss", "danger"));
  return out;
}

export function rawJsonLink(requests: Row[], label = "Raw JSON") {
  let payload: unknown = requests.map((q) => ({
    step: q.step,
    model: q.model,
    createdAt: q.createdAt,
    truncated: !!q.truncated,
    ...(q.transport ? { transport: q.transport } : {}),
    request: requestBody(q),
  }));
  if (requests.length === 1)
    payload = requests[0]?.transport
      ? { request: requestBody(requests[0]), transport: requests[0].transport }
      : requestBody(requests[0]);
  const a = el("a.context-raw", {
    href: "#",
    target: "_blank",
    rel: "noopener",
    textContent: label,
  }) as HTMLAnchorElement;
  let url: string | null = null;
  a.addEventListener("click", () => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    a.href = url;
  });
  return a;
}
