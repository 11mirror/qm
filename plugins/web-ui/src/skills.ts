import { html, nothing, type TemplateResult } from "lit";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage, swallow } from "../../chassis/src/errors";
import { appState } from "./shell";
import {
  filterSkillGroups,
  groupSkills,
  isArchivedSkill,
  skillEmptyState,
  statusCounts,
  type SkillStatusFilter,
} from "./skill-registry";
import {
  artifactPage,
  detailTpl,
  fieldTpl,
  listBackLink,
  listPageTpl,
  listSelect,
  listTabs,
  showPane,
} from "./list-page";
import { fieldSelect } from "./ui";
import { scopeTitle } from "./contexts";
import { confirmDialogTpl, focusDialogCancel, restoreDialogFocus } from "./dialog-focus";
import { tip } from "./tooltip";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
const filters = { query: "", scope: "all", source: "all", status: "active" as SkillStatusFilter };
let createScopes: Array<{ scopeId: string; name: string }> = [];
const page = artifactPage("skills", "skills-page", "skills");

type Draft = { description: string; body: string; scopeId?: string; review: string | null };
let editing: (Draft & { id: string }) | null = null;
let editingTarget: SkillItem | null = null;
let busy = false;
let formError = "";

let creating: (Draft & { name: string; scopeId: string }) | null = null;

let deleting: string | null = null;
let archiveConfirmation: SkillItem | null = null;
let editRequestSeq = 0;
let refreshSeq = 0;
let mutationSeq = 0;
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;

export function openSkillById(id: string): void {
  page.pending = id;
}

export function routeSkillsHistory(skillId: string | null): void {
  page.route(
    skillId,
    (id) => skillRows.find((candidate) => candidate.id === id),
    openSkill,
    () => drawSkills(),
  );
}

const $ = (selector: string) => page.host?.querySelector<HTMLElement>(selector) ?? null;
const activeElement = () => (document.activeElement instanceof HTMLElement ? document.activeElement : null);

function skillButton(selector: string, target: HTMLElement | null, root: ParentNode | null = page.host) {
  const id = target?.dataset.skillId;
  return id ? [...(root?.querySelectorAll<HTMLElement>(selector) ?? [])].find((el) => el.dataset.skillId === id) : null;
}

function setFilters(patch: Partial<typeof filters>): void {
  Object.assign(filters, patch);
  drawSkills();
}

function sharedScope(scopeId?: string): boolean {
  return Boolean(scopeId && !scopeId.startsWith("personal:"));
}

function editKey(e: NonNullable<typeof editing>): string {
  return JSON.stringify([e.description, e.body]);
}

function createKey(c: NonNullable<typeof creating>): string {
  return JSON.stringify([c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId]);
}

function editAudience(scopeId: string | undefined): string {
  if (scopeId?.startsWith("personal:")) return "only you";
  return scopeId ? scopeTitle(scopeId) : "this context";
}

function resetFlow(): void {
  editRequestSeq += 1;
  mutationSeq += 1;
  editing = null;
  editingTarget = null;
  creating = null;
  formError = "";
  busy = false;
}

