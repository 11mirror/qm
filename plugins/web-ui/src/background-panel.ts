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

export function createBackgroundPanel({
  chatState,
  redrawTranscript,
}: {
  chatState: { readonly sessionId: string | null; readonly threadRef: string | null };
  redrawTranscript: () => void;
}) {
  const bgPanel = {
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

  function requestBackgroundPanel(sessionId: string | null, threadRef: string | null): void {
    const mounted = sessionId ? sessionId === chatState.sessionId : threadRef === chatState.threadRef;
    if (mounted) {
      openBackgroundPanel();
      return;
    }
    bgPanel.requested = { sessionId, threadRef };
  }

  function resetBackgroundPanel(): void {
    stopBackgroundPanel();
    Object.assign(bgPanel, { loading: false, error: "", detail: null });
    bgPanel.output.clear();
    bgPanel.fetchSeq++;
    bgPanel.epoch++;
  }

  function consumeBackgroundPanelRequest(): void {
    const req = bgPanel.requested;
    bgPanel.requested = null;
    if (!req) return;
    const matches = req.sessionId ? req.sessionId === chatState.sessionId : req.threadRef === chatState.threadRef;
    if (matches) openBackgroundPanel();
  }

  function openBackgroundPanel(): void {
    if (bgPanel.open) return;
    bgPanel.open = true;
    void refreshBackgroundDetail();
    bgPanel.timer = setInterval(() => void backgroundPanelTick(), 2_500);
    redrawTranscript();
  }

  function stopBackgroundPanel(): void {
    if (bgPanel.timer) clearInterval(bgPanel.timer);
    Object.assign(bgPanel, { timer: null, open: false, openJob: null });
  }

  function toggleBackgroundPanel(): void {
    if (!bgPanel.open) return openBackgroundPanel();
    stopBackgroundPanel();
    redrawTranscript();
  }

  async function refreshBackgroundDetail(): Promise<void> {
    const id = chatState.sessionId;
    if (!id) {
      bgPanel.detail = { jobs: [], watches: [], crons: [] };
      return;
    }
    const seq = ++bgPanel.fetchSeq;
    bgPanel.loading = !bgPanel.detail;
    try {
      const d = await api<SessionBackgroundView>(`/api/sessions/${encodeURIComponent(id)}/background`);
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.detail = d;
      bgPanel.error = "";
    } catch (e) {
      if (seq !== bgPanel.fetchSeq) return;
      bgPanel.error = errMessage(e, "Failed to load background activity.");
    } finally {
      if (seq === bgPanel.fetchSeq) {
        bgPanel.loading = false;
        redrawTranscript();
      }
    }
  }

  async function backgroundPanelTick(): Promise<void> {
    await refreshBackgroundDetail();
    if (bgPanel.openJob) await pollJobOutput(bgPanel.openJob);
    const d = bgPanel.detail;
    if (d) {
      const row = sessionsState.list.find((r) =>
        chatState.sessionId ? r.id === chatState.sessionId : r.threadRef === chatState.threadRef,
      );
      if (
        row &&
        ((row.backgroundJobs ?? 0) !== d.jobs.length ||
          (row.watches ?? 0) !== d.watches.length ||
          (row.crons ?? 0) !== d.crons.length)
      ) {
        await refreshSessions({ silent: true });
        redrawTranscript();
      }
    }
  }

  function toggleJobOutput(processId: string): void {
    bgPanel.openJob = bgPanel.openJob === processId ? null : processId;
    if (bgPanel.openJob && !bgPanel.output.has(processId)) void pollJobOutput(processId);
    redrawTranscript();
  }

  async function pollJobOutput(processId: string): Promise<void> {
    const id = chatState.sessionId;
    if (!id) return;
    const epoch = bgPanel.epoch;
    const out: JobOutput = { text: "", cursor: 0, state: "running", ...bgPanel.output.get(processId) };
    try {
      for (let i = 0; i < 8; i++) {
        const read = await api<SessionBackgroundOutput>(
          `/api/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(processId)}/output?sinceCursor=${out.cursor}`,
        );
        const text = (out.text + read.chunk).slice(-16_384);
        Object.assign(out, { text, cursor: read.cursor, state: read.state, exitCode: read.exitCode });
        if (read.chunk.length < 60_000) break;
      }
      if (epoch !== bgPanel.epoch) return;
      bgPanel.output.set(processId, out);
    } catch (e) {
      swallow("web-ui: background job output read", e);
    }
    if (epoch !== bgPanel.epoch) return;
    redrawTranscript();
  }

  function timeLeft(expiresAt: number): string {
    const mins = Math.round((expiresAt - Date.now()) / 60_000);
    if (mins <= 0) return "expiring";
    if (mins < 60) return `${mins}m left`;
    return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m left`;
  }

  function backgroundActivityStrip(): TemplateResult | typeof nothing {
    const counts = conversationBackground(sessionsState.list, chatState.sessionId, chatState.threadRef);
    const row = counts ? backgroundLabel(counts.jobs, counts.watches, counts.crons) : null;
    const live =
      bgPanel.open && bgPanel.detail
        ? backgroundLabel(bgPanel.detail.jobs.length, bgPanel.detail.watches.length, bgPanel.detail.crons.length)
        : null;
    const label = (live ?? row)?.label;
    if (!label && !bgPanel.open) return nothing;
    return html`
      <section class="bg-activity ${bgPanel.open ? "expanded" : ""}">
        <button
          type="button"
          class="bg-activity-strip"
          aria-expanded=${String(bgPanel.open)}
          @click=${toggleBackgroundPanel}
        >
          ${icon(Activity, 13)}<span class="bg-activity-label">${label ?? "Background activity"}</span>
          <span class="bg-activity-toggle">${icon(ChevronRight, 14)}</span>
        </button>
        ${bgPanel.open ? backgroundPanelBody() : nothing}
      </section>
    `;
  }

  function backgroundPanelBody(): TemplateResult {
    const d = bgPanel.detail;
    const empty = d && d.jobs.length === 0 && d.watches.length === 0 && d.crons.length === 0;
    return html`<div class="bg-panel" role="region" aria-label="Background activity">
      ${bgPanel.error ? html`<div class="bg-panel-note">${bgPanel.error}</div>` : nothing}
      ${!d && bgPanel.loading ? html`<div class="bg-panel-note">Loading…</div>` : nothing}
      ${empty && !bgPanel.error ? html`<div class="bg-panel-note">Nothing running here anymore.</div>` : nothing}
      ${d ? d.jobs.map((j) => backgroundJobRow(j)) : nothing}
      ${d ? d.watches.map((w) => backgroundWatchRow(w)) : nothing}
      ${d ? d.crons.map((c) => backgroundCronRow(c)) : nothing}
    </div>`;
  }

  function backgroundJobRow(j: SessionBackgroundView["jobs"][number]): TemplateResult {
    const open = bgPanel.openJob === j.processId;
    const out = bgPanel.output.get(j.processId);
    const status =
      out?.state === "exited"
        ? `exited${out.exitCode !== undefined ? ` (${out.exitCode})` : ""}`
        : timeLeft(j.expiresAt);
    return html`
      <div class="bg-row ${open ? "open" : ""}">
        <button
          type="button"
          class="bg-row-head"
          aria-expanded=${String(open)}
          ${tip(open ? "Hide output" : "Show live output")}
          @click=${() => toggleJobOutput(j.processId)}
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
  }

  function backgroundCronRow(c: SessionBackgroundView["crons"][number]): TemplateResult {
    return html`
      <div class="bg-row watch">
        <a class="bg-row-head" href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}>
          ${icon(Clock3, 13)}
          <span class="bg-row-cmd">Cron: <bdi>${c.title ?? "scheduled task"}</bdi></span>
          <span class="bg-row-meta">${cronRowMeta(c)}</span>
        </a>
      </div>
    `;
  }

  function backgroundWatchRow(w: SessionBackgroundView["watches"][number]): TemplateResult {
    const what = w.pattern ? `output matching /${w.pattern}/` : "any new output";
    const note = w.instructions?.trim();
    return html`
      <div class="bg-row watch">
        <div class="bg-row-head static">
          ${icon(Radar, 13)}
          <span class="bg-row-cmd">Watch: wakes on ${what}${note ? ` · “${note}”` : ""}</span>
          <span class="bg-row-meta"
            >armed ${relTime(w.createdAt)} · ${watchActivityLabel(w)} · ${timeLeft(w.expiresAt)}</span
          >
        </div>
      </div>
    `;
  }
  return { backgroundActivityStrip, consumeBackgroundPanelRequest, requestBackgroundPanel, resetBackgroundPanel };
}
