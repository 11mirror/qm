import { firstLine, TOOL_META, toolDetail, UNKNOWN_TOOL } from "./tool-rows";
import { MessageSquare, RefreshCw, type IconNode } from "lucide";
import type { WorkBlock } from "./core-bridge";
import {
  buildTimeline,
  rowArgs,
  rowTool,
  toolBody,
  currentTextPhase,
  postSpeechText,
  toolCategory,
  toolRowKind,
  type TimelineItem,
  type ToolRowModel,
} from "./timeline";
import { activityItems } from "./items";
import { workSeconds, workedLabel } from "./work-duration";

export function liveWorkSummary(work: WorkBlock): { icon: IconNode; label: string; detail: string } | null {
  if (work.stale) {
    const active = activeToolRow(work);
    const call = toolBody(active?.call);
    const tool = active?.call?.tool ?? "";
    const verb = active ? (TOOL_META[toolCategory(active.call?.tool ?? null, call)] ?? UNKNOWN_TOOL).active : null;
    return {
      icon: RefreshCw,
      label: verb ? `${verb} interrupted, resuming…` : "Interrupted, resuming…",
      detail: active ? toolDetail(tool, call, toolBody(active.result)) : "",
    };
  }
  const active = activeToolRow(work);
  return active ? activeToolSummary(active, work) : null;
}

function activeToolRow(work: WorkBlock): ToolRowModel | null {
  const timeline = buildTimeline(work);
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i]!;
    if (item.kind === "tool" && toolRowKind(item.row, work.status) === "running") return item.row;
  }
  return null;
}

function activeToolSummary(row: ToolRowModel, work: WorkBlock): { icon: IconNode; label: string; detail: string } {
  const call = toolBody(row.call);
  const result = toolBody(row.result);
  const tool = rowTool(row) ?? "unknown";
  const meta = TOOL_META[toolCategory(rowTool(row), rowArgs(row))] ?? UNKNOWN_TOOL;
  const secs = elapsedSeconds(row.call?.createdAt) || workSeconds(work);
  const posting = postSpeechText(row, true);
  if (posting) {
    return {
      icon: MessageSquare,
      label: workedLabel("Posting message", secs),
      detail: firstLine(posting, 60),
    };
  }
  return {
    icon: meta.icon,
    label: workedLabel(meta.active, secs),
    detail: toolDetail(tool, call, result),
  };
}

function elapsedSeconds(startedAt: number | null | undefined): number {
  if (typeof startedAt !== "number" || startedAt <= 0) return 0;
  return Math.max(0, (Date.now() - startedAt) / 1000);
}

export function usedToolsSuffix(work: WorkBlock): string {
  const n = activityItems(work.activity).filter((item) => item.kind === "ToolCall").length;
  return n > 0 ? ` (used ${n} tool${n === 1 ? "" : "s"})` : "";
}

export function workLabel(work: WorkBlock): string {
  if (work.stale && (work.status === "thinking" || work.status === "working")) return "Interrupted, resuming…";
  if (currentTextPhase(work)?.phase === "final_answer") return workedLabel("Worked", workSeconds(work));
  if (work.status === "thinking") return "Thinking";
  const secs = workSeconds(work);
  return workedLabel(work.status === "working" ? "Working" : "Worked", secs);
}

export function timelineKey(item: TimelineItem): string {
  if (item.kind === "tool") return `tool:${item.row.call?.seq ?? item.row.result?.seq ?? item.row.approval?.seq}`;
  if (item.kind === "approval") return `approval:${item.approval.requestId}`;
  if (item.kind === "thinking") return `thinking:${item.step ?? item.seq}`;
  return `${item.kind}:${item.item.seq}`;
}
