import { openDeploymentPermissions } from "./deploy-permissions";
import { html, nothing, render, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { Archive, Check, Copy, ExternalLink, Plus, RotateCcw, Trash2, X } from "lucide";
import { api, withBase } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { copyText, relTime } from "./ui";
import { icon } from "./icons";
import { artifactPage, iconBtn, listBackLink, listPageTpl, ownershipTabs } from "./list-page";
import { confirmDialogTpl } from "./dialog-focus";
import { ensureContexts, scopeChip } from "./contexts";
import { appState } from "./shell";
import { focusDialogCancel, restoreDialogFocus } from "./dialog-focus";
import {
  deploymentCanManage as canManage,
  deploymentInScope,
  deploymentLatestAt,
  deploymentSlug,
  deploymentTab,
  deploymentTitle,
  filterDeployments,
  friendlyPrincipal,
  type DeploymentTab,
  type DeploymentView,
} from "./deploy-view";
import { tip } from "./tooltip";

type DeployEditField = "displayName" | "name" | "embedAncestors";

const DEPLOY_EDIT_FIELDS: Record<DeployEditField, { endpoint: string; savedValue: (d: DeploymentView) => string }> = {
  displayName: { endpoint: "display-name", savedValue: (d) => d.displayName ?? "" },
  name: { endpoint: "name", savedValue: (d) => d.name ?? "" },
  embedAncestors: { endpoint: "embed-ancestors", savedValue: (d) => (d.embedAncestors ?? []).join("\n") },
};

let deployList: DeploymentView[] = [];
let detailNotice: { id: string; text: string } | null = null;
let deployTab: DeploymentTab = "yours";
const page = artifactPage("deploys", "deploys-page", "apps");
let activeDeploy: DeploymentView | null = null;
let visibleVersionCount = 10;
let editingDeploy: { id: string; field: DeployEditField } | null = null;
let deployDraft = "";
let embedDraft: string[] = [];
let deploySaving = false;
let archiveCandidate: DeploymentView | null = null;
let restoreArchiveFocus = false;
let deployToast: { deployment: DeploymentView; text: string; undo?: boolean } | null = null;

function statusTpl(d: DeploymentView): TemplateResult {
  const status = d.status || "unknown";
  const deploying =
    status === "running" &&
    d.appliedVersion !== undefined &&
    d.currentVersion !== undefined &&
    d.appliedVersion !== d.currentVersion;
  let cls = status === "running" || status === "archived" ? status : "stopped";
  let label = status.charAt(0).toLocaleUpperCase() + status.slice(1);
  if (deploying) [cls, label] = ["deploying", "Deploying"];
  return html`<span class="deploy-status ${cls}"><span></span>${label}</span>`;
}

function permissionBadge(d: DeploymentView): TemplateResult {
  const manage = canManage(d);
  const title = manage
    ? "You own this app or have permission to manage it."
    : "This app is shared with a context you can access. You can open and clone it, but not change it.";
  return html`<span class="deploy-permission ${manage ? "manage" : "view"}" ${tip(title)}
    >${manage ? "Can manage" : "Can view"}</span
  >`;
}

function ownerLabel(d: DeploymentView): string {
  if (d.ownerScopeId === `personal:${appState.me?.user}`) return "Owned by you";
  if (d.ownerScopeId?.startsWith("personal:"))
    return `Owned by ${friendlyPrincipal(d.ownerScopeId.slice("personal:".length))}`;
  if (d.ownerScopeId?.startsWith("org:")) return "Organization";
  return "Shared context";
}

function deploymentRow(d: DeploymentView): TemplateResult {
  const running = d.status === "running";
  const title = html`
    <span class="deploy-row-title">
      <span class="list-row-title" dir="auto">${deploymentTitle(d)}</span>
    </span>
  `;
  return html`
    <div class="list-row deploy-row ${d.status === "archived" ? "deploy-row-archived" : ""}">
      ${
        running && d.webUrl
          ? html`<a
              class="deploy-row-main"
              href=${withBase(d.webUrl)}
              target="_blank"
              rel="noreferrer"
              aria-label=${`Open ${deploymentTitle(d)}`}
              >${title}</a
            >`
          : html`<span class="deploy-row-main">${title}</span>`
      }
      <div class="deploy-row-actions" aria-label="App status and actions">
        ${statusTpl(d)}
        <button
          class="btn deploy-manage"
          type="button"
          aria-label=${`Manage ${deploymentTitle(d)}`}
          @click=${() => void openDeploy(d)}
        >
          Manage
        </button>
      </div>
    </div>
  `;
}

function drawDeploysPage(): void {
  if (appState.currentView !== "deploys" || !appState.mainEl) return;
  activeDeploy = null;
  const viewer = appState.me?.user;
  const rows = filterDeployments(deployList, { tab: deployTab, scope: page.scope, query: page.query, viewer });
  const tabHasApps = deployList.some((d) => deploymentTab(d, viewer) === deployTab && deploymentInScope(d, page.scope));
  let empty = { yours: "No apps of your own yet.", shared: "No apps shared with you.", archived: "Nothing archived." }[
    deployTab
  ];
  if (!deployList.length && page.notice) empty = page.notice;
  else if (page.loading && deployList.length === 0) empty = "Loading apps…";
  else if (page.query && tabHasApps) empty = "No apps match your search.";
  else if (page.scope) empty = "No apps in this context.";
  const counts = { yours: 0, shared: 0, archived: 0 };
  for (const d of deployList) if (deploymentInScope(d, page.scope)) counts[deploymentTab(d, viewer)]++;
  const content = deployList.length
    ? [
        ownershipTabs("App view", counts, deployTab, (tab) => {
          deployTab = tab;
          drawDeploysPage();
        }),
        ...(page.notice
          ? [html`<div class="status deploy-list-notice" role="status" aria-live="polite">${page.notice}</div>`]
          : []),
        ...(rows.length
          ? rows.map(deploymentRow)
          : [html`<div class="empty compact cron-filter-empty">${empty}</div>`]),
      ]
    : [];
  page.paint(
    html`
      ${listPageTpl({
        title: "Apps",
        search: page.search("Search apps", drawDeploysPage),
        rows: content,
        empty,
      })}
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    drawDeploysPage,
  );
}

export function openDeployById(id: string): void {
  page.pending = id;
}

async function openDeploy(d: DeploymentView): Promise<void> {
  visibleVersionCount = 10;
  editingDeploy = null;
  deployDraft = "";
  detailNotice = null;
  activeDeploy = d;
  page.syncUrl(d.id);
  drawDeployDetail(d, true);
  try {
    const response = await api<{ deployment?: DeploymentView }>(`/api/deployments/${encodeURIComponent(d.id)}`);
    if (appState.currentView !== "deploys" || activeDeploy?.id !== d.id) return;
    activeDeploy = response.deployment ?? d;
    drawDeployDetail(activeDeploy);
  } catch (error) {
    if (activeDeploy?.id !== d.id) return;
    detailNotice = { id: d.id, text: errMessage(error, "Could not load app details.") };
    drawDeployDetail(d);
  }
}

function drawDeployDetail(d: DeploymentView, loading = false): void {
  if (appState.currentView !== "deploys" || !appState.mainEl || activeDeploy?.id !== d.id) return;
  const host = appState.mainEl.querySelector<HTMLElement>(".deploy-detail-pane") ?? document.createElement("div");
  host.className = "resource-pane deploy-detail-pane";
  const versions = [...(d.versions ?? [])].sort((a, b) => b.version - a.version);
  const running = d.status === "running";
  const contextScope = d.createdInScope ?? d.ownerScopeId;
  render(
    html`
      <div class="resource-detail deploy-detail">
        ${listBackLink("Apps", returnToDeploysList)}
        <div class="resource-heading deploy-detail-heading">
          <div>
            <div class="deploy-heading-title">
              <h2 dir="auto">${deploymentTitle(d)}</h2>
              ${statusTpl(d)}
            </div>
            <div class="deploy-detail-url">/d/${deploymentSlug(d)}/</div>
          </div>
          <div class="actions">
            ${running && d.webUrl ? html`<a class="btn primary" href=${withBase(d.webUrl)} target="_blank" rel="noreferrer">Open app ${icon(ExternalLink, 14)}</a>` : nothing}
            ${d.webUrl ? html`<button class="btn" type="button" @click=${(event: Event) => void copyText(new URL(withBase(d.webUrl!), window.location.href).href, event.currentTarget as HTMLButtonElement)}>${icon(Copy, 14)}<span>Copy URL</span></button>` : nothing}
          </div>
        </div>
        ${loading ? html`<div class="hint">Loading authoritative app details…</div>` : nothing}
        ${detailNotice?.id === d.id ? html`<div class="status">${detailNotice.text}</div>` : nothing}

        <div class="deploy-summary">
          <span>Live v${d.appliedVersion ?? d.currentVersion ?? "—"}</span>
          ${d.currentVersion !== undefined && d.appliedVersion !== undefined && d.currentVersion !== d.appliedVersion ? html`<span>Latest v${d.currentVersion}</span>` : nothing}
          ${deploymentLatestAt(d) ? html`<span ${tip(new Date(deploymentLatestAt(d)).toLocaleString())}>Updated ${relTime(deploymentLatestAt(d))}</span>` : nothing}
        </div>
        <div class="deploy-access-line">
          <div>
            <span>${ownerLabel(d)}</span>
            ${contextScope && contextScope !== d.ownerScopeId ? html`<span class="deploy-secondary-context">Created in ${scopeChip(contextScope)}</span>` : nothing}
            ${d.createdBy && d.ownerScopeId !== `personal:${d.createdBy}` ? html`<span class="deploy-secondary-context">Created by ${friendlyPrincipal(d.createdBy)}</span>` : nothing}
          </div>
          ${d.ownerScopeId === `personal:${appState.me?.user}` ? html`<button class="btn" type="button" @click=${() => void openDeploymentPermissions(d.id, deploymentTitle(d), d.ownerScopeId!)}>Permissions</button>` : permissionBadge(d)}
        </div>

        ${
          canManage(d)
            ? html`<section class="deploy-detail-section">
                <h3>Settings</h3>
                ${settingRow(d, "displayName", "Display name", "Shown in the app bar and app list.", html`<span dir="auto">${deploymentTitle(d)}</span>`, "Edit")}
                ${settingRow(d, "name", "App URL", "Changes the app URL. Existing links do not redirect.", html`<code>/d/${deploymentSlug(d)}/</code>`, "Change")}
                ${settingRow(d, "embedAncestors", "Embedding", "Sites allowed to show this app inside their own page. Every frame between the app and the browser tab must be listed.", embedAncestorsSummary(d), d.embedAncestors?.length ? "Change" : "Allow")}
                <div class="actions deploy-danger-actions">
                  ${
                    d.status === "archived"
                      ? html`<button class="btn" type="button" @click=${() => void restoreDeploy(d)}>
                          ${icon(RotateCcw, 14)}<span>Restore deployment</span>
                        </button>`
                      : html`<button
                          class="btn danger deploy-archive-trigger"
                          data-deployment-id=${d.id}
                          type="button"
                          @click=${() => requestArchive(d)}
                        >
                          ${icon(Archive, 14)}<span>Archive deployment</span>
                        </button>`
                  }
                </div>
              </section>`
            : nothing
        }

        <section class="deploy-detail-section">
          <h3>Version history</h3>
          ${
            versions.length
              ? html`<div class="deploy-version-list">
                  ${versions.slice(0, visibleVersionCount).map(
                    (version) => html`
                      <div class="deploy-version-row">
                        <div>
                          <strong>v${version.version}</strong
                          >${version.version === d.appliedVersion ? html`<span class="badge ok">Live</span>` : nothing}${version.version === d.currentVersion && version.version !== d.appliedVersion ? html`<span class="badge">Latest</span>` : nothing}
                        </div>
                        <div>
                          <span>${new Date(version.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    `,
                  )}
                </div>`
              : html`<div class="empty compact">No version history available.</div>`
          }
          ${
            versions.length > visibleVersionCount
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => {
                    visibleVersionCount += 10;
                    drawDeployDetail(d);
                  }}
                >
                  Show older versions
                </button>`
              : nothing
          }
        </section>
      </div>
      ${archiveCandidate ? archiveDialog(archiveCandidate) : nothing} ${deployToast ? undoToast(deployToast) : nothing}
    `,
    host,
  );
  if (host.parentElement !== appState.mainEl) appState.mainEl.replaceChildren(host);
}

function settingRow(
  d: DeploymentView,
  field: DeployEditField,
  title: string,
  note: string,
  value: TemplateResult,
  action: string,
): TemplateResult {
  const editing = editingDeploy?.id === d.id && editingDeploy.field === field;
  return html`<div class="deploy-setting-row">
    <div><strong>${title}</strong><span>${note}</span></div>
    ${
      editing
        ? deployEditForm(d, field)
        : html`<div class="deploy-setting-value">
            ${value}<button class="btn" type="button" @click=${() => startEditDeploy(d, field)}>${action}</button>
          </div>`
    }
  </div>`;
}

function returnToDeploysList(): void {
  detailNotice = null;
  activeDeploy = null;
  page.syncUrl(null);
  cancelEditDeploy();
}

function embedAncestorsSummary(d: DeploymentView): TemplateResult {
  const origins = d.embedAncestors ?? [];
  if (!origins.length) return html`<span class="deploy-embed-empty">Not embeddable</span>`;
  return html`<span class="deploy-embed-origins">${origins.map((origin) => html`<code>${origin}</code>`)}</span>`;
}

function submitEdit(d: DeploymentView): (event: SubmitEvent) => void {
  return (event) => {
    event.preventDefault();
    void commitEditDeploy(d);
  };
}

function deployEditForm(d: DeploymentView, field: DeployEditField): TemplateResult {
  if (field === "embedAncestors") return deployEmbedForm(d);
  const slug = field === "name";
  return html`
    <form class="deploy-edit-form" @submit=${submitEdit(d)}>
      <label>
        <span class="deploy-slug-input ${slug ? "" : "name"}"
          >${slug ? html`<span>/d/</span>` : nothing}<input
            class="deploy-edit-input"
            aria-label=${slug ? "URL slug" : "Display name"}
            ?disabled=${deploySaving}
            .value=${live(deployDraft)}
            @input=${(event: InputEvent) => {
              deployDraft = (event.currentTarget as HTMLInputElement).value;
            }}
            @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditDeploy()}
          />${slug ? html`<span>/</span>` : nothing}</span
        >
      </label>
      ${saveCancel()}
    </form>
  `;
}

function deployEmbedForm(d: DeploymentView): TemplateResult {
  const setRow = (index: number, value: string) => {
    embedDraft = embedDraft.map((row, i) => (i === index ? value : row));
  };
  const removeRow = (index: number) => {
    embedDraft = embedDraft.filter((_, i) => i !== index);
    if (!embedDraft.length) embedDraft = [""];
    drawDeployDetail(d);
    focusEmbedRow(Math.min(index, embedDraft.length - 1));
  };
  const addRow = () => {
    embedDraft = [...embedDraft, ""];
    drawDeployDetail(d);
    focusEmbedRow(embedDraft.length - 1);
  };
  return html`
    <form class="deploy-embed-editor" @submit=${submitEdit(d)}>
      <ul class="deploy-embed-list">
        ${embedDraft.map(
          (row, index) => html`
            <li>
              <input
                class="deploy-edit-input deploy-embed-input"
                data-embed-row=${index}
                aria-label="Site allowed to embed this app"
                spellcheck="false"
                placeholder="https://tools.example.com"
                ?disabled=${deploySaving}
                .value=${live(row)}
                @input=${(event: InputEvent) => setRow(index, (event.currentTarget as HTMLInputElement).value)}
                @keydown=${(event: KeyboardEvent) => event.key === "Escape" && cancelEditDeploy()}
              />
              ${iconBtn("Remove", Trash2, () => removeRow(index), { aria: "Remove this site", disabled: deploySaving })}
            </li>
          `,
        )}
      </ul>
      <div class="deploy-embed-actions">
        <button class="btn" type="button" ?disabled=${deploySaving} @click=${addRow}>
          ${icon(Plus, 14)}<span>Add site</span>
        </button>
        <span class="spacer"></span>
        ${saveCancel()}
      </div>
      <div class="hint deploy-embed-hint">
        An https origin each, e.g. <code>https://tools.example.com</code> or <code>https://*.example.com</code>. Save
        with none listed to forbid embedding again.
      </div>
    </form>
  `;
}

function saveCancel(): TemplateResult {
  return html`${iconBtn("Save", Check, undefined, { submit: true, disabled: deploySaving })}
  ${iconBtn("Cancel", X, cancelEditDeploy, { disabled: deploySaving })}`;
}

function focusEmbedRow(index: number): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>(`[data-embed-row="${index}"]`)?.focus();
  });
}

