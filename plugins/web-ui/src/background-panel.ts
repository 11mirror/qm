import { html, nothing, type TemplateResult } from "lit";
import { Activity, ChevronRight, Clock3, Radar, SquareTerminal as Terminal } from "lucide";
import { api, type SessionBackgroundOutput, type SessionBackgroundView } from "./core-bridge";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { errMessage, swallow } from "../../chassis/src/errors";
import { relTime } from "./ui";
import { icon } from "./icons";
import { refreshSessions, sessionsState } from "./sessions";
import { backgroundLabel, conversationBackground, cronRowMeta, watchActivityLabel } from "./session-list";
import { tip } from "./tooltip";

type JobOutput = { text: string; cursor: number; state: "running" | "exited"; exitCode?: number };

interface BackgroundPanelDeps {
  chatState: { readonly sessionId: string | null; readonly threadRef: string | null };
  redrawTranscript: () => void;
}

class BackgroundPanel {
  private readonly bgPanel = {
    requested: null as { sessionId: string | null; threadRef: string | null } | null,
    open: false,
    loading: false,
    error: "",
    detail: null as SessionBackgroundView | null,
    openJob: null as string | null,
    output: new Map<string, JobOutput>(),
    timer: null as ReturnType<typeof setInterval> | null,
    fetchSeq: 0,
    epoch: 0,
  };
  private readonly chatState: BackgroundPanelDeps["chatState"];
  private readonly redrawTranscript: () => void;

  constructor({ chatState, redrawTranscript }: BackgroundPanelDeps) {
    this.chatState = chatState;
    this.redrawTranscript = redrawTranscript;
  }

  readonly requestBackgroundPanel = (sessionId: string | null, threadRef: string | null): void => {
    const mounted = sessionId ? sessionId === this.chatState.sessionId : threadRef === this.chatState.threadRef;
    if (mounted) {
      this.openBackgroundPanel();
      return;
    }
    this.bgPanel.requested = { sessionId, threadRef };
  };

  readonly resetBackgroundPanel = (): void => {
    this.stopBackgroundPanel();
    Object.assign(this.bgPanel, { loading: false, error: "", detail: null });
    this.bgPanel.output.clear();
    this.bgPanel.fetchSeq++;
    this.bgPanel.epoch++;
  };

  readonly consumeBackgroundPanelRequest = (): void => {
    const req = this.bgPanel.requested;
    this.bgPanel.requested = null;
    if (!req) return;
    const matches = req.sessionId
      ? req.sessionId === this.chatState.sessionId
      : req.threadRef === this.chatState.threadRef;
    if (matches) this.openBackgroundPanel();
  };

  private readonly openBackgroundPanel = (): void => {
    if (this.bgPanel.open) return;
    this.bgPanel.open = true;
    void this.refreshBackgroundDetail();
    this.bgPanel.timer = setInterval(() => void this.backgroundPanelTick(), 2_500);
    this.redrawTranscript();
  };

  private readonly stopBackgroundPanel = (): void => {
    if (this.bgPanel.timer) clearInterval(this.bgPanel.timer);
    Object.assign(this.bgPanel, { timer: null, open: false, openJob: null });
  };

  private readonly toggleBackgroundPanel = (): void => {
    if (!this.bgPanel.open) return this.openBackgroundPanel();
    this.stopBackgroundPanel();
    this.redrawTranscript();
  };

  private readonly refreshBackgroundDetail = async (): Promise<void> => {
    const id = this.chatState.sessionId;
    if (!id) {
      this.bgPanel.detail = { jobs: [], watches: [], crons: [] };
      return;
    }
    const seq = ++this.bgPanel.fetchSeq;
    this.bgPanel.loading = !this.bgPanel.detail;
    try {
      const d = await api<SessionBackgroundView>(`/api/sessions/${encodeURIComponent(id)}/background`);
      if (seq !== this.bgPanel.fetchSeq) return;
      this.bgPanel.detail = d;
      this.bgPanel.error = "";
    } catch (e) {
      if (seq !== this.bgPanel.fetchSeq) return;
      this.bgPanel.error = errMessage(e, "Failed to load background activity.");
    } finally {
      if (seq === this.bgPanel.fetchSeq) {
        this.bgPanel.loading = false;
        this.redrawTranscript();
      }
    }
  };

  private readonly backgroundPanelTick = async (): Promise<void> => {
    await this.refreshBackgroundDetail();
    if (this.bgPanel.openJob) await this.pollJobOutput(this.bgPanel.openJob);
    const d = this.bgPanel.detail;
    if (d) {
      const row = sessionsState.list.find((r) =>
        this.chatState.sessionId ? r.id === this.chatState.sessionId : r.threadRef === this.chatState.threadRef,
      );
      if (
        row &&
        ((row.backgroundJobs ?? 0) !== d.jobs.length ||
          (row.watches ?? 0) !== d.watches.length ||
          (row.crons ?? 0) !== d.crons.length)
      ) {
        await refreshSessions({ silent: true });
        this.redrawTranscript();
      }
    }
  };

  private readonly toggleJobOutput = (processId: string): void => {
    this.bgPanel.openJob = this.bgPanel.openJob === processId ? null : processId;
    if (this.bgPanel.openJob && !this.bgPanel.output.has(processId)) void this.pollJobOutput(processId);
    this.redrawTranscript();
  };

