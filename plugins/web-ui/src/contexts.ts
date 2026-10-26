import { peopleResults, type DirectoryMatch } from "./people-results";
import { html, nothing, render, type TemplateResult } from "lit";
import {
  ArrowLeft,
  Boxes,
  Folder,
  FolderPlus,
  Hash,
  Lock,
  Plus,
  Search,
  User,
  UserPlus,
  Users,
  X,
  type IconNode,
} from "lucide";
import { api, sharedContextLabel, type CoreContext, type CoreProject, type CoreSession } from "./core-bridge";
import { UI_BASE } from "./deep-link";
import { errMessage, swallowAs } from "../../chassis/src/errors";
import { avatarTpl, menuSelect, relTime } from "./ui";
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
  memberMatches: [] as DirectoryMatch[],
  memberSearching: false,
  memberBusy: false,
  memberError: "",
  memberSearchedQuery: "",
  slackEditing: false,
  slackValue: "",
  slackBusy: false,
  slackError: "",
});

export const contextsState = freshContextsState();

function setContexts(patch: Partial<typeof contextsState>, draw = true): void {
  Object.assign(contextsState, patch);
  if (draw) drawContexts();
}

let contextsLoading = false;
let contextsNotice = "";
let memberSearchSeq = 0;
const MEMBER_SEARCH_DEBOUNCE_MS = 300;
let memberSearchTimer: ReturnType<typeof setTimeout> | undefined;

function cancelMemberSearchTimer(): void {
  clearTimeout(memberSearchTimer);
  memberSearchTimer = undefined;
}
let createProjectOpener: HTMLElement | null = null;
let createProjectSeq = 0;
let contextsResetSeq = 0;
let contextsFetchSeq = 0;
let contextsQuery = "";
let contextsWorkspaceFilter: "active" | "all" = "active";

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
  cancelMemberSearchTimer();
  contextsNotice = "";
  memberSearchSeq++;
  contextsFetchSeq++;
  createProjectSeq++;
  contextsResetSeq++;
  createProjectOpener = null;
  contextsQuery = "";
  contextsWorkspaceFilter = "active";
}

