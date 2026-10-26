import { html, nothing, type TemplateResult } from "lit";
import { KeyRound, Link, type IconNode } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { connectorLogo } from "./connector-logo";
import { CONNECTOR_LABELS } from "./connector-link";
import { appState } from "./shell";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { KeychainOperations } from "./keychain-state";
import { artifactPage, listPageTpl } from "./list-page";

interface ConnectorProvider {
  mcpLabel?: string;
  connected?: boolean;
  needsReconnect?: boolean;
  refreshError?: string;
  available?: boolean;
  hosts?: Array<{ host?: string } | string>;
}

interface KeychainCredential {
  id: string;
  service: string;
  kind?: string;
  envKey?: string;
  accountLabel?: string;
  host?: string;
  expiresAt?: number;
}

interface KeychainGrant {
  id: string;
  credentialId: string;
  audienceScopeId: string;
  mode: "once" | "standing";
  purpose: string;
  status: "active" | "revoked" | "used";
  expiresAt?: number;
}

interface KeychainAsk {
  credentialId: string;
  requesterScopeId: string;
  purpose: string;
  requestedMode?: "once" | "standing";
  expiresAt: number;
}

const freshKeychain = () => ({
  providers: {} as Record<string, ConnectorProvider>,
  credentials: [] as KeychainCredential[],
  connectorCredentials: [] as Array<{ credentialId: string; host: string }>,
  grants: [] as KeychainGrant[],
  asks: [] as KeychainAsk[],
  scopeNames: {} as Record<string, string>,
  notice: "",
  loadNotice: "",
  adding: null as { service: string; envKey: string; purpose: string } | null,
  dropUrl: null as string | null,
  confirmation: null as { title: string; body: string; action: string; run: () => Promise<void> } | null,
  opener: null as HTMLElement | null,
  connectorsLoading: false,
  keysLoading: false,
  connectorsLoaded: false,
  keysLoaded: false,
});
let kc = freshKeychain();
const keychainOperations = new KeychainOperations();

export function resetKeychainState(): void {
  keychainOperations.reset();
  kc = freshKeychain();
}

function isExpiredCredential(credential: Pick<KeychainCredential, "kind" | "expiresAt">): boolean {
  return (
    credential.kind !== "file" &&
    credential.kind !== "connector" &&
    credential.expiresAt !== undefined &&
    credential.expiresAt < Date.now()
  );
}

function isActiveGrant(grant: KeychainGrant, credential: Pick<KeychainCredential, "kind" | "expiresAt">): boolean {
  return (
    !isExpiredCredential(credential) &&
    grant.status === "active" &&
    (grant.expiresAt === undefined || grant.expiresAt > Date.now())
  );
}

const fmtDate = (ms?: number) => (ms ? new Date(ms).toLocaleDateString() : "");
const accessModeLabel = (mode?: "once" | "standing") => (mode === "once" ? "one-time" : "standing");

function accessRow(label: string, scope: string, detail: string, action: TemplateResult | string = ""): TemplateResult {
  return html`<div class="kc-access-row">
    <div>
      <span class="kc-access-label">${label}</span>
      <bdi><strong>${scopeName(scope)}</strong></bdi>
      <span>· ${detail}</span>
    </div>
    ${action}
  </div>`;
}