  private readonly pollJobOutput = async (processId: string): Promise<void> => {
    const id = this.chatState.sessionId;
    if (!id) return;
    const epoch = this.bgPanel.epoch;
    const out: JobOutput = { text: "", cursor: 0, state: "running", ...this.bgPanel.output.get(processId) };
    try {
      for (let i = 0; i < 8; i++) {
        const read = await api<SessionBackgroundOutput>(
          `/api/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(processId)}/output?sinceCursor=${out.cursor}`,
        );
        const text = (out.text + read.chunk).slice(-16_384);
        Object.assign(out, { text, cursor: read.cursor, state: read.state, exitCode: read.exitCode });
        if (read.chunk.length < 60_000) break;
      }
      if (epoch !== this.bgPanel.epoch) return;
      this.bgPanel.output.set(processId, out);
    } catch (e) {
      swallow("web-ui: background job output read", e);
    }
    if (epoch !== this.bgPanel.epoch) return;
    this.redrawTranscript();
  };

  private readonly timeLeft = (expiresAt: number): string => {
    const mins = Math.round((expiresAt - Date.now()) / 60_000);
    if (mins <= 0) return "expiring";
    if (mins < 60) return `${mins}m left`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m left`;
  };

  readonly backgroundActivityStrip = (): TemplateResult | typeof nothing => {
    const counts = conversationBackground(sessionsState.list, this.chatState.sessionId, this.chatState.threadRef);
    const row = counts ? backgroundLabel(counts.jobs, counts.watches, counts.crons) : null;
    const live =
      this.bgPanel.open && this.bgPanel.detail
        ? backgroundLabel(
            this.bgPanel.detail.jobs.length,
            this.bgPanel.detail.watches.length,
            this.bgPanel.detail.crons.length,
          )
        : null;
    const label = (live ?? row)?.label;
    if (!label && !this.bgPanel.open) return nothing;
    return html`
      <section class="bg-activity ${this.bgPanel.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(this.bgPanel.open)}
          @click=${this.toggleBackgroundPanel}
        >
          ${icon(Activity, 13)}<span class="bg-activity-label">${label ?? "Background activity"}</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${this.bgPanel.open ? this.backgroundPanelBody() : nothing}
      </section>
    `;
  };

  private readonly backgroundPanelBody = (): TemplateResult => {
    const d = this.bgPanel.detail;
    const empty = d && d.jobs.length === 0 && d.watches.length === 0 && d.crons.length === 0;
    return html`<div class="bg-panel" role="region" aria-label="Background activity">
      ${this.bgPanel.error ? html`<div class="bg-panel-note">${this.bgPanel.error}</div>` : nothing}
      ${!d && this.bgPanel.loading ? html`<div class="bg-panel-note">Loading…</div>` : nothing}
      ${empty && !this.bgPanel.error ? html`<div class="bg-panel-note">Nothing running here anymore.</div>` : nothing}
      ${d ? d.jobs.map((j) => this.backgroundJobRow(j)) : nothing}
      ${d ? d.watches.map((w) => this.backgroundWatchRow(w)) : nothing}
      ${d ? d.crons.map((c) => this.backgroundCronRow(c)) : nothing}
    </div>`;
  };

  private readonly backgroundJobRow = (j: SessionBackgroundView["jobs"][number]): TemplateResult => {
    const open = this.bgPanel.openJob === j.processId;
    const out = this.bgPanel.output.get(j.processId);
    const status =
      out?.state === "exited"
        ? `exited${out.exitCode !== undefined ? ` (${out.exitCode})` : ""}`
        : this.timeLeft(j.expiresAt);
    return html`
      <div class="bg-row ${open ? "open" : ""}">
        <button
          type="button"
          class="bg-row-head"
          aria-expanded=${String(open)}
          ${tip(open ? "Hide output" : "Show live output")}
          @click=${() => this.toggleJobOutput(j.processId)}
        >
          ${icon(Terminal, 13)}
          ${
            j.purpose
              ? html`<span class="bg-row-cmd bg-job-purpose">${j.purpose}</span>`
              : html`<code class="bg-row-cmd">${j.command}</code>`
          }
          <span class="bg-row-meta">started ${relTime(j.startedAt)} · ${status}</span>
          <span class="bg-row-toggle">${icon(ChevronRight, 13)}</span>
        </button>
        ${open ? html`<pre class="bg-row-output">${j.purpose ? `${j.command}\n\n` : ""}${out ? out.text || "(no output yet)" : "Loading output…"}</pre>` : nothing}
      </div>
    `;
  };

  private readonly backgroundCronRow = (c: SessionBackgroundView["crons"][number]): TemplateResult => {
    return html`
      <div class="bg-row watch">
        <a class="bg-row-head" href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}>
          ${icon(Clock3, 13)}
          <span class="bg-row-cmd">Cron: <bdi>${c.title ?? "scheduled task"}</bdi></span>
          <span class="bg-row-meta">${cronRowMeta(c)}</span>
        </a>
      </div>
    `;
  };

  private readonly backgroundWatchRow = (w: SessionBackgroundView["watches"][number]): TemplateResult => {
    const what = w.pattern ? `output matching /${w.pattern}/` : "any new output";
    const note = w.instructions?.trim();
    return html`
      <div class="bg-row watch">
        <div class="bg-row-head static">
          ${icon(Radar, 13)}
          <span class="bg-row-cmd">Watch: wakes on ${what}${note ? ` · “${note}”` : ""}</span>
          <span class="bg-row-meta"
            >armed ${relTime(w.createdAt)} · ${watchActivityLabel(w)} · ${this.timeLeft(w.expiresAt)}</span
          >
        </div>
      </div>
    `;
  };
}

export function createBackgroundPanel(deps: BackgroundPanelDeps) {
  const w = new BackgroundPanel(deps);
  return {
    requestBackgroundPanel: w.requestBackgroundPanel,
    resetBackgroundPanel: w.resetBackgroundPanel,
    consumeBackgroundPanelRequest: w.consumeBackgroundPanelRequest,
    backgroundActivityStrip: w.backgroundActivityStrip,
  };
}
