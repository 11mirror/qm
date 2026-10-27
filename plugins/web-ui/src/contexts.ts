import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Boxes,
  Folder,
  FolderPlus,
  Hash,
  Lock,
  Plus,
  User,
  UserPlus,
  Users,
  X,
  type IconNode,
} from "lucide";
import { api, sharedContextLabel, type CoreContext, type CoreProject, type CoreSession } from "./core-bridge";
import { UI_BASE } from "./deep-link";
import { errMessage, swallowAs } from "../../chassis/src/errors";
import { menuSelect, relTime } from "./ui";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import { appState, replacePanePreservingFocus, switchView, syncUrlFromState } from "./shell";
import { startNewChat } from "./sessions";
import { groupDmTitle, loadScopeSessions, openSession, refreshSessions, sessionsState } from "./sessions";
import { activityOf, sidebarSessions, surfaceOf } from "./session-list";
import { restoreDialogFocus } from "./dialog-focus";
import { iconBtn, listPageTpl, listSelect } from "./list-page";
import { ambientPolicySection, loadAmbientPolicy, resetAmbientPolicy } from "./ambient-policy";
import { contextModelSection, loadContextModel, resetContextModel } from "./context-model";
import { channelHeaderSection, loadChannelHeader, resetChannelHeader } from "./channel-header";
import { tip } from "./tooltip";
import { canvasToast } from "./split";
import {
  memberSearch,
  projectMembersSection,
  projectSlackSection,
  resetMemberPicker,
  toggleMemberPicker,
} from "./project-sections";

const RESOURCE_KEYS = ["files", "webhooks", "crons", "deployments", "skills"] as const;
type ScopeResourcesView = Record<(typeof RESOURCE_KEYS)[number], unknown[]>;

const freshContextsState = () => ({
  list: [] as CoreContext[],
  loaded: false,
  loadedAt: 0,
  selected: null as string | null,
  resources: null as ScopeResourcesView | null,
  resourcesScope: null as string | null,
  resourcesLoading: false,
  resourcesNotice: "",
  createOpen: false,
  createName: "",
  createSaving: false,
  createError: "",
  memberProjectId: null as string | null,
  memberQuery: "",
  memberBusy: false,
  memberError: "",
  slackEditing: false,
  slackValue: "",
  slackBusy: false,
  slackError: "",
  notice: "",
  query: "",
  workspaceFilter: "active" as "active" | "all",
  createOpener: null as HTMLElement | null,
});

export const contextsState = freshContextsState();

export function setContexts(patch: Partial<typeof contextsState>, draw = true): void {
  Object.assign(contextsState, patch);
  if (draw) drawContexts();
}

let contextsLoading = false;
let createProjectSeq = 0;
export let contextsResetSeq = 0;
let contextsFetchSeq = 0;

async function fetchContexts(): Promise<CoreContext[]> {
  const fetchSeq = ++contextsFetchSeq;
  const result = await api<{ contexts: CoreContext[] }>("/api/contexts").catch((error: unknown) => {
    if (fetchSeq !== contextsFetchSeq) return null;
    throw error;
  });
  if (!result || fetchSeq !== contextsFetchSeq) return contextsState.list;
  contextsState.list = result.contexts ?? [];
  contextsState.loaded = true;
  contextsState.loadedAt = Date.now();
  return contextsState.list;
}

export function resetContextsState(): void {
  Object.assign(contextsState, freshContextsState());
  memberSearch.clear();
  contextsFetchSeq++;
  createProjectSeq++;
  contextsResetSeq++;
}

export async function renderContexts(): Promise<void> {
  if (appState.currentView !== "contexts") return;
  const seq = appState.viewRenderSeq;
  const stale = () => seq !== appState.viewRenderSeq || appState.currentView !== "contexts";
  contextsState.notice = "";
  contextsLoading = true;
  drawContexts();
  try {
    await Promise.all([
      fetchContexts(),
      refreshSessions({ silent: true }),
      contextsState.selected ? loadScopeSessions(contextsState.selected) : null,
    ]);
  } catch (e) {
    if (!stale()) contextsState.notice = errMessage(e, "Failed to load contexts.");
  }
  if (stale()) return;
  contextsLoading = false;
  if (
    contextsState.selected &&
    contextsState.list.some((c) => c.scopeId === contextsState.selected) &&
    contextsState.resourcesScope !== contextsState.selected
  )
    loadPanels(contextsState.selected);
  drawContexts();
}

function loadPanels(scopeId: string): void {
  void loadScopeResources(scopeId);
  for (const load of [loadAmbientPolicy, loadContextModel, loadChannelHeader]) void load(scopeId, drawContexts);
}

