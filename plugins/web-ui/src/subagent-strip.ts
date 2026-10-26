import { reportHandledError } from "./browser-errors";
import type { ConvCtx } from "./conv-types";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { Bot, ChevronRight, TriangleAlert, Wrench } from "lucide";
import {
  fetchTranscript,
  fetchSessionApprovals,
  resolveApproval,
  unresolvedApprovals,
  type ApprovalDecision,
  type PendingApproval,
} from "./core-bridge";
import { workingWave } from "./ui";
import { icon } from "./icons";
import { refreshSessions, sessionsState, syncWorkingPulse } from "./sessions";
import { goalElapsedLabel } from "./goal-strip";
import {
  ackKey,
  peekLines,
  subagentRows,
  subagentSummary,
  visibleSubagents,
  type PeekLine,
  type SubagentRow,
} from "./subagent-activity";

export function createSubagentStrip({
  ctx,
  chatState,
  drawActiveChat,
  openSessionById,
  syncWorkTicker,
}: {
  ctx: ConvCtx;
  chatState: { readonly sessionId: string | null; readonly resolvingApprovals: Set<string> };
  drawActiveChat: () => void;
  openSessionById: (id: string) => Promise<unknown>;
  syncWorkTicker: () => void;
}) {
  const SUBAGENT_ACK_KEY = "qm.subagentAck";
  const subagentUi = {
    expanded: false,
    peekId: null as string | null,
    peek: null as PeekLine[] | null,
    ticking: false,
    timer: null as ReturnType<typeof setInterval> | null,
    approvals: new Map<string, PendingApproval[]>(),
    approvalsKey: "",
    acknowledged: new Set<string>(
      (() => {
        try {
          return JSON.parse(localStorage.getItem(SUBAGENT_ACK_KEY) ?? "[]") as string[];
        } catch {
          return [];
        }
      })(),
    ),
  };

  function stopSubagentPeek(): void {
    if (subagentUi.timer) clearInterval(subagentUi.timer);
    subagentUi.timer = null;
    subagentUi.peekId = null;
    subagentUi.peek = null;
  }

  async function refreshSubagentPeek(id: string): Promise<void> {
    const page = await fetchTranscript(id, { tailTurns: 1 }).catch((error: unknown) => {
      reportHandledError("web:subagent_peek", error);
      return null;
    });
    if (subagentUi.peekId !== id) return;
    subagentUi.peek = page ? peekLines(page.items) : [];
    drawActiveChat();
  }

  function toggleSubagentPeek(row: SubagentRow): void {
    const id = row.session.id;
    const same = subagentUi.peekId === id;
    stopSubagentPeek();
    if (same) return drawActiveChat();
    subagentUi.peekId = id;
    void refreshSubagentPeek(id);
    if (row.state === "working") subagentUi.timer = setInterval(() => void refreshSubagentPeek(id), 4000);
    drawActiveChat();
  }

  function acknowledgeSubagent(row: SubagentRow): void {
    subagentUi.acknowledged.add(ackKey(row));
    try {
      localStorage.setItem(SUBAGENT_ACK_KEY, JSON.stringify([...subagentUi.acknowledged].slice(-200)));
    } catch {
      return drawActiveChat();
    }
    if (subagentUi.peekId === row.session.id) stopSubagentPeek();
    drawActiveChat();
  }

  function syncSubagentApprovals(rows: readonly SubagentRow[]): void {
    const waiting = rows.filter((row) => row.state === "waiting").map((row) => row.session.id);
    const key = waiting.join(",");
    if (key === subagentUi.approvalsKey) return;
    subagentUi.approvalsKey = key;
    for (const id of subagentUi.approvals.keys()) if (!waiting.includes(id)) subagentUi.approvals.delete(id);
    for (const id of waiting)
      void fetchSessionApprovals(id).then((r) => {
        if (!subagentUi.approvalsKey.split(",").includes(id)) return;
        subagentUi.approvals.set(id, r?.approvals ?? []);
        drawActiveChat();
      });
  }

  function resolveSubagentApproval(childId: string, decision: ApprovalDecision): void {
    if (chatState.resolvingApprovals.has(decision.requestId)) return;
    chatState.resolvingApprovals.add(decision.requestId);
    ctx.composer.state.error = "";
    drawActiveChat();
    void resolveApproval(decision)
      .then(() => {
        subagentUi.approvals.set(
          childId,
          (subagentUi.approvals.get(childId) ?? []).filter((a) => a.requestId !== decision.requestId),
        );
      })
      .catch((err: unknown) => {
        ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
      })
      .finally(() => {
        chatState.resolvingApprovals.delete(decision.requestId);
        subagentUi.approvalsKey = "";
        void refreshSessions({ silent: true }).finally(() => drawActiveChat());
      });
  }

  function subagentRowTpl(row: SubagentRow): TemplateResult {
    const now = Date.now();
    const elapsed = goalElapsedLabel(row.startedAt, row.endedAt ?? now);
    const peeking = subagentUi.peekId === row.session.id;
    const approvals = unresolvedApprovals(subagentUi.approvals.get(row.session.id) ?? []);
    const title = row.session.title?.trim() || "Subagent";
    return html`<div
      class="subagent-row ${row.state} ${peeking ? "peeking" : ""}"
      style=${`--subagent-depth:${row.depth - 1}`}
    >
      <button
        type="button"
        class="subagent-row-head"
        aria-expanded=${String(peeking)}
        @click=${() => toggleSubagentPeek(row)}
      >
        ${row.state === "working" ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}
        ${row.state === "waiting" ? html`<span class="awaiting-dot" aria-hidden="true"></span>` : nothing}
        ${row.state === "failed" ? html`<span class="subagent-failed-mark">${icon(TriangleAlert, 12)}</span>` : nothing}
        <span class="subagent-row-title" dir="auto">${title}</span>
        <span class="subagent-row-meta">${row.state} · ${elapsed}</span>
      </button>
      ${
        row.state === "failed"
          ? html`<button type="button" class="subagent-row-action" @click=${() => acknowledgeSubagent(row)}>
              Dismiss
            </button>`
          : nothing
      }
      <button type="button" class="subagent-row-action" @click=${() => void openSessionById(row.session.id)}>
        Open
      </button>
      ${
        approvals.length
          ? ctx.composer.composerApprovalPanel(approvals, (decision) =>
              resolveSubagentApproval(row.session.id, decision),
            )
          : nothing
      }
      ${peeking ? subagentPeekTpl() : nothing}
    </div>`;
  }

  function subagentPeekTpl(): TemplateResult {
    const lines = subagentUi.peek;
    if (!lines) return html`<div class="subagent-peek bg-panel-note">Loading…</div>`;
    if (!lines.length) return html`<div class="subagent-peek bg-panel-note">No activity yet</div>`;
    return html`<ol class="subagent-peek" aria-live="polite">
      ${lines.map(
        (line) =>
          html`<li class="subagent-peek-line ${line.kind}">
            ${line.kind === "tool" ? icon(Wrench, 11) : nothing}<span dir="auto">${line.text}</span>
          </li>`,
      )}
    </ol>`;
  }

  function subagentStrip(): TemplateResult | typeof nothing {
    const rootId = chatState.sessionId;
    if (!rootId) return nothing;
    const rows = visibleSubagents(subagentRows(sessionsState.list, rootId), subagentUi.acknowledged);
    if (subagentUi.peekId && !rows.some((row) => row.session.id === subagentUi.peekId)) stopSubagentPeek();
    syncSubagentApprovals(rows);
    subagentUi.ticking = rows.some((row) => row.state === "working" || row.state === "waiting");
    syncWorkTicker();
    if (!rows.length) return nothing;
    const single = rows.length === 1;
    const expanded = single || subagentUi.expanded || rows.some((row) => row.state === "waiting");
    const failed = rows.some((row) => row.state === "failed");
    return html`
      <section class="bg-activity subagent-activity ${expanded ? "expanded" : ""} ${failed ? "has-failed" : ""}">
        ${
          single
            ? nothing
            : html`<button
                type="button"
                class="bg-activity-strip"
                aria-expanded=${String(expanded)}
                @click=${() => {
                  subagentUi.expanded = !subagentUi.expanded;
                  if (!subagentUi.expanded) stopSubagentPeek();
                  drawActiveChat();
                }}
              >
                ${icon(Bot, 13)}<span class="bg-activity-label">${subagentSummary(rows)}</span>
                <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
              </button>`
        }
        ${expanded ? html`<div class="subagent-list ${single ? "single" : "bg-panel"}">${rows.map(subagentRowTpl)}</div>` : nothing}
      </section>
    `;
  }
  return { subagentStrip, subagentsTicking: () => subagentUi.ticking };
}