function startEditDeploy(d: DeploymentView, field: DeployEditField): void {
  editingDeploy = { id: d.id, field };
  if (field === "embedAncestors") embedDraft = [...(d.embedAncestors ?? []), ""];
  else deployDraft = DEPLOY_EDIT_FIELDS[field].savedValue(d);
  detailNotice = null;
  drawDeployDetail(d);
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>(".deploy-edit-input");
    input?.focus();
    input?.select();
  });
}

function cancelEditDeploy(): void {
  editingDeploy = null;
  deployDraft = "";
  embedDraft = [];
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

async function commitEditDeploy(d: DeploymentView): Promise<void> {
  if (!editingDeploy || deploySaving) return;
  const field = editingDeploy.field;
  const value = deployDraft.trim();
  const embedAncestors =
    field === "embedAncestors" ? [...new Set(embedDraft.map((row) => row.trim()).filter(Boolean))] : [];
  const current = DEPLOY_EDIT_FIELDS[field].savedValue(d);
  const next = field === "embedAncestors" ? embedAncestors.join("\n") : value;
  if (next === current) return cancelEditDeploy();
  if (field === "name" && !value) {
    detailNotice = { id: d.id, text: "A URL slug is required." };
    return drawDeployDetail(d);
  }
  deploySaving = true;
  drawDeployDetail(d);
  try {
    await api(`/api/deployments/${encodeURIComponent(d.id)}/${DEPLOY_EDIT_FIELDS[field].endpoint}`, {
      method: "POST",
      body: JSON.stringify({ [field]: field === "embedAncestors" ? embedAncestors : value }),
    });
    editingDeploy = null;
    deployDraft = "";
    embedDraft = [];
    deploySaving = false;
    await refreshDeployments();
    const updated = deployList.find((item) => item.id === d.id) ?? d;
    if (actionView(d.id) === "target") {
      await openDeploy(updated);
    } else {
      deployToast = { deployment: updated, text: `${deploymentTitle(updated)} settings saved.` };
      drawCurrentDeployView();
    }
  } catch (error) {
    deployFailed(d, errMessage(error, "Could not save app settings."));
  }
}

function requestArchive(d: DeploymentView): void {
  restoreArchiveFocus = true;
  archiveCandidate = d;
  drawCurrentDeployView();
  setDeployBackgroundInert(true);
  requestAnimationFrame(() => {
    if (appState.currentView !== "deploys" || archiveCandidate?.id !== d.id) return;
    focusDialogCancel(document);
  });
}

function closeArchiveDialog(): void {
  const restoreFocus = restoreArchiveFocus;
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  restoreArchiveFocus = false;
  drawCurrentDeployView();
  requestAnimationFrame(() => {
    if (!restoreFocus || appState.currentView !== "deploys" || archiveCandidate) return;
    restoreDialogFocus(null, () => document.querySelector<HTMLElement>(".deploy-archive-trigger"));
  });
}

function setDeployBackgroundInert(inert: boolean): void {
  if (appState.currentView !== "deploys") return;
  appState.mainEl
    ?.querySelectorAll<HTMLElement>(".list-page-head, .list-search, .list-rows, .deploy-detail, .deploy-toast")
    .forEach((element) => {
      element.inert = inert;
    });
}

function deployFailed(d: DeploymentView, message: string): void {
  deploySaving = false;
  if (actionView(d.id) === "target") {
    detailNotice = { id: d.id, text: message };
    drawDeployDetail(activeDeploy!);
  } else {
    page.notice = "";
    deployToast = { deployment: d, text: message };
    drawCurrentDeployView();
  }
}

function drawCurrentDeployView(): void {
  if (appState.currentView !== "deploys") return;
  if (activeDeploy) drawDeployDetail(activeDeploy);
  else drawDeploysPage();
}

function actionView(targetId: string): "target" | "other" | "list" | "away" {
  if (appState.currentView !== "deploys") return "away";
  if (!activeDeploy) return "list";
  return activeDeploy.id === targetId ? "target" : "other";
}

function archiveDialog(d: DeploymentView): TemplateResult {
  return confirmDialogTpl({
    id: "deploy-archive",
    title: html`Archive <bdi>${deploymentTitle(d)}</bdi>?`,
    body: "This takes the app offline immediately, so its current URL will stop working. Its source and version history are kept, and you can restore it later.",
    confirm: "Archive and take offline",
    busy: deploySaving,
    onCancel: closeArchiveDialog,
    onConfirm: () => void archiveDeploy(d),
  });
}

async function archiveDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  deploySaving = true;
  if (activeDeploy?.id === d.id) detailNotice = { id: d.id, text: "Archiving deployment…" };
  else page.notice = "Archiving deployment…";
  setDeployBackgroundInert(false);
  archiveCandidate = null;
  drawCurrentDeployView();
  try {
    await api(`/api/deployments/${encodeURIComponent(d.id)}/archive`, { method: "POST" });
    deploySaving = false;
    deployToast = {
      deployment: { ...d, status: "archived" },
      text: `${deploymentTitle(d)} is offline and archived.`,
      undo: true,
    };
    await refreshDeployments();
    const destination = actionView(d.id);
    if (destination === "target" || destination === "list") {
      activeDeploy = null;
      deployTab = "yours";
    }
    drawCurrentDeployView();
  } catch (error) {
    deployFailed(d, errMessage(error, "Could not archive deployment."));
  }
}