function contextMeta(c: CoreContext): { title: string; sub: string; glyph: IconNode } {
  if (c.project) {
    const count = projectPeople(c).length;
    return { title: c.project.name, sub: `${count} ${count === 1 ? "member" : "members"}`, glyph: Folder };
  }
  if (c.kind === "personal")
    return { title: "Personal", sub: "Just you. Your web chats and DMs with the agent live here.", glyph: User };
  const [fallback, where, glyph] =
    c.kind === "group" ? ["Group DM", "group conversation", Users] : ["Channel", "channel", Hash];
  return {
    title: sharedContextLabel(c.scopeId, c.name) ?? fallback,
    sub: `Shared with everyone in this ${where}.`,
    glyph,
  };
}

export async function ensureContexts(force = false): Promise<CoreContext[]> {
  if (!contextsState.loaded || force) await fetchContexts().catch(() => null);
  return contextsState.list;
}

export function personalScopeId(): string | null {
  return contextsState.list.find((c) => c.kind === "personal")?.scopeId ?? null;
}

export function resolveProjectScope(contexts: readonly CoreContext[], slug: string): string | null {
  if (slug.startsWith("channel:") || slug.startsWith("group:")) {
    return contexts.some((context) => context.scopeId === slug) ? slug : null;
  }
  const normalized = slug.toLowerCase();
  const matches = contexts.filter((context) => {
    const match = /^personal:([^@]+)@/.exec(context.scopeId);
    return match?.[1]?.toLowerCase() === normalized;
  });
  return matches.length === 1 ? matches[0]!.scopeId : null;
}

function metaForScope(scopeId: string | null, fallbackName?: string | null): { title: string; glyph: IconNode } {
  const c = scopeId ? contextsState.list.find((x) => x.scopeId === scopeId) : undefined;
  if (c) return contextMeta(c);
  const shared = sharedContextLabel(scopeId, fallbackName ?? null);
  if (shared) return { title: shared, glyph: scopeId?.startsWith("group:") ? Users : Hash };
  if (scopeId?.startsWith("personal:") && scopeId !== personalScopeId())
    return { title: "Shared personal space", glyph: User };
  return { title: fallbackName?.trim() || "Personal", glyph: User };
}

export function scopeTitle(scopeId: string | null, fallbackName?: string | null): string {
  return metaForScope(scopeId, fallbackName).title;
}

export function scopeChip(scopeId: string | null, fallbackName?: string | null): TemplateResult {
  const { title, glyph } = metaForScope(scopeId, fallbackName);
  return html`<span class="scope-chip" ${tip(`In ${title}`)}
    >${icon(glyph, 12)}<span dir="auto">${title.replace(/^#/, "")}</span></span
  >`;
}

export function scopeFilterControl(current: string | null, onSelect: (scopeId: string | null) => void): TemplateResult {
  return menuSelect({
    value: current,
    prefix: "Filter by: ",
    ariaLabel: "Filter by context",
    className: "scope-filter",
    onSelect,
    options: [
      { value: null, label: "All contexts", glyph: Boxes },
      ...contextsState.list.map((c) => ({
        value: c.scopeId,
        label: contextMeta(c).title,
        glyph: contextMeta(c).glyph,
      })),
    ],
  });
}

function sessionsIn(scopeId: string): CoreSession[] {
  return sidebarSessions(sessionsState.list)
    .filter((s) => s.scopeId === scopeId && !s.archived)
    .sort((a, b) => activityOf(b) - activityOf(a));
}

export function drawContexts(): void {
  if (appState.currentView !== "contexts" || !appState.mainEl) return;
  const host = document.createElement("div");
  host.className = "pane contexts-pane";
  const selected = contextsState.selected
    ? contextsState.list.find((c) => c.scopeId === contextsState.selected)
    : undefined;
  render(selected ? detailTpl(selected) : gridTpl(), host);
  replacePanePreservingFocus(host);
  const dialog = host.querySelector<HTMLDialogElement>(".project-dialog");
  if (dialog && !dialog.open) dialog.showModal();
}