function credentialCard(c: KeychainCredential): TemplateResult {
  const subtitle = [c.accountLabel, c.host, c.envKey].filter(Boolean).join(" · ");
  const grants = kc.grants.filter((grant) => grant.credentialId === c.id && isActiveGrant(grant, c));
  const asks = kc.asks.filter((ask) => ask.credentialId === c.id);
  return html`
    <article class="kc-resource kc-credential">
      <div class="kc-resource-main">
        <div class="kc-resource-icon">${icon(KeyRound, 18)}</div>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>${c.service}</h3>
            ${isExpiredCredential(c) ? html`<span class="kc-state warning">Expired</span>` : ""}
          </div>
          ${subtitle ? html`<div class="kc-resource-meta">${subtitle}</div>` : ""}
        </div>
        <button
          class="kc-text-action danger"
          type="button"
          data-confirm-key=${`delete:${c.id}`}
          ?disabled=${keychainOperations.mutationInFlight}
          @click=${() => deleteCredential(c, grants)}
        >
          Delete
        </button>
      </div>
      ${
        asks.length
          ? html`<div class="kc-access-block pending">
              ${asks.map((ask) =>
                accessRow(
                  "Pending",
                  ask.requesterScopeId,
                  `${accessModeLabel(ask.requestedMode)} · ${ask.purpose} · expires ${fmtDate(ask.expiresAt)}`,
                ),
              )}
            </div>`
          : ""
      }
      ${grantsBlock(grants)}
    </article>
  `;
}

function grantsBlock(grants: KeychainGrant[]): TemplateResult | string {
  if (!grants.length) return "";
  return html`<div class="kc-access-block">
    ${grants.map((grant) =>
      accessRow(
        "Access",
        grant.audienceScopeId,
        `${accessModeLabel(grant.mode)} · ${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}`,
        html`<button
          class="kc-text-action"
          type="button"
          data-confirm-key=${`revoke:${grant.id}`}
          ?disabled=${keychainOperations.mutationInFlight}
          @click=${() => revokeGrant(grant)}
        >
          Revoke
        </button>`,
      ),
    )}
  </div>`;
}

function scopeName(scope: string): string {
  const resolved = kc.scopeNames[scope];
  if (resolved) return resolved;
  const [kind, ...rest] = scope.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "personal":
      return ref || "a personal DM";
    case "channel":
      return ref ? `a Slack channel (${ref})` : "a Slack channel";
    case "group":
      return "a group DM";
    case "team":
      return ref ? `a team (${ref})` : "a team";
    case "org":
      return "the whole org";
    default:
      return scope;
  }
}

function setAdding(draft: typeof kc.adding): void {
  kc.adding = draft;
  kc.dropUrl = null;
  drawConnectors();
}

function addCredentialCard(): TemplateResult {
  const draft = kc.adding!;
  const field = (key: keyof typeof draft, label: TemplateResult | string, placeholder: string, cls = "") =>
    html`<label class="skill-field ${cls}"
      ><span>${label}</span
      ><input
        class="skill-desc-input"
        placeholder=${placeholder}
        autocapitalize=${key === "envKey" ? "characters" : nothing}
        autocomplete=${key === "purpose" ? nothing : "off"}
        ?disabled=${keychainOperations.dropInFlight}
        .value=${draft[key]}
        @input=${(e: Event) => {
          draft[key] = (e.target as HTMLInputElement).value;
        }}
    /></label>`;
  return html`<section class="kc-add-card" aria-labelledby="kc-add-title">
    <div class="kc-panel-head">
      <div>
        <h2 id="kc-add-title">Add a credential</h2>
        <p>You’ll paste the secret on an encrypted one-time page next.</p>
      </div>
    </div>
    ${
      kc.dropUrl
        ? html`
            <div class="kc-success" role="status">
              <strong>Your one-time page is ready</strong><span>Open it in a new tab and paste the secret there.</span>
            </div>
            <div class="kc-form-actions">
              <a class="btn primary" href=${kc.dropUrl} target="_blank" rel="noopener noreferrer"
                >Open the one-time page</a
              ><button class="btn" type="button" @click=${() => setAdding(null)}>Done</button>
            </div>
          `
        : html`
            <div class="kc-form-grid">
              ${field("service", "Service", "Stripe")}
              ${field("envKey", html`Environment variable <em>optional</em>`, "STRIPE_API_KEY")}
              ${field("purpose", "Purpose", "What may the agent use this credential for?", "kc-purpose-field")}
            </div>
            <div class="kc-form-actions">
              <button
                class="btn"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => setAdding(null)}
              >
                Cancel</button
              ><button
                class="btn primary"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => void createDrop()}
              >
                ${keychainOperations.dropInFlight ? "Preparing…" : "Continue"}
              </button>
            </div>
          `
    }
  </section>`;
}