export async function renderContexts(): Promise<void> {
  if (appState.currentView !== "contexts") return;
  const seq = appState.viewRenderSeq;
  const stale = () => seq !== appState.viewRenderSeq || appState.currentView !== "contexts";
  contextsNotice = "";
  contextsLoading = true;
  drawContexts();
  try {
    await Promise.all([
      fetchContexts(),
      refreshSessions({ silent: true }),
      contextsState.selected ? loadScopeSessions(contextsState.selected) : null,
    ]);
  } catch (e) {
    if (!stale()) contextsNotice = errMessage(e, "Failed to load contexts.");
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

function drawContexts(): void {
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
  const q = contextsQuery.trim().toLowerCase();
  const matches = (context: CoreContext) => {
    const meta = contextMeta(context);
    return (
      (!q || `${meta.title} ${meta.sub}`.toLowerCase().includes(q)) &&
      (contextsWorkspaceFilter === "all" ||
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
          value: contextsQuery,
          placeholder: "Search projects…",
          onInput: (value) => {
            contextsQuery = value;
            drawContexts();
          },
        },
        filters: html`<div class="list-toolbar">
          ${listSelect(
            "Show",
            contextsWorkspaceFilter,
            [
              ["active", "Active only"],
              ["all", "Everything"],
            ],
            (value) => {
              contextsWorkspaceFilter = value as typeof contextsWorkspaceFilter;
              drawContexts();
            },
          )}
        </div>`,
        notice: contextsNotice,
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

function projectPeople(context: CoreContext): string[] {
  return context.project ? [...new Set([context.project.ownerId, ...context.project.memberIds].filter(Boolean))] : [];
}

function memberLabel(context: CoreContext, principalId: string): string {
  if (principalId === appState.me?.user) return "You";
  return context.project?.members.find((member) => member.principalId === principalId)?.displayName || principalId;
}

async function linkProjectSlackChannel(context: CoreContext): Promise<void> {
  const channel = contextsState.slackValue.trim().replace(/^#/, "");
  if (!channel || contextsState.slackBusy) return;
  await mutateProject(
    context,
    "slack",
    "/slack-channel",
    { method: "PUT", body: JSON.stringify({ channel }) },
    "Couldn't link that channel. You must be a member of it.",
    () => {
      contextsState.slackEditing = false;
      contextsState.slackValue = "";
    },
  );
}

async function unlinkProjectSlackChannel(context: CoreContext): Promise<void> {
  const linked = context.project?.slackChannel;
  if (!linked || contextsState.slackBusy) return;
  if (!window.confirm(`Unlink #${linked.channelName} from ${context.name || "this project"}?`)) return;
  await mutateProject(context, "slack", "/slack-channel", { method: "DELETE" }, "Couldn't unlink the channel.");
}

async function mutateProject(
  context: CoreContext,
  kind: "member" | "slack",
  path: string,
  init: RequestInit,
  failure: string,
  onOk = () => {},
): Promise<void> {
  if (!context.project) return;
  const busy = kind === "member" ? "memberBusy" : "slackBusy";
  const error = kind === "member" ? "memberError" : "slackError";
  const resetSeq = contextsResetSeq;
  setContexts({ [busy]: true, [error]: "" });
  try {
    const project = projectFromResponse(
      await api(`/api/projects/${encodeURIComponent(context.project.id)}${path}`, init),
    );
    if (resetSeq !== contextsResetSeq) return;
    if (!project) throw new Error("Core returned an invalid project");
    upsertProject(project);
    onOk();
  } catch (e) {
    if (resetSeq !== contextsResetSeq) return;
    contextsState[error] = errMessage(e, failure);
  } finally {
    if (resetSeq === contextsResetSeq) setContexts({ [busy]: false });
  }
}

function projectSlackSection(context: CoreContext): TemplateResult {
  const linked = context.project!.slackChannel;
  const channels = [
    ...new Set(
      contextsState.list
        .filter((c) => c.kind === "channel" && c.name)
        .map((c) => c.name!.replace(/^#/, ""))
        .sort(),
    ),
  ];
  let body = html`
    <button
      class="btn project-slack-link"
      type="button"
      ?disabled=${contextsState.slackBusy}
      @click=${() => setContexts({ slackEditing: true, slackError: "" })}
    >
      ${icon(Hash, 15)}<span>Link a channel</span>
    </button>
    <p class="context-hint">
      Give this project a home channel on Slack. The agent will post updates there, and everyone in the channel joins
      the project.
    </p>
  `;
  if (linked)
    body = html`
      <div class="project-member-row">
        <span class="context-glyph" aria-hidden="true">${icon(Hash, 15)}</span>
        <span class="project-member-name" dir="auto">${linked.channelName}</span>
        ${projectBtn(`Unlink #${linked.channelName}`, X, () => void unlinkProjectSlackChannel(context), contextsState.slackBusy, "project-icon-button danger")}
      </div>
      <p class="context-hint">
        The agent posts this project's updates to #${linked.channelName}, and everyone in the channel is in the project.
      </p>
    `;
  else if (contextsState.slackEditing)
    body = html`
      <form
        class="project-slack-form"
        @submit=${(e: Event) => {
          e.preventDefault();
          void linkProjectSlackChannel(context);
        }}
      >
        <div class="project-member-search-row">
          ${icon(Hash, 16)}
          <input
            type="text"
            data-focus-key="project-slack-channel"
            autocomplete="off"
            maxlength="200"
            placeholder="channel name"
            list="project-slack-channels"
            aria-label="Slack channel to link"
            .value=${contextsState.slackValue}
            ?disabled=${contextsState.slackBusy}
            @input=${(e: Event) => {
              contextsState.slackValue = (e.target as HTMLInputElement).value;
            }}
          />
        </div>
        <datalist id="project-slack-channels">
          ${channels.map((name) => html`<option value=${name}></option>`)}
        </datalist>
        <div class="project-slack-actions">
          <button class="btn primary" type="submit" ?disabled=${contextsState.slackBusy}>Link</button>
          <button
            class="btn"
            type="button"
            ?disabled=${contextsState.slackBusy}
            @click=${() => setContexts({ slackEditing: false, slackValue: "", slackError: "" })}
          >
            Cancel
          </button>
        </div>
      </form>
    `;
  return html`
    <section class="context-panel project-slack" aria-labelledby="project-slack-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-slack-title">Slack channel</h2>
      </div>
      ${body}
      ${contextsState.slackError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.slackError}</div>` : nothing}
    </section>
  `;
}

function projectMembersSection(context: CoreContext): TemplateResult {
  const project = context.project!;
  const pickerOpen = contextsState.memberProjectId === project.id;
  const searchingOrBusy = contextsState.memberSearching || contextsState.memberBusy;
  return html`
    <section class="context-panel project-members" aria-labelledby="project-people-title">
      <div class="context-panel-heading">
        <h2 class="context-panel-title" id="project-people-title">People</h2>
        <span class="context-panel-count">${projectPeople(context).length}</span>
      </div>
      <div class="project-member-list">
        ${projectPeople(context).map((principalId) => {
          const label = memberLabel(context, principalId);
          const member = project.members.find((m) => m.principalId === principalId);
          const viaChannel = Boolean(member?.viaChannel);
          return html`
            <div class="project-member-row">
              ${avatarTpl({ key: principalId, name: label, avatarUrl: member?.avatarUrl })}
              <span class="project-member-name" dir="auto">${label}</span>
              ${principalId === project.ownerId ? html`<span class="badge">Owner</span>` : nothing}
              ${
                viaChannel && project.slackChannel
                  ? html`<span class="badge" ${tip("Joined via the linked Slack channel")}
                      ><bdi>#${project.slackChannel.channelName}</bdi></span
                    >`
                  : nothing
              }
              ${
                project.ownerId === appState.me?.user && principalId !== project.ownerId && !viaChannel
                  ? projectBtn(
                      `Remove ${label}`,
                      X,
                      () => void removeProjectMember(context, principalId),
                      searchingOrBusy,
                      "project-icon-button danger",
                    )
                  : nothing
              }
            </div>
          `;
        })}
      </div>
      ${pickerOpen ? memberPicker(context) : nothing}
      ${contextsState.memberError ? html`<div class="project-member-status error" aria-live="polite">${contextsState.memberError}</div>` : nothing}
    </section>
  `;
}

const projectBtn = (
  label: string,
  glyph: IconNode,
  onClick: () => void,
  disabled: boolean,
  cls = "project-icon-button",
) => iconBtn(label, glyph, onClick, { cls, size: 15, disabled });

function memberPicker(context: CoreContext): TemplateResult {
  const members = new Set(projectPeople(context));
  const matches = contextsState.memberMatches.filter((match) => !members.has(match.principalId)).slice(0, 8);
  const searchingOrBusy = contextsState.memberSearching || contextsState.memberBusy;
  let memberStatus = "";
  if (contextsState.memberSearching) memberStatus = "Searching…";
  else if (contextsState.memberBusy) memberStatus = "Working…";
  else if (!contextsState.memberError && contextsState.memberSearchedQuery && matches.length === 0)
    memberStatus = contextsState.memberMatches.length
      ? "Everyone matching is already in this project."
      : `No matches for “${contextsState.memberSearchedQuery}”.`;
  return html`
    <form class="project-member-picker" @submit=${(event: SubmitEvent) => void searchProjectMembers(event, context)}>
      <label for="project-member-search">Add people</label>
      <div class="project-member-search-row">
        ${icon(Search, 16)}
        <input
          id="project-member-search"
          data-focus-key="project-member-search"
          name="query"
          type="search"
          autocomplete="off"
          maxlength="80"
          placeholder="Search by name or handle"
          .value=${contextsState.memberQuery}
          ?disabled=${contextsState.memberBusy}
          @input=${(event: InputEvent) => {
            contextsState.memberQuery = (event.currentTarget as HTMLInputElement).value;
            scheduleMemberSearch(context);
          }}
        />
        ${iconBtn("Search", Search, undefined, { cls: "project-icon-button", size: 15, submit: true, disabled: searchingOrBusy })}
        ${projectBtn("Close", X, () => resetMemberPicker(null, true), contextsState.memberBusy)}
      </div>
      ${peopleResults(matches, searchingOrBusy, (match) => void addProjectMember(context, match))}
      <div class="project-member-status" aria-live="polite">${memberStatus}</div>
    </form>
  `;
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
  createProjectOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setContexts({ createOpen: true, createName: "", createError: "" });
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-name")?.focus());
}

function closeCreateProject(): void {
  createProjectSeq++;
  setContexts({ createOpen: false, createSaving: false, createName: "", createError: "" });
  queueMicrotask(() => {
    const target = createProjectOpener;
    createProjectOpener = null;
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

function projectFromResponse(response: unknown): CoreProject | null {
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

function upsertProject(project: CoreProject): CoreContext {
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

function resetMemberPicker(projectId: string | null, draw = false): void {
  stopMemberSearch();
  setContexts({ memberProjectId: projectId, memberQuery: "", memberMatches: [], memberError: "" }, false);
  contextsState.memberSearchedQuery = "";
  clearSlackDraft();
  if (draw) drawContexts();
}

function clearSlackDraft(): void {
  setContexts({ slackEditing: false, slackValue: "", slackBusy: false, slackError: "" }, false);
}

function toggleMemberPicker(context: CoreContext): void {
  resetMemberPicker(contextsState.memberProjectId === context.project?.id ? null : (context.project?.id ?? null), true);
  if (contextsState.memberProjectId)
    queueMicrotask(() => document.querySelector<HTMLInputElement>("#project-member-search")?.focus());
}

function scheduleMemberSearch(context: CoreContext): void {
  const hadVisibleState =
    contextsState.memberSearching || contextsState.memberError !== "" || contextsState.memberSearchedQuery !== "";
  stopMemberSearch();
  setContexts({ memberError: "", memberSearchedQuery: "" }, false);
  clearSlackDraft();
  const query = contextsState.memberQuery.trim();
  if (query.length < 2) {
    if (hadVisibleState || contextsState.memberMatches.length) setContexts({ memberMatches: [] });
    return;
  }
  memberSearchTimer = setTimeout(() => {
    memberSearchTimer = undefined;
    void runMemberSearch(context, query);
  }, MEMBER_SEARCH_DEBOUNCE_MS);
  if (hadVisibleState) drawContexts();
}

async function searchProjectMembers(event: SubmitEvent, context: CoreContext): Promise<void> {
  event.preventDefault();
  if (!context.project || contextsState.memberBusy) return;
  cancelMemberSearchTimer();
  const input = (event.currentTarget as HTMLFormElement).elements.namedItem("query") as HTMLInputElement | null;
  const query = input?.value.trim() ?? "";
  setContexts({ memberQuery: query, memberError: "" }, false);
  if (query.length < 2)
    return setContexts({ memberMatches: [], memberSearchedQuery: "", memberError: "Enter at least two characters." });
  await runMemberSearch(context, query);
}

async function runMemberSearch(context: CoreContext, query: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  if (contextsState.memberProjectId !== context.project.id) return;
  const projectId = context.project.id;
  const searchSeq = ++memberSearchSeq;
  setContexts({ memberSearching: true });
  try {
    const response = await api<{ matches?: DirectoryMatch[] }>(`/api/directory/resolve?q=${encodeURIComponent(query)}`);
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberMatches = (response.matches ?? []).filter((match) => match.type === "internal");
    contextsState.memberSearchedQuery = query;
  } catch (error) {
    if (searchSeq !== memberSearchSeq || contextsState.memberProjectId !== projectId) return;
    contextsState.memberSearchedQuery = "";
    contextsState.memberError = errMessage(error, "Couldn't search for people.");
  } finally {
    if (searchSeq === memberSearchSeq) setContexts({ memberSearching: false });
  }
}

function stopMemberSearch(): void {
  memberSearchSeq++;
  cancelMemberSearchTimer();
  contextsState.memberSearching = false;
}

async function addProjectMember(context: CoreContext, member: DirectoryMatch): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  stopMemberSearch();
  await mutateProject(
    context,
    "member",
    "/members",
    { method: "POST", body: JSON.stringify({ memberId: member.principalId }) },
    "Couldn't add that person.",
    () => {
      setContexts({ memberQuery: "", memberMatches: [], memberSearchedQuery: "" }, false);
    },
  );
}

async function removeProjectMember(context: CoreContext, principalId: string): Promise<void> {
  if (!context.project || contextsState.memberBusy) return;
  const label = memberLabel(context, principalId);
  if (!window.confirm(`Remove ${label} from ${context.name || "this project"}?`)) return;
  stopMemberSearch();
  await mutateProject(
    context,
    "member",
    `/members/${encodeURIComponent(principalId)}`,
    { method: "DELETE" },
    "Couldn't remove that person.",
  );
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