async function startEdit(s: SkillItem): Promise<void> {
  if (!s.id) return;
  resetFlow();
  const request = editRequestSeq;
  flowFocusTarget = activeElement();
  editingTarget = s;
  skillsNotice = "Loading skill instructions…";
  drawSkills();
  queueMicrotask(() => $(".context-back")?.focus());
  try {
    const r = await api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(s.id)}`);
    if (request !== editRequestSeq) return;
    const { description, scopeId } = r.skill;
    editing = { id: s.id, description, body: r.skill.body ?? "", scopeId, review: null };
    editingTarget = r.skill;
    skillsNotice = "";
  } catch (e) {
    if (request !== editRequestSeq) return;
    formError = errMessage(e, "Failed to load skill details.");
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => ($("#skill-edit-description") ?? $(".context-back"))?.focus());
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const search = $(".list-search input");
    const create = $(".list-page-action");
    const fallback = target?.dataset.skillId
      ? (skillButton(".skill-edit-trigger", target) ?? search ?? create)
      : (create ?? search);
    restoreDialogFocus(target, () => fallback);
  });
}

function closeFocusedFlow(): void {
  resetFlow();
  skillsNotice = "";
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawSkills();
  restoreFocusedFlow(target);
}

function startCreate(): void {
  if (creating) return;
  flowFocusTarget = activeElement();
  resetFlow();
  creating = { name: "", description: "", body: "", scopeId: createScopes[0]?.scopeId ?? "", review: null };
  drawSkills();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#skill-create-name")?.focus());
}

function skillScopeTitle(s: SkillItem): string {
  if (s.scopeId && (s.scope === "personal" || s.scope === "channel" || s.scope === "group")) {
    return scopeTitle(s.scopeId);
  }
  return s.scope ? s.scope.charAt(0).toUpperCase() + s.scope.slice(1) : "";
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const owned = s.editable === true && Boolean(s.id);
  const archived = isArchivedSkill(s);
  let archiveLabel = "Archive";
  if (deleting === s.id) archiveLabel = "Working…";
  else if (archived) archiveLabel = "Restore";
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      ${page.link(
        s.id ?? null,
        "skill-variant-main",
        () => openSkill(s, { push: true }),
        html`<code class="skill-variant-name" dir="auto">/${s.name}</code>
          <span class="skill-variant-description" ${tip(s.description)}>${s.description}</span>`,
        `Open /${s.name}`,
      )}
      <div class="skill-variant-state">
        ${archived ? html`<span class="badge">Archived</span>` : nothing}
        ${!archived && hasScopeVariants ? html`<span class="badge">Scope variant</span>` : nothing}
        ${owned && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${() => void startEdit(s)}>Edit</button>` : nothing}
        ${owned ? html`<button class="btn skill-archive-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${(event: Event) => void deleteSkill(s, event.currentTarget as HTMLElement)}>${archiveLabel}</button>` : nothing}
      </div>
    </div>
  `;
}

function openSkill(s: SkillItem, opts: { push?: boolean } = {}): void {
  page.syncUrl(s.id ?? null, opts.push);
  showPane(
    "skill-pane",
    detailTpl({
      back: "Skills",
      onBack: () => drawSkills(),
      title: `/${s.name}`,
      heading: isArchivedSkill(s) ? html`<span class="badge">Archived</span>` : undefined,
      body: html`
        ${fieldTpl("Description", s.description)} ${fieldTpl("Scope", skillScopeTitle(s))}
        ${fieldTpl("Version", s.version ?? 1)}
        ${fieldTpl("Source", s.source === "pack" ? `Pack ${s.pack?.upstreamName ?? "source"}` : "Local")}
        ${fieldTpl("Capabilities", s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : "None required")}
        ${fieldTpl("Assets", s.assetCount ?? 0)}
      `,
    }),
  );
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${formHeading(
        html`Edit <bdi>/${editingTarget?.name ?? "skill"}</bdi>`,
        formError ? "Instructions unavailable." : "Loading instructions…",
      )}
      ${formError ? html`<div class="form-error" role="alert">${formError}</div>` : nothing}
    </section>`;
  }
  const reviewed = e.review === editKey(e);
  return skillForm({
    title: html`Edit <bdi>/${editingTarget!.name}</bdi>`,
    sub: `Available to ${editAudience(e.scopeId)}`,
    badge: "Editing",
    submit: saveEdit,
    reviewed,
    label: reviewed ? "Publish change" : "Save",
    ready: true,
    reviewAgain: () => (e.review = null),
    fields: html`${skillText(e, "description", "Description", "skill-edit-description", { id: "skill-edit-description" })}
    ${skillText(e, "body", "Instructions", "skill-edit-body", { area: true })}`,
    impact: html`<strong>Publish this change to <bdi>${scopeTitle(e.scopeId ?? null)}</bdi>?</strong>
      <div class="card-meta">
        Everyone in this context can invoke the updated instructions. Description
        ${e.description === editingTarget!.description ? "unchanged" : "changed"}; instructions
        ${e.body === (editingTarget!.body ?? "") ? "unchanged" : "changed"}.
      </div>`,
  });
}