async function restoreDeploy(d: DeploymentView): Promise<void> {
  if (deploySaving) return;
  const restoringActive = activeDeploy?.id === d.id;
  deploySaving = true;
  if (restoringActive) detailNotice = { id: d.id, text: "Restoring deployment…" };
  else if (!activeDeploy) page.notice = "Restoring deployment…";
  if (restoringActive || !activeDeploy) drawCurrentDeployView();
  try {
    const response = await api<{ deployment?: DeploymentView }>(
      `/api/deployments/${encodeURIComponent(d.id)}/restore`,
      { method: "POST" },
    );
    deploySaving = false;
    const optimistic = { ...(response.deployment ?? d), status: "running" };
    deployToast = { deployment: optimistic, text: `${deploymentTitle(d)} is restored and running.` };
    const failed = !(await refreshDeployments());
    const restored = (!failed && deployList.find((item) => item.id === d.id)) || optimistic;
    if (failed) deployList = [restored, ...deployList.filter((item) => item.id !== restored.id)];
    const destination = actionView(d.id);
    if (destination === "target" || destination === "list") deployTab = deploymentTab(restored, appState.me?.user);
    if (destination === "target") await openDeploy(restored);
    else drawCurrentDeployView();
  } catch (error) {
    deployFailed(d, errMessage(error, "Could not restore deployment."));
  }
}