function confirmationCard(): TemplateResult {
  const pending = kc.confirmation!;
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeConfirmation()}
  >
    <article
      class="kc-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-body"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeConfirmation)}
    >
      <span class="kc-eyebrow danger">Check impact</span>
      <h2 id="kc-confirm-title">${pending.title}</h2>
      <p id="kc-confirm-body">${pending.body}</p>
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${closeConfirmation}>Cancel</button
        ><button class="btn danger" type="button" @click=${() => void pending.run()}>${pending.action}</button>
      </div>
    </article>
  </div>`;
}

function closeConfirmation(): void {
  const opener = kc.opener;
  const key = opener?.dataset.confirmKey;
  kc.confirmation = kc.opener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find(
          (element) => element.dataset.confirmKey === key,
        )
      : null,
  );
}

export function clearConnectorNotice(): void {
  kc.notice = "";
}

export function noteConnectorResult(provider: string, status: string): void {
  const name = CONNECTOR_LABELS[provider]?.name ?? provider;
  kc.notice = status === "connected" ? `${name}: connected.` : `${name}: connection failed.`;
}

const loadingPlaceholder = (label: string) => html`<div class="kc-loading"><span class="spinner"></span>${label}</div>`;

const emptyState = (glyph: IconNode, title: string, text: string, extra: TemplateResult | string = "") =>
  html`<div class="kc-empty">
    ${icon(glyph, 20)}
    <div><strong>${title}</strong><span>${text}</span></div>
    ${extra}
  </div>`;

const page = artifactPage("keychain", "keychain-page", "keychain");

function drawConnectors(): void {
  if (appState.currentView !== "keychain") return;
  const accountsLoading = kc.connectorsLoading && !kc.connectorsLoaded;
  const keysLoadingFresh = kc.keysLoading && !kc.keysLoaded;
  const loading = accountsLoading || keysLoadingFresh;
  const entries = Object.entries(kc.providers);
  const connectorCards = entries.map(([id, p]) => {
    const meta = CONNECTOR_LABELS[id] ?? { name: p.mcpLabel ?? id, hosts: "" };
    const connected = Boolean(p.connected);
    const needsReconnect = Boolean(p.needsReconnect);
    let connectionState: TemplateResult | string = html`<span class="kc-state neutral">Not connected</span>`;
    if (needsReconnect) connectionState = html`<span class="kc-state warning">Reconnect needed</span>`;
    else if (connected) connectionState = "";
    return html`
      <article class="kc-resource kc-account">
        <div class="kc-resource-main">
          ${connectorLogo(id)}
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>${meta.name}</h3>
              ${connectionState}
            </div>
            ${meta.hosts ? html`<div class="kc-resource-meta">${meta.hosts}</div>` : ""}
          </div>
          <div class="kc-resource-actions">
            ${p.available ? html`<button class="btn" type="button" @click=${() => void startConnector(id)}>${connected || needsReconnect ? "Reconnect" : "Connect account"}</button>` : ""}
            ${connected || needsReconnect ? html`<button class="kc-text-action danger" type="button" data-confirm-key=${`disconnect:${id}`} ?disabled=${keychainOperations.mutationInFlight} @click=${() => revokeConnector(id)}>Disconnect</button>` : ""}
          </div>
        </div>
        ${needsReconnect && p.refreshError ? html`<div class="kc-inline-warning" role="status">Refresh failed: ${p.refreshError}</div>` : ""}
        ${grantsBlock(providerGrants(p))}
      </article>
    `;
  });
  const startAdding = () => setAdding({ service: "", envKey: "", purpose: "" });
  let accountsContent: TemplateResult | TemplateResult[] = connectorCards;
  if (accountsLoading) accountsContent = loadingPlaceholder("Loading accounts\u2026");
  else if (!connectorCards.length)
    accountsContent = emptyState(
      Link,
      "No accounts available",
      "Your workspace has not configured any account providers yet.",
    );
  let credentialsContent: TemplateResult | TemplateResult[] = kc.credentials.map(credentialCard);
  if (keysLoadingFresh) credentialsContent = loadingPlaceholder("Loading credentials\u2026");
  else if (!kc.credentials.length)
    credentialsContent = emptyState(
      KeyRound,
      "No stored credentials",
      "Add one without pasting a secret into chat.",
      html`<button class="btn" type="button" @click=${startAdding}>Add credential</button>`,
    );
  if (!appState.mainEl) return;
  const section = (
    id: string,
    heading: string,
    count: number,
    content: TemplateResult | TemplateResult[],
    sectionLoading: boolean,
  ) =>
    html`<section class="kc-section" aria-labelledby=${id}>
      <div class="kc-section-head">
        <div class="kc-section-title">
          <h2 id=${id}>${heading}</h2>
          <span>${sectionLoading ? "…" : count}</span>
        </div>
      </div>
      <div class="kc-resource-list">${content}</div>
    </section>`;
  const rows: TemplateResult[] = [];
  const notice = [kc.notice, kc.loadNotice].filter(Boolean).join(" ");
  if (notice || loading)
    rows.push(html`<div class="status" role="status">${loading ? "Loading your keychain…" : notice}</div>`);
  if (kc.adding) rows.push(addCredentialCard());
  rows.push(
    section("kc-accounts-title", "Linked accounts", entries.length, accountsContent, accountsLoading),
    section("kc-credentials-title", "Stored credentials", kc.credentials.length, credentialsContent, keysLoadingFresh),
  );
  const host = page.paint(
    html`
      <div class="kc-page-content" ?inert=${Boolean(kc.confirmation)}>
        ${listPageTpl({
          title: "Keychain",
          action: { label: "Add credential", onClick: startAdding },
          rows,
          empty: "Nothing in your keychain yet.",
        })}
      </div>
      ${kc.confirmation ? confirmationCard() : ""}
    `,
    () => drawConnectors(),
  );
  if (kc.confirmation && host) focusDialogCancel(host);
}

export async function renderConnectors(): Promise<void> {
  if (appState.currentView !== "keychain") return;
  const seq = appState.viewRenderSeq;
  const loadId = keychainOperations.beginLoad();
  kc.connectorsLoading = kc.keysLoading = true;
  drawConnectors();
  const fresh = () =>
    seq === appState.viewRenderSeq && keychainOperations.isCurrentLoad(loadId) && appState.currentView === "keychain";
  const notices: string[] = [];
  kc.loadNotice = "";
  const load = async <T>(path: string, failure: string, apply: (value: T) => void, finish: () => void) => {
    try {
      const value = await api<T>(path);
      if (fresh()) apply(value);
    } catch (reason) {
      if (fresh()) notices.push(errMessage(reason, failure));
    }
    if (!fresh()) return;
    finish();
    kc.loadNotice = notices.join(" ");
    drawConnectors();
  };
  await Promise.all([
    load<{ providers?: Record<string, ConnectorProvider> }>(
      "/api/connectors",
      "Failed to load connectors.",
      (value) => {
        kc.providers = Object.fromEntries(
          Object.entries(value.providers ?? {}).filter(([, p]) => p.available || p.connected || p.needsReconnect),
        );
        kc.connectorsLoaded = true;
      },
      () => (kc.connectorsLoading = false),
    ),
    load<{
      credentials?: KeychainCredential[];
      connectorCredentials?: typeof kc.connectorCredentials;
      grants?: KeychainGrant[];
      asks?: KeychainAsk[];
      scopeNames?: Record<string, string>;
    }>(
      "/api/keychain/overview",
      "Failed to load stored keys.",
      (value) => {
        kc.credentials = (value.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
        kc.connectorCredentials = value.connectorCredentials ?? [];
        kc.grants = value.grants ?? [];
        kc.asks = value.asks ?? [];
        kc.scopeNames = value.scopeNames ?? {};
        kc.keysLoaded = true;
      },
      () => (kc.keysLoading = false),
    ),
  ]);
}

function confirmMutation(
  title: string,
  body: string,
  action: string,
  request: () => Promise<unknown>,
  failure: string,
  success = "",
): void {
  kc.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  kc.confirmation = {
    title,
    body,
    action,
    run: async () => {
      const operation = keychainOperations.beginMutation();
      kc.confirmation = kc.opener = null;
      if (!operation) {
        kc.notice = "Another keychain change is still in progress.";
        return drawConnectors();
      }
      drawConnectors();
      const current = () => keychainOperations.isCurrentEpoch(operation.epoch);
      kc.notice = "";
      try {
        await request();
        if (current()) kc.notice = success;
      } catch (e) {
        if (current()) kc.notice = errMessage(e, failure);
      }
      try {
        if (current()) await renderConnectors();
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

function deleteCredential(credential: KeychainCredential, active: KeychainGrant[]): void {
  const impact = active.length
    ? ` It will immediately revoke ${active.length} active grant${active.length === 1 ? "" : "s"}: ${active.map((grant) => scopeName(grant.audienceScopeId)).join(", ")}.`
    : "";
  confirmMutation(
    `Delete ${credential.service}?`,
    `${impact} Automations using it may stop working. The credential cannot be recovered.`.trim(),
    "Delete credential",
    () => api(`/api/keychain/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" }),
    "Could not delete the key.",
  );
}