function creatorPane() {
  const c = creating!;
  const reviewed = c.review === createKey(c);
  return skillForm({
    title: "New skill",
    sub: "Create a reusable procedure for yourself or a shared context.",
    badge: "New",
    submit: saveCreate,
    reviewed,
    label: reviewed ? "Publish skill" : "Create skill",
    ready: c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "",
    reviewAgain: () => (c.review = null),
    fields: html`${skillText(c, "name", "Name", "skill-create-name", { id: "skill-create-name", placeholder: "watch-pipeline" })}
      <label class="skill-field">
        <span>Available to</span>
        ${fieldSelect({
          className: "skill-scope-select",
          value: c.scopeId,
          disabled: busy,
          onChange: (value) => {
            c.scopeId = value;
            c.review = null;
            drawSkills();
          },
          options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
        })}
        <small class="card-meta">Everyone in a shared context can invoke and edit this skill.</small>
      </label>
      ${skillText(c, "description", "Description", "skill-create-description", { placeholder: "One line: what it does / when to use it" })}
      ${skillText(c, "body", "Instructions", "skill-create-body", { area: true, placeholder: "The SKILL.md contents: the steps to follow when this skill is used." })}`,
    impact: html`<strong>Publish <bdi>/${c.name.trim()}</bdi> to <bdi>${scopeTitle(c.scopeId)}</bdi>?</strong>
      <div class="card-meta">Everyone in this context can invoke and edit these instructions.</div>`,
  });
}

function skillText<K extends string>(
  draft: Record<K, string>,
  key: K,
  label: string,
  focusKey: string,
  o: { id?: string; placeholder?: string; area?: boolean } = {},
): TemplateResult {
  const onInput = (ev: Event) => {
    draft[key] = (ev.target as HTMLInputElement).value;
    drawSkills();
  };
  return html`<label class="skill-field">
    <span>${label}</span>
    ${
      o.area
        ? html`<textarea
            class="skill-body-input"
            spellcheck="false"
            placeholder=${o.placeholder ?? nothing}
            data-focus-key=${focusKey}
            ?disabled=${busy}
            @input=${onInput}
            .value=${draft[key]}
          ></textarea>`
        : html`<input
            id=${o.id ?? nothing}
            class="skill-desc-input"
            type="text"
            placeholder=${o.placeholder ?? nothing}
            data-focus-key=${focusKey}
            .value=${draft[key]}
            ?disabled=${busy}
            @input=${onInput}
          />`
    }
  </label>`;
}

function formHeading(title: TemplateResult | string, sub: string, badge: TemplateResult | typeof nothing = nothing) {
  return html`${listBackLink("Back to skills", closeFocusedFlow)}
    <div class="skill-form-heading">
      <div>
        <h1 class="pane-title">${title}</h1>
        <p>${sub}</p>
      </div>
      ${badge}
    </div>`;
}