function gridTpl(): TemplateResult {
  const q = contextsState.query.trim().toLowerCase();
  const matches = (context: CoreContext) => {
    const meta = contextMeta(context);
    return (
      (!q || `${meta.title} ${meta.sub}`.toLowerCase().includes(q)) &&
      (contextsState.workspaceFilter === "all" ||
        context.kind === "personal" ||
        Boolean(context.project) ||
        Boolean(context.sessionCount))
    );
  };
  const projects = contextsState.list.filter(matches);
  let empty = q ? "No projects match your search." : "No projects yet.";
  if (contextsLoading && contextsState.list.length === 0) empty = "Loading projects…";
  const groupOf = (context: CoreContext) => {
    if (context.kind === "personal") return "Personal";
    return context.project ? "Web" : "Slack";
  };
  const groups = ["Personal", "Web", "Slack"]
    .map((label) => ({ label, items: projects.filter((context) => groupOf(context) === label) }))
    .filter((g) => g.items.length > 0);
  return html`
    <div class="project-grid-content">
      ${listPageTpl({
        title: "Projects",
        action: { label: "New project", onClick: openCreateProject },
        search: {
          value: contextsState.query,
          placeholder: "Search projects…",
          onInput: (value) => {
            contextsState.query = value;
            drawContexts();
          },
        },
        filters: html`<div class="list-toolbar">
          ${listSelect(
            "Show",
            contextsState.workspaceFilter,
            [
              ["active", "Active only"],
              ["all", "Everything"],
            ],
            (value) => {
              contextsState.workspaceFilter = value as typeof contextsState.workspaceFilter;
              drawContexts();
            },
          )}
        </div>`,
        notice: contextsState.notice,
        rows: [],
        groups: groups.map((g) => ({ title: `${g.label} · ${g.items.length}`, rows: g.items.map(contextRow) })),
        empty,
      })}
    </div>
    ${createProjectDialog()}
  `;
}

function contextRow(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const count = c.sessionCount === 1 ? "1 conversation" : `${c.sessionCount} conversations`;
  const meta = [c.project ? sub : "", count, c.lastActivityAt ? `active ${relTime(c.lastActivityAt)}` : ""]
    .filter(Boolean)
    .join(" · ");
  return html`
    <button class="context-row" type="button" ${tip(sub)} @click=${() => selectContext(c.scopeId)}>
      <span class="context-glyph">${icon(glyph, 15)}</span>
      <span class="context-row-title" dir="auto">${title}</span>
      ${c.isPrivate ? html`<span class="context-lock" ${tip("Private channel")}>${icon(Lock, 12)}</span>` : nothing}
      <span class="context-row-meta">${meta}</span>
    </button>
  `;
}

function detailTpl(c: CoreContext): TemplateResult {
  const { title, sub, glyph } = contextMeta(c);
  const sessions = sessionsIn(c.scopeId);
  const completelyEmpty = sessions.length === 0 && scopeResourcesEmpty(c.scopeId);
  return html`
    <div class="context-detail">
      <button class="context-back" type="button" @click=${() => selectContext(null)}>
        ${icon(ArrowLeft, 15)}<span>Projects</span>
      </button>
      <div class="context-detail-head">
        <span class="context-glyph large">${icon(glyph, 22)}</span>
        <div class="context-detail-titles">
          <h1 class="pane-title">
            ${title}
            ${c.isPrivate ? html`<span class="context-lock" ${tip("Private channel")}>${icon(Lock, 14)}</span>` : nothing}
          </h1>
          <div class="context-sub">
            ${c.project ? sub : `${sub} The agent's files and memory here are separate from your other contexts.`}
          </div>
        </div>
        <div class="context-detail-actions">
          ${
            c.project
              ? html`<button class="btn context-add-member" type="button" @click=${() => toggleMemberPicker(c)}>
                  ${icon(UserPlus, 15)}<span>Add people</span>
                </button>`
              : nothing
          }
          <button
            class="btn primary context-new-chat"
            type="button"
            @click=${() => startNewChat(c.kind === "personal" ? null : c.scopeId, c.name)}
          >
            ${icon(Plus, 15)}<span>New chat</span>
          </button>
        </div>
      </div>
      <div class="context-workspace has-settings">
        <div class="context-workspace-main">
          ${
            completelyEmpty
              ? html`
                  <section class="context-panel context-project-empty">
                    <span class="context-glyph large" aria-hidden="true">${icon(glyph, 22)}</span>
                    <h2>This project is ready for work</h2>
                    <p>
                      Start a conversation with New chat. Files, automations, and other work created there will stay
                      scoped to this project.
                    </p>
                  </section>
                `
              : html`
                  <section class="context-panel context-conversations" aria-labelledby="context-conversations-title">
                    <div class="context-panel-heading">
                      <h2 class="context-panel-title" id="context-conversations-title">Conversations</h2>
                      ${sessions.length ? html`<span class="context-panel-count">${sessions.length}</span>` : nothing}
                    </div>
                    ${
                      sessions.length
                        ? html`<div class="context-session-list">${sessions.map((s) => contextSessionRow(s))}</div>`
                        : html`<div class="context-inline-empty">No conversations yet.</div>`
                    }
                  </section>
                  ${resourceSections(c.scopeId)}
                `
          }
        </div>
        <aside class="context-settings" aria-label=${c.project ? "Project settings" : "Context settings"}>
          ${c.project ? projectMembersSection(c) : nothing} ${c.project ? projectSlackSection(c) : nothing}
          ${contextModelSection(c.scopeId)} ${channelHeaderSection(c.scopeId)} ${ambientPolicySection(c.scopeId)}
        </aside>
      </div>
    </div>
  `;
}

function scopeResourcesEmpty(scopeId: string): boolean {
  const r = contextsState.resourcesScope === scopeId ? contextsState.resources : null;
  return Boolean(r && Object.values(r).every((items) => items.length === 0));
}

export function projectPeople(context: CoreContext): string[] {
  return context.project ? [...new Set([context.project.ownerId, ...context.project.memberIds].filter(Boolean))] : [];
}

function resourceSections(scopeId: string): TemplateResult | typeof nothing {
  if (contextsState.resourcesScope !== scopeId) return html``;
  if (contextsState.resourcesNotice) return html`<div class="status">${contextsState.resourcesNotice}</div>`;
  const r = contextsState.resources;
  if (!r) {
    return contextsState.resourcesLoading
      ? html`<div class="empty compact">Loading this context's files, webhooks, crons, apps and skills…</div>`
      : html``;
  }
  const groups = (
    [
      ["Files", "files", r.files.length],
      ["Skills", "skills", r.skills.length],
      ["Crons", "crons", r.crons.length],
      ["Webhooks", "webhooks", r.webhooks.length],
      ["Apps", "apps", r.deployments.length],
    ] as const
  ).filter(([, , count]) => count > 0);
  if (!groups.length) return nothing;
  return html`
    <section class="context-panel context-resource-group">
      <div class="context-panel-heading">
        <h2 class="context-panel-title">Resources</h2>
      </div>
      <div class="context-session-list">
        ${groups.map(
          ([label, path, count]) =>
            html`<a class="context-session-row" href=${`${UI_BASE}/${path}?scope=${encodeURIComponent(scopeId)}`}>
              <span class="context-session-title">${label}</span>
              <span class="context-session-meta"><span class="badge">${count}</span></span>
            </a>`,
        )}
      </div>
    </section>
  `;
}

