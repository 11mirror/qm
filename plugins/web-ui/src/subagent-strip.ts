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

const SUBAGENT_ACK_KEY = "qm.subagentAck";

interface SubagentStripDeps {
  ctx: ConvCtx;
  chatState: { readonly sessionId: string | null; readonly resolvingApprovals: Set<string> };
  drawActiveChat: () => void;
  openSessionById: (id: string) => Promise<unknown>;
  syncWorkTicker: () => void;
}

class SubagentStrip {
  private readonly subagentUi = {
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
  private readonly deps: SubagentStripDeps;

  constructor(deps: SubagentStripDeps) {
    this.deps = deps;
  }

  private readonly stopSubagentPeek = (): void => {
    if (this.subagentUi.timer) clearInterval(this.subagentUi.timer);
    this.subagentUi.timer = null;
    this.subagentUi.peekId = null;
    this.subagentUi.peek = null;
  };

  private readonly refreshSubagentPeek = async (id: string): Promise<void> => {
    const page = await fetchTranscript(id, { tailTurns: 1 }).catch((error: unknown) => {
      reportHandledError("web:subagent_peek", error);
      return null;
    });
    if (this.subagentUi.peekId !== id) return;
    this.subagentUi.peek = page ? peekLines(page.items) : [];
    this.deps.drawActiveChat();
  };

  private readonly toggleSubagentPeek = (row: SubagentRow): void => {
    const id = row.session.id;
    const same = this.subagentUi.peekId === id;
    this.stopSubagentPeek();
    if (same) return this.deps.drawActiveChat();
    this.subagentUi.peekId = id;
    void this.refreshSubagentPeek(id);
    if (row.state === "working") this.subagentUi.timer = setInterval(() => void this.refreshSubagentPeek(id), 4000);
    this.deps.drawActiveChat();
  };

  private readonly acknowledgeSubagent = (row: SubagentRow): void => {
    this.subagentUi.acknowledged.add(ackKey(row));
    try {
      localStorage.setItem(SUBAGENT_ACK_KEY, JSON.stringify([...this.subagentUi.acknowledged].slice(-200)));
    } catch {
      return this.deps.drawActiveChat();
    }
    if (this.subagentUi.peekId === row.session.id) this.stopSubagentPeek();
    this.deps.drawActiveChat();
  };

  private readonly syncSubagentApprovals = (rows: readonly SubagentRow[]): void => {
    const waiting = rows.filter((row) => row.state === "waiting").map((row) => row.session.id);
    const key = waiting.join(",");
    if (key === this.subagentUi.approvalsKey) return;
    this.subagentUi.approvalsKey = key;
    for (const id of this.subagentUi.approvals.keys()) if (!waiting.includes(id)) this.subagentUi.approvals.delete(id);
    for (const id of waiting)
      void fetchSessionApprovals(id).then((r) => {
        if (!this.subagentUi.approvalsKey.split(",").includes(id)) return;
        this.subagentUi.approvals.set(id, r?.approvals ?? []);
        this.deps.drawActiveChat();
      });
  };

  private readonly resolveSubagentApproval = (childId: string, decision: ApprovalDecision): void => {
    if (this.deps.chatState.resolvingApprovals.has(decision.requestId)) return;
    this.deps.chatState.resolvingApprovals.add(decision.requestId);
    this.deps.ctx.composer.state.error = "";
    this.deps.drawActiveChat();
    void resolveApproval(decision)
      .then(() => {
        this.subagentUi.approvals.set(
          childId,
          (this.subagentUi.approvals.get(childId) ?? []).filter((a) => a.requestId !== decision.requestId),
        );
      })
      .catch((err: unknown) => {
        this.deps.ctx.composer.state.error = err instanceof Error ? err.message : "Could not send the approval.";
      })
      .finally(() => {
        this.deps.chatState.resolvingApprovals.delete(decision.requestId);
        this.subagentUi.approvalsKey = "";
        void refreshSessions({ silent: true }).finally(() => this.deps.drawActiveChat());
      });
  };

  private readonly subagentRowTpl = (row: SubagentRow): TemplateResult => {
    const now = Date.now();
    const elapsed = goalElapsedLabel(row.startedAt, row.endedAt ?? now);
    const peeking = this.subagentUi.peekId === row.session.id;
    const approvals = unresolvedApprovals(this.subagentUi.approvals.get(row.session.id) ?? []);
    const title = row.session.title?.trim() || "Subagent";
    return html`<div
      class="subagent-row ${row.state} ${peeking ? "peeking" : ""}"
      style=${`--subagent-depth:${row.depth - 1}`}
    >
      <button
        type="button"
        class="subagent-row-head"
        aria-expanded=${String(peeking)}
        @click=${() => this.toggleSubagentPeek(row)}
      >
        ${row.state === "working" ? html`<span class="working-mark" ${ref(syncWorkingPulse)}>${workingWave()}</span>` : nothing}
        ${row.state === "waiting" ? html`<span class="awaiting-dot" aria-hidden="true"></span>` : nothing}
        ${row.state === "failed" ? html`<span class="subagent-failed-mark">${icon(TriangleAlert, 12)}</span>` : nothing}
        <span class="subagent-row-title" dir="auto">${title}</span>
        <span class="subagent-row-meta">${row.state} · ${elapsed}</span>
      </button>
      ${
        row.state === "failed"
          ? html`<button type="button" class="subagent-row-action" @click=${() => this.acknowledgeSubagent(row)}>
              Dismiss
            </button>`
          : nothing
      }
      <button type="button" class="subagent-row-action" @click=${() => void this.deps.openSessionById(row.session.id)}>
        Open
      </button>
      ${
        approvals.length
          ? this.deps.ctx.composer.composerApprovalPanel(approvals, (decision) =>
              this.resolveSubagentApproval(row.session.id, decision),
            )
          : nothing
      }
      ${peeking ? this.subagentPeekTpl() : nothing}
    </div>`;
  };

  private readonly subagentPeekTpl = (): TemplateResult => {
    const lines = this.subagentUi.peek;
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
  };

  readonly subagentStrip = (): TemplateResult | typeof nothing => {
    const rootId = this.deps.chatState.sessionId;
    if (!rootId) return nothing;
    const rows = visibleSubagents(subagentRows(sessionsState.list, rootId), this.subagentUi.acknowledged);
    if (this.subagentUi.peekId && !rows.some((row) => row.session.id === this.subagentUi.peekId))
      this.stopSubagentPeek();
    this.syncSubagentApprovals(rows);
    this.subagentUi.ticking = rows.some((row) => row.state === "working" || row.state === "waiting");
    this.deps.syncWorkTicker();
    if (!rows.length) return nothing;
    const single = rows.length === 1;
    const expanded = single || this.subagentUi.expanded || rows.some((row) => row.state === "waiting");
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
                  this.subagentUi.expanded = !this.subagentUi.expanded;
                  if (!this.subagentUi.expanded) this.stopSubagentPeek();
                  this.deps.drawActiveChat();
                }}
              >
                ${icon(Bot, 13)}<span class="bg-activity-label">${subagentSummary(rows)}</span>
                <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
              </button>`
        }
        ${expanded ? html`<div class="subagent-list ${single ? "single" : "bg-panel"}">${rows.map(this.subagentRowTpl)}</div>` : nothing}
      </section>
    `;
  };

  readonly subagentsTicking = () => this.subagentUi.ticking;
}

export function createSubagentStrip(deps: SubagentStripDeps) {
  return new SubagentStrip(deps);
}