function skillForm(o: {
  title: TemplateResult | string;
  sub: string;
  badge: string;
  submit: () => unknown;
  reviewed: boolean;
  label: string;
  ready: boolean;
  reviewAgain: () => void;
  fields: TemplateResult;
  impact: TemplateResult;
}): TemplateResult {
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void o.submit();
      }}
    >
      ${formHeading(o.title, o.sub, html`<span class="badge">${o.badge}</span>`)} ${o.fields}
      ${formError ? html`<div class="card-meta skill-shadowed">${formError}</div>` : nothing}
      ${o.reviewed ? html`<div class="skill-impact" role="alert">${o.impact}</div>` : nothing}
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${busy || !o.ready}
          @click=${(event: MouseEvent) => {
            if (o.reviewed && event.detail > 1) event.preventDefault();
          }}
        >
          ${busy ? "Saving…" : o.label}
        </button>
        ${
          o.reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${busy}
                @click=${() => {
                  o.reviewAgain();
                  drawSkills();
                }}
              >
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${busy} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  page.syncUrl(null);
  if (creating || editingTarget) {
    page.paint(creating ? creatorPane() : editorPane(), () => drawSkills());
    return;
  }
  const scopedScope = page.scope;
  const groups = filterSkillGroups(groupSkills(skillRows), filters).flatMap((group) => {
    const skills = group.skills.filter((skill) => !scopedScope || skill.scopeId === scopedScope);
    return skills.length ? [{ ...group, skills }] : [];
  });
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows = groups.map(({ skills }) => {
    const hasScopeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length > 1;
    return html`<section class="skill-group" aria-label=${`/${skills[0]?.name ?? "skill"}`}>
      ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
    </section>`;
  });
  const clearFilters = () => setFilters({ query: "", scope: "all", source: "all", status: "all" });
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = scopedScope ? "No skills in this context." : "No skills available yet.";
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>No skills match these filters.</span
      ><button class="btn" type="button" @click=${clearFilters}>Clear filters</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = "Loading skills…";
  }
  page.paint(
    html`${listPageTpl({
      title: "Skills",
      action: { label: "New skill", onClick: startCreate },
      search: {
        value: filters.query,
        placeholder: "Search skills…",
        onInput: (query) => setFilters({ query }),
      },
      filters: html`<div class="skill-registry-controls">
          ${listTabs(
            "Filter by skill status",
            [
              { value: "active" as const, label: "Active", count: counts.active },
              { value: "archived" as const, label: "Archived", count: counts.archived },
              { value: "all" as const, label: "All", count: counts.all },
            ],
            filters.status,
            (status) => setFilters({ status }),
          )}
          <div class="skill-filter-fields">
            ${listSelect(
              "Scope",
              filters.scope,
              [
                ["all", "All scopes"],
                ["personal", "Personal"],
                ["channel", "Channel"],
                ["group", "Project / group"],
                ["team", "Team"],
                ["org", "Organization"],
              ],
              (scope) => setFilters({ scope }),
            )}
            ${listSelect(
              "Source",
              filters.source,
              [
                ["all", "All sources"],
                ["native", "Local"],
                ["pack", "Skill packs"],
                ["overrides", "Overrides"],
              ],
              (source) => setFilters({ source }),
            )}
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${loading ? "Loading…" : `${filtered.length} skill${filtered.length === 1 ? "" : "s"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`}
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    () => drawSkills(),
  );
}

function dismissArchive(): HTMLElement | null {
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  setSkillsBackgroundInert(false);
  return target;
}

function setSkillsBackgroundInert(inert: boolean): void {
  page.host?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = dismissArchive();
  drawSkills();
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "skills") return;
    const fallback = skillButton(".skill-archive-trigger", target, document);
    restoreDialogFocus(target, () => fallback);
  });
}

function archiveDialog(skill: SkillItem): TemplateResult {
  const audience =
    skill.scope === "personal"
      ? "you"
      : `everyone in ${skill.scopeId ? scopeTitle(skill.scopeId) : `this ${skill.scope}`}`;
  return confirmDialogTpl({
    id: "skill-archive",
    title: html`Archive <bdi>/${skill.name}</bdi>?`,
    body: html`This version will stop being available to ${audience}. If it overrides a broader
      <bdi>/${skill.name}</bdi>, that version becomes effective. Its history and assets are kept, and you can restore it
      later.`,
    confirm: deleting === skill.id ? "Archiving…" : "Archive skill",
    busy: deleting === skill.id,
    onCancel: closeArchiveDialog,
    onConfirm: () => void performArchive(skill),
  });
}