function openCreateProject(): void {
  contextsState.createOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setContexts({ createOpen: true, createName: "", createError: "" });
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
}

function closeCreateProject(): void {
  createProjectSeq++;
  setContexts({ createOpen: false, createSaving: false, createName: "", createError: "" });
  queueMicrotask(() => {
    const target = contextsState.createOpener;
    contextsState.createOpener = null;
    restoreDialogFocus(target, () => document.querySelector<HTMLElement>(".list-page-action"));
  });
}

function createProjectDialog(): TemplateResult | typeof nothing {
  if (!contextsState.createOpen) return nothing;
  return html`
    <dialog
      class="project-dialog"
      aria-labelledby="project-dialog-title"
      @close=${closeCreateProject}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void createProject(event)}>
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(FolderPlus, 21)}</span>
          <div><h2 id="project-dialog-title">New project</h2></div>
          ${iconBtn("Close", X, closeCreateProject, { aria: "Close new project", cls: "project-icon-button", size: 16 })}
        </div>
        <label class="project-name-field" for="project-name">
          <span>Name</span>
          <input
            id="project-name"
            data-focus-key="project-name"
            name="name"
            maxlength="200"
            autocomplete="off"
            placeholder="launch cohort"
            .value=${contextsState.createName}
            ?disabled=${contextsState.createSaving}
            @input=${(event: InputEvent) => {
              contextsState.createName = (event.currentTarget as HTMLInputElement).value;
              contextsState.createError = "";
            }}
          />
        </label>
        <div class="form-error" aria-live="polite">${contextsState.createError}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeCreateProject}>
            ${contextsState.createSaving ? "Close" : "Cancel"}
          </button>
          <button class="btn primary" type="submit" ?disabled=${contextsState.createSaving}>
            ${icon(FolderPlus, 15)}<span>${contextsState.createSaving ? "Creating…" : "Create project"}</span>
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function openProjectDetail(scopeId: string): void {
  switchView("contexts");
  selectContext(scopeId);
}

export async function renameProject(project: CoreProject, name: string): Promise<void> {
  try {
    const updated = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    );
    if (!updated) throw new Error("Couldn't rename that project.");
    upsertProject(updated);
    if (appState.currentView === "contexts") drawContexts();
  } catch (error) {
    canvasToast(errMessage(error, "Couldn't rename that project."));
  }
}

export function projectFromResponse(response: unknown): CoreProject | null {
  const project = (response as { project?: CoreProject } | null)?.project;
  if (
    !project ||
    !project.id ||
    !project.name ||
    !project.ownerId ||
    !project.scopeId?.trim() ||
    !Array.isArray(project.memberIds) ||
    !Array.isArray(project.members) ||
    project.members.some((member) => !member?.principalId || !member.displayName)
  )
    return null;
  return project;
}

export function upsertProject(project: CoreProject): CoreContext {
  contextsFetchSeq++;
  const scopeId = project.scopeId;
  const current = contextsState.list.find((context) => context.scopeId === scopeId);
  const next: CoreContext = {
    ...current,
    scopeId,
    kind: "group",
    name: project.name,
    sessionCount: current?.sessionCount ?? 0,
    lastActivityAt: current?.lastActivityAt ?? null,
    project,
  };
  contextsState.list = [next, ...contextsState.list.filter((context) => context.scopeId !== scopeId)];
  if (contextsState.loaded) contextsState.loadedAt = Date.now();
  return next;
}

async function createProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (contextsState.createSaving) return;
  const name = contextsState.createName.trim();
  if (!name) {
    setContexts({ createError: "Enter a project name." });
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
    return;
  }
  const seq = ++createProjectSeq;
  const resetSeq = contextsResetSeq;
  setContexts({ createSaving: true });
  try {
    const project = projectFromResponse(await api("/api/projects", { method: "POST", body: JSON.stringify({ name }) }));
    if (resetSeq !== contextsResetSeq) return;
    if (!project) throw new Error("Core returned an invalid project");
    const loaded = contextsState.loaded;
    let context = upsertProject(project);
    if (!loaded) {
      await fetchContexts().catch(() => contextsState.list);
      if (resetSeq !== contextsResetSeq) return;
      context = upsertProject(project);
    }
    if (seq !== createProjectSeq) {
      if (appState.currentView === "contexts") drawContexts();
      return;
    }
    setContexts({ createOpen: false, createSaving: false, createName: "" }, false);
    selectContext(context.scopeId);
  } catch (error) {
    if (seq !== createProjectSeq || resetSeq !== contextsResetSeq) return;
    setContexts({ createSaving: false, createError: errMessage(error, "Couldn't create that project.") });
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
  }
}

async function loadScopeResources(scopeId: string): Promise<void> {
  setContexts({ resources: null, resourcesScope: scopeId, resourcesLoading: true, resourcesNotice: "" });
  const seq = appState.viewRenderSeq;
  const stale = () =>
    seq !== appState.viewRenderSeq || appState.currentView !== "contexts" || contextsState.selected !== scopeId;
  try {
    const r = await api<ScopeResourcesView>(`/api/scope-resources?scope=${encodeURIComponent(scopeId)}`);
    if (stale()) return;
    const resources = {} as ScopeResourcesView;
    for (const key of RESOURCE_KEYS) resources[key] = r[key] ?? [];
    contextsState.resources = resources;
  } catch (e) {
    if (stale()) return;
    contextsState.resourcesNotice = errMessage(e, "Failed to load this context's resources.");
  } finally {
    if (!stale()) setContexts({ resourcesLoading: false });
  }
}

function contextSessionRow(s: CoreSession): TemplateResult {
  const surface = surfaceOf(s);
  return html`
    <button class="context-session-row" type="button" @click=${() => void openSession(s)}>
      <span class="context-session-title" dir="auto">${groupDmTitle(s)}</span>
      <span class="context-session-meta">
        ${surface === "slack" ? html`<span class="surface surface-slack">${slackMark(13, true)}</span>` : html`<span class="badge">${surface}</span>`}
        ${!s.canContinue ? html`<span class="ro-lock" ${tip("Read-only. Replies happen on the original surface")}>${icon(Lock, 12)}</span>` : nothing}
        <span>${relTime(activityOf(s))}</span>
      </span>
    </button>
  `;
}

function selectContext(scopeId: string | null): void {
  resetMemberPicker(null);
  contextsState.selected = scopeId;
  setContexts({ resources: null, resourcesScope: null, resourcesNotice: "", resourcesLoading: false }, false);
  resetAmbientPolicy();
  resetContextModel();
  resetChannelHeader();
  syncUrlFromState();
  drawContexts();
  if (scopeId) {
    void loadScopeSessions(scopeId).then(drawContexts).catch(swallowAs("web-ui: load context chats", undefined));
    loadPanels(scopeId);
  }
}