function revokeGrant(grant: KeychainGrant): void {
  confirmMutation(
    `Revoke access for ${scopeName(grant.audienceScopeId)}?`,
    `This ${grant.mode === "standing" ? "standing" : "one-time"} access ends immediately. Automations using it may stop working.`,
    "Revoke access",
    () => api(`/api/keychain/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST", body: "{}" }),
    "Could not revoke access.",
    "Access revoked ✓",
  );
}

function revokeConnector(provider: string): void {
  const active = providerGrants(kc.providers[provider]);
  const impact = active.length
    ? ` It will also stop ${active.length} active credential grant${active.length === 1 ? "" : "s"} for this account.`
    : "";
  confirmMutation(
    `Disconnect ${CONNECTOR_LABELS[provider]?.name ?? provider}?`,
    `${impact} Automations using this account may stop working.`.trim(),
    "Disconnect account",
    () => api("/api/connectors/revoke", { method: "POST", body: JSON.stringify({ provider }) }),
    "Could not disconnect.",
  );
}

async function createDrop(): Promise<void> {
  if (keychainOperations.dropInFlight) return;
  if (!kc.adding?.service.trim() || !kc.adding.purpose.trim()) {
    kc.notice = "Service and purpose are required.";
    return drawConnectors();
  }
  const submittedDraft = { ...kc.adding };
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(submittedDraft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("No one-time page URL was returned.");
    kc.dropUrl = result.url;
    kc.notice = "Your one-time page is ready.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    kc.notice = errMessage(e, "Could not create the one-time page.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function startConnector(provider: string): Promise<void> {
  const stateEpoch = keychainOperations.captureEpoch();
  kc.notice = "";
  try {
    const r = await api<{ authorizeUrl?: string }>(`/api/connectors/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (r.authorizeUrl) {
      location.href = r.authorizeUrl;
      return;
    }
    kc.notice = "No authorization URL was returned.";
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    kc.notice = errMessage(e, "Could not start the connector.");
  }
  drawConnectors();
}

function providerGrants(p: ConnectorProvider | undefined): KeychainGrant[] {
  const hosts = new Set((p?.hosts ?? []).map((entry) => (typeof entry === "string" ? entry : entry.host)));
  const ids = new Set(kc.connectorCredentials.filter((c) => c.host && hosts.has(c.host)).map((c) => c.credentialId));
  return kc.grants.filter((grant) => ids.has(grant.credentialId) && isActiveGrant(grant, { kind: "connector" }));
}