async function submitForm(draft: Draft, key: string, path: string, init: RequestInit, failure: string): Promise<void> {
  if (sharedScope(draft.scopeId) && draft.review !== key) {
    draft.review = key;
    return drawSkills();
  }
  busy = true;
  formError = "";
  const operation = ++mutationSeq;
  drawSkills();
  try {
    await api(path, init);
    if (operation !== mutationSeq) return void (await renderSkills());
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    editing = null;
    editingTarget = null;
    creating = null;
    busy = false;
    await renderSkills();
    if (operation === mutationSeq) restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (operation !== mutationSeq) return;
    formError = errMessage(e, failure);
    busy = false;
    drawSkills();
  }
}

async function saveEdit(): Promise<void> {
  const e = editing;
  if (!e || busy) return;
  const body = JSON.stringify({ description: e.description, body: e.body });
  const path = `/api/skills/${encodeURIComponent(e.id)}`;
  await submitForm(e, editKey(e), path, { method: "PUT", body }, "Failed to save skill.");
}

async function saveCreate(): Promise<void> {
  const c = creating;
  if (!c || busy) return;
  const [name, description, body] = [c.name.trim(), c.description.trim(), c.body.trim()];
  if (!name || !description || !body) {
    formError = "Name, description, and instructions are all required.";
    return drawSkills();
  }
  const payload = JSON.stringify({ name, description, body, scopeId: c.scopeId });
  await submitForm(c, createKey(c), "/api/skills", { method: "POST", body: payload }, "Failed to create skill.");
}

async function changeSkill(id: string, path: string, init: RequestInit, failure: string): Promise<boolean> {
  deleting = id;
  try {
    await api(`/api/skills/${encodeURIComponent(id)}${path}`, init);
    deleting = null;
    await renderSkills();
    return true;
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, failure);
    drawSkills();
    return false;
  }
}

async function deleteSkill(s: SkillItem, trigger?: HTMLElement): Promise<void> {
  if (!s.id || deleting) return;
  if (s.status === "archived")
    return void changeSkill(s.id, "/restore", { method: "POST", body: "{}" }, "Failed to restore skill.");
  archiveFocusTarget = trigger ?? activeElement();
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (page.host) focusDialogCancel(page.host);
  });
}

async function performArchive(s: SkillItem): Promise<void> {
  if (!s.id || deleting) return;
  const focusTarget = dismissArchive();
  deleting = s.id;
  skillsNotice = "";
  drawSkills();
  queueMicrotask(() => ($(".list-search input") ?? $(".list-page-action"))?.focus());
  if (await changeSkill(s.id, "", { method: "DELETE" }, "Failed to archive skill.")) return;
  requestAnimationFrame(() => {
    const fallback = skillButton(".skill-archive-trigger", focusTarget);
    restoreDialogFocus(focusTarget, () => fallback ?? $(".list-search input"));
  });
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  page.adoptScope();
  if (!page.host || page.host.parentElement !== appState.mainEl) dismissArchive();
  const seq = appState.viewRenderSeq;
  const request = ++refreshSeq;
  const wanted = page.pending;
  page.pending = null;
  skillsNotice = "";
  drawSkills(true);
  try {
    const [r, contexts] = await Promise.all([
      api<{ skills: SkillItem[] }>("/api/skills?includeShadowed=1"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch((e: unknown) => {
        swallow("web-ui: load skill scopes", e);
        return null;
      }),
    ]);
    if (request !== refreshSeq || seq !== appState.viewRenderSeq || appState.currentView !== "skills") return;
    skillRows = (r.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const personal = appState.me ? `personal:${appState.me.user}` : "";
    createScopes = [
      { scopeId: personal, name: "Personal (only you)" },
      ...(contexts?.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
    if (!contexts) skillsNotice = "Couldn't load your projects, so new skills can only be personal for now.";
  } catch (e) {
    if (request !== refreshSeq || seq !== appState.viewRenderSeq || appState.currentView !== "skills") return;
    skillsNotice = errMessage(e, "Failed to load skills.");
  }
  if (request !== refreshSeq) return;
  const skill = wanted ? skillRows.find((candidate) => candidate.id === wanted) : undefined;
  if (wanted && !skill) skillsNotice = "That skill wasn't found, or you don't have access to it.";
  if (skill) openSkill(skill);
  else drawSkills(false);
}
