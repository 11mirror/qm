import { itemFields, type Item } from "../items.ts";
import { copyButton, el, metaChip } from "./dom.ts";
import { fmtBytes, fmtMs, fmtTime, stringify, titleCase } from "./format.ts";

type Row = Record<string, any>;

export function toolName(callPayload: Row, resultPayload: Row) {
  return String(callPayload.tool || resultPayload.tool || callPayload.name || resultPayload.name || "tool");
}

export function toolLabelText(tool: string, callPayload: Row, resultPayload: Row) {
  if (tool === "background") {
    const action = callPayload.action || resultPayload.action;
    return action ? `background ${action}` : "background";
  }
  return tool;
}

export function toolStatusMeta(tool: string, resultPayload: Row, hasResult: boolean) {
  if (!hasResult) return [metaChip("pending result")];
  if (resultPayload.blocked === "needs_approval") return [metaChip("approval needed", "danger")];
  if (resultPayload.denied === true) return [metaChip("denied", "danger")];
  if (resultPayload.error || resultPayload.isError === true) return [metaChip("error", "danger")];
  const out = [];
  if (tool === "execute" && typeof resultPayload.code === "number") {
    out.push(metaChip("exit " + resultPayload.code, resultPayload.code === 0 ? "" : "danger"));
    if (resultPayload.timedOut) out.push(metaChip("timed out", "danger"));
  } else if (resultPayload.status) {
    const status =
      typeof resultPayload.status === "object" && resultPayload.status !== null
        ? resultPayload.status.state || resultPayload.status.status || stringify(resultPayload.status)
        : resultPayload.status;
    out.push(metaChip(titleCase(String(status)), status === "error" || status === "failed" ? "danger" : ""));
  } else if (typeof resultPayload.found === "boolean") {
    out.push(metaChip(resultPayload.found ? "found" : "missing", resultPayload.found ? "" : "danger"));
  }
  if (typeof resultPayload.bytes === "number") out.push(metaChip(fmtBytes(resultPayload.bytes)));
  if (typeof resultPayload.count === "number")
    out.push(metaChip(resultPayload.count + " result" + (resultPayload.count === 1 ? "" : "s")));
  return out;
}

function toolTextValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(toolTextValue).filter(Boolean).join("\n");
  if (typeof v === "object") return stringify(v);
  return String(v);
}

export function toolPrimaryText(callPayload: Row, resultPayload: Row, hasCall: boolean, hasResult: boolean) {
  if (hasCall) {
    for (const key of ["command", "path", "query", "url", "name", "id"]) {
      const text = toolTextValue(callPayload[key]);
      if (text) return text;
    }
  }
  if (hasResult) {
    for (const key of ["stdout", "stderr", "text", "output", "chunks", "result", "error", "reason"]) {
      const text = toolTextValue(resultPayload[key]);
      if (text) return text;
    }
  }
  return toolTextValue(hasResult ? resultPayload : callPayload);
}

export function toolCopyText(...items: (Item | null | undefined)[]) {
  return items
    .filter((item): item is Item => !!item)
    .map((item) => `${item.kind} #${item.seq} · ${fmtTime(item.createdAt)}\n${stringify(itemFields(item))}`)
    .join("\n\n");
}

export function renderToolEntry(
  callEntry: Item | null,
  resultEntry: Item | null,
  contextBtn: Node | null = null,
  timingEl: Node | null = null,
) {
  const callPayload: Row = callEntry ? itemFields(callEntry) : {};
  const resultPayload: Row = resultEntry ? itemFields(resultEntry) : {};
  const tool = toolName(callPayload, resultPayload);
  const block = el("div.entry tool-entry");
  const who = el("div.who");
  if (contextBtn) who.appendChild(contextBtn);
  who.append(el("span.tool-label", toolLabelText(tool, callPayload, resultPayload)));
  if (timingEl) who.appendChild(timingEl);
  who.append(
    el(
      "span.when",
      resultEntry
        ? `#${callEntry?.seq ?? "?"}→#${resultEntry.seq} · ${fmtTime(callEntry?.createdAt ?? resultEntry.createdAt)}`
        : `#${callEntry?.seq ?? "?"} · ${fmtTime(callEntry?.createdAt ?? NaN)}`,
    ),
    el("div.meta-row", {}, ...toolStatusMeta(tool, resultPayload, !!resultEntry)),
    copyButton("Copy", () => toolCopyText(callEntry, resultEntry)),
  );
  const body = el("div.tool-body");
  const primaryText = toolPrimaryText(callPayload, resultPayload, !!callEntry, !!resultEntry);
  if (primaryText) {
    const truncated = primaryText.length > 1800;
    const preview = truncated ? primaryText.slice(0, 1800) + "…" : primaryText;
    const card = el("pre.tool-command", { textContent: preview, tabIndex: 0, role: "button" });
    const syncExpanded = () => {
      const expanded = block.classList.contains("expanded");
      card.setAttribute("aria-expanded", String(expanded));
      card.title = expanded ? "Click to collapse tool text" : "Click to expand tool text";
      if (truncated) card.textContent = expanded ? primaryText : preview;
    };
    const toggle = () => {
      block.classList.toggle("expanded");
      syncExpanded();
    };
    card.onclick = toggle;
    card.onkeydown = (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      toggle();
    };
    syncExpanded();
    body.appendChild(card);
  }
  block.append(who, body);
  return { block, sync: () => {} };
}

function durSeg(ms: number, label?: string) {
  let cls = "";
  if (ms >= 30000) cls = "dur-hot";
  else if (ms >= 5000) cls = "dur-warm";
  const span = el("span." + cls, fmtMs(ms));
  if (!label) return span;
  const wrap = document.createDocumentFragment();
  wrap.append(el("span.seg-label", label + " "), span);
  return wrap;
}

export function stepDurEl(segs: (number | string | null | undefined)[][] | null | undefined) {
  const parts = (segs || []).filter((seg): seg is [number, string?] => typeof seg[0] === "number" && seg[0] >= 0);
  if (!parts.length) return null;
  const node = el("span.step-dur");
  parts.forEach(([ms, label], i) => node.append(...(i ? [" · "] : []), durSeg(ms, label)));
  return node;
}