function undoToast(toast: { deployment: DeploymentView; text: string; undo?: boolean }): TemplateResult {
  const archived = toast.undo && toast.deployment.status === "archived";
  return html`<div class="deploy-toast" role="status">
    <span>${toast.text}</span
    >${archived ? html`<button type="button" ?disabled=${deploySaving} @click=${() => void restoreDeploy(toast.deployment)}>Undo</button>` : nothing}${iconBtn(
      "Dismiss",
      X,
      () => {
        deployToast = null;
        drawCurrentDeployView();
      },
      { aria: "Dismiss notification" },
    )}
  </div>`;
}

function refreshDeployments(): Promise<boolean> {
  return page.refresh(async () => {
    deployList = (await api<{ deployments?: DeploymentView[] }>("/api/deployments")).deployments ?? [];
  }, "Failed to load apps.");
}

export async function renderDeploys(): Promise<void> {
  if (appState.currentView !== "deploys") return;
  const requestedId = page.pending;
  page.pending = null;
  archiveCandidate = null;
  restoreArchiveFocus = false;
  setDeployBackgroundInert(false);
  page.adoptScope();
  const seq = appState.viewRenderSeq;
  await ensureContexts();
  page.loading = deployList.length === 0;
  page.notice = "";
  drawDeploysPage();
  await refreshDeployments();
  if (seq !== appState.viewRenderSeq || appState.currentView !== "deploys") return;
  if (requestedId) {
    await openDeploy(deployList.find((d) => d.id === requestedId) ?? { id: requestedId });
  } else if (!activeDeploy) drawDeploysPage();
}
