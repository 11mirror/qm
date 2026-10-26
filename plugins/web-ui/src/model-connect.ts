import { html, render, nothing, type TemplateResult } from "lit";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { brandMark, brandName } from "./ui";
import { appState } from "./shell-state";
import { trapDialogFocus, restoreDialogFocus } from "./dialog-focus";

type ApiName = "anthropic" | "openai";
type ConnKind = "apikey" | "oauth";

const PROVIDERS = [
  {
    key: "claude",
    name: "Claude",
    apiName: "anthropic",
    mark: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5527h3.7442L10.5363 3.541Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
    keyPlaceholder: "sk-ant-…",
    subscription: "Claude Pro or Max",
    keyConsole: "platform.claude.com",
  },
  {
    key: "chatgpt",
    name: "ChatGPT / Codex",
    apiName: "openai",
    mark: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.5963 3.8558-5.8334-3.3874L15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
    keyPlaceholder: "sk-…",
    subscription: "ChatGPT Plus or Pro",
    keyConsole: "platform.openai.com",
  },
] as const;
type ProviderMeta = (typeof PROVIDERS)[number];

interface DevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

export interface StatusResponse {
  account: "company" | "personal" | ApiName;
  individualModelAuth: boolean;
  required: boolean;
  connections: { provider: ApiName; kind: ConnKind }[];
}

type Flow =
  | { kind: "pick" }
  | { kind: "claude"; authorizeUrl: string; verifier: string; code: string }
  | { kind: "chatgpt"; device: DevicePrompt }
  | { kind: "apikey"; value: string };

function fresh(intent: ProviderMeta | null) {
  return {
    intent,
    revision: 0,
    loaded: false,
    notice: "",
    controller: new AbortController(),
    required: false,
    personal: false,
    account: "company" as StatusResponse["account"],
    loading: true,
    error: "",
    busy: false,
    saving: false,
    connections: {} as Partial<Record<ApiName, ConnKind>>,
    open: null as ProviderMeta["key"] | null,
    method: null as "subscription" | "apikey" | null,
    flow: { kind: "pick" } as Flow,
    copied: false,
    pollTimer: null as ReturnType<typeof setTimeout> | null,
  };
}

type State = ReturnType<typeof fresh>;
let s: State;
let overlay: HTMLElement | null = null;
let opener: HTMLElement | null = null;

function stopPolling(): void {
  if (s.pollTimer) clearTimeout(s.pollTimer);
  s.pollTimer = null;
}

function retire(): void {
  stopPolling();
  s.controller.abort();
}

function resetFlow(): void {
  stopPolling();
  s.revision++;
  s.flow = { kind: "pick" };
  s.method = null;
  s.busy = false;
  s.error = "";
  s.notice = "";
}

function current(state: State, revision = state.revision): boolean {
  return s === state && !state.controller.signal.aborted && state.revision === revision;
}

export function syncModelAccount(status: StatusResponse): boolean {
  if (!appState.me) return false;
  appState.me.individualModelAuth = status.individualModelAuth === true;
  appState.me.modelAuthConnected = status.connections.some(
    (c) => status.account === "personal" || status.account === c.provider,
  );
  return true;
}

function applyStatus(status: StatusResponse): void {
  s.required = status.required === true;
  s.personal = status.individualModelAuth === true;
  s.account = status.account;
  s.connections = Object.fromEntries((status.connections ?? []).map((c) => [c.provider, c.kind]));
  s.loaded = true;
  if (syncModelAccount(status)) window.dispatchEvent(new CustomEvent("model-account-changed", { detail: status }));
}

async function load(): Promise<void> {
  const state = s;
  const revision = s.revision;
  s.loading = true;
  s.error = "";
  paint();
  try {
    const status = await api<StatusResponse>("/api/user-model-auth/status", { signal: state.controller.signal });
    if (!current(state, revision)) return;
    applyStatus(status);
  } catch (e) {
    if (!current(state, revision)) return;
    s.loaded = false;
    s.error = friendly(e);
  }
  s.loading = false;
  paint();
}

function friendly(e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: unknown } | null)?.error : undefined;
  if (code === "invalid_api_key") return "That API key was rejected — check it and try again.";
  if (typeof code === "string" && code.startsWith("oauth_"))
    return "Sign-in didn't complete. Try again — the code may have expired.";
  if (e instanceof TypeError || (e instanceof Error && e.name === "TimeoutError"))
    return "Couldn't reach the sign-in service. Check your connection and try again.";
  return errMessage(e);
}

async function write<T>(path: string, body: unknown, done: (result: T) => unknown): Promise<void> {
  const state = s;
  const revision = s.revision;
  s.error = "";
  s.busy = true;
  s.saving = true;
  paint();
  try {
    const result = await api<T>(`/api/user-model-auth/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });
    if (current(state, revision)) await done(result);
  } catch (e) {
    if (!current(state, revision)) return;
    s.busy = false;
    s.saving = false;
    s.error = friendly(e);
    paint();
  }
}

async function afterConnect(provider: ApiName): Promise<void> {
  const state = s;
  resetFlow();
  s.open = null;
  await load();
  if (!current(state)) return;
  s.saving = false;
  if (!s.loaded) return paint();
  await switchAccount("personal", provider);
  if (current(state) && !s.error && s.intent) closeManager();
}

async function pickSubscription(p: ProviderMeta): Promise<void> {
  if (s.busy || s.method === "subscription") return;
  resetFlow();
  const state = s;
  const revision = s.revision;
  s.method = "subscription";
  s.busy = true;
  paint();
  try {
    const start = await api<DevicePrompt & { authorizeUrl: string; verifier: string }>(
      `/api/user-model-auth/${p.key}/start`,
      { method: "POST", signal: state.controller.signal },
    );
    if (!current(state, revision)) return;
    s.flow = p.key === "claude" ? { kind: "claude", ...start, code: "" } : { kind: "chatgpt", device: start };
  } catch (e) {
    if (!current(state, revision)) return;
    s.error = friendly(e);
    s.method = null;
  }
  s.busy = false;
  paint();
  if (s.flow.kind === "chatgpt") void pollChatGPT();
}

function pickApiKey(): void {
  if (s.busy || s.method === "apikey") return;
  resetFlow();
  s.method = "apikey";
  s.flow = { kind: "apikey", value: "" };
  paint();
}

async function copyCode(code: string): Promise<void> {
  const state = s;
  const revision = s.revision;
  try {
    await navigator.clipboard.writeText(code);
    if (!current(state, revision)) return;
    s.copied = true;
    paint();
    setTimeout(() => {
      if (!current(state, revision)) return;
      s.copied = false;
      paint();
    }, 1600);
  } catch {
    if (!current(state, revision)) return;
    s.error = "Could not copy the code. Select it and copy it manually.";
    paint();
  }
}

function finishClaude(): Promise<void> | undefined {
  if (s.flow.kind !== "claude" || !s.flow.code.trim() || s.busy) return;
  const body = { code: s.flow.code.trim(), verifier: s.flow.verifier };
  return write("claude/complete", body, () => afterConnect("anthropic"));
}

async function pollChatGPT(): Promise<void> {
  if (s.flow.kind !== "chatgpt" || s.controller.signal.aborted) return;
  const state = s;
  const revision = s.revision;
  const device = s.flow.device;
  if (Date.now() > device.expiresAt) {
    resetFlow();
    s.error = "That code expired. Select Sign in to get a new code.";
    paint();
    return;
  }
  s.saving = true;
  paint();
  try {
    const r = await api<{ status: string }>("/api/user-model-auth/chatgpt/poll", {
      method: "POST",
      signal: state.controller.signal,
      body: JSON.stringify({ deviceAuthId: device.deviceAuthId, userCode: device.userCode }),
    });
    if (!current(state, revision)) return;
    if (r.status === "connected") return afterConnect("openai");
    s.pollTimer = setTimeout(pollChatGPT, Math.max(1000, device.intervalMs || 5000));
  } catch (e) {
    if (!current(state, revision)) return;
    resetFlow();
    s.error = friendly(e);
  }
  s.saving = false;
  paint();
}

function saveKey(p: ProviderMeta): Promise<void> | undefined {
  if (s.flow.kind !== "apikey" || !s.flow.value.trim() || s.busy) return;
  return write("api-key", { provider: p.key, apiKey: s.flow.value.trim() }, () => afterConnect(p.apiName));
}

function disconnect(p: ProviderMeta): Promise<void> | undefined {
  if (s.busy) return;
  resetFlow();
  s.open = null;
  const state = s;
  return write("disconnect", { provider: p.key }, async () => {
    resetFlow();
    await load();
    if (!current(state)) return;
    s.saving = false;
    s.notice =
      s.account === p.apiName
        ? "Account disconnected. Reconnect it or choose company access to continue chatting."
        : "Account disconnected.";
    paint();
  });
}

function switchAccount(account: "personal" | "company", provider?: ApiName): Promise<void> | undefined {
  if (s.busy || (account === "company" && !s.personal) || (account === "personal" && provider === s.account)) return;
  resetFlow();
  s.open = null;
  return write<StatusResponse>("account", { account, provider }, (status) => {
    applyStatus(status);
    s.notice =
      account === "company"
        ? "New chats will use company access."
        : `New chats will use your ${PROVIDERS.find((p) => p.apiName === provider)?.name} account.`;
    s.busy = false;
    s.saving = false;
    paint();
  });
}

function methodRow(title: string, detail: string, selected: boolean, onPick: () => void): TemplateResult {
  return html`
    <button
      type="button"
      class="mc-method ${selected ? "selected" : ""}"
      ?disabled=${s.busy || s.saving || (title === "Company access" && s.required)}
      aria-pressed=${selected}
      @click=${onPick}
    >
      <span class="mc-method-radio" aria-hidden="true"></span>
      <span class="mc-method-text">
        <span class="mc-method-title">${title}</span>
        <span class="mc-method-detail">${detail}</span>
      </span>
    </button>
  `;
}

function steps(p: ProviderMeta): TemplateResult | typeof nothing {
  const flow = s.flow;
  if (flow.kind === "claude")
    return html`
      <ol class="mc-steps">
        <li>
          <a class="btn" href=${flow.authorizeUrl} target="_blank" rel="noopener">Continue to Claude ↗</a>
        </li>
        <li>
          <label class="mc-field">
            <span>Authorization code</span>
            <input
              ?disabled=${s.busy || s.saving}
              .value=${flow.code}
              placeholder="Paste the code from Claude"
              autocomplete="off"
              spellcheck="false"
              @input=${(e: Event) => {
                flow.code = (e.target as HTMLInputElement).value;
                paint();
              }}
              @keydown=${(e: KeyboardEvent) => e.key === "Enter" && finishClaude()}
            />
          </label>
        </li>
        <li>
          <button class="btn primary" ?disabled=${!flow.code.trim() || s.busy} @click=${finishClaude}>
            ${s.busy ? "Connecting…" : "Connect account"}
          </button>
        </li>
      </ol>
    `;
  if (flow.kind === "chatgpt")
    return html`
      <ol class="mc-steps">
        <li>
          <button
            type="button"
            class="mc-code-btn ${s.copied ? "copied" : ""}"
            title="Copy code to clipboard"
            @click=${() => copyCode(flow.device.userCode)}
          >
            <span class="mc-code">${flow.device.userCode}</span>
            <span class="mc-copy-hint">${s.copied ? "Copied ✓" : "Click to copy"}</span>
          </button>
        </li>
        <li>
          <a class="btn" href=${flow.device.verificationUrl} target="_blank" rel="noopener"
            >Open chatgpt.com and paste it ↗</a
          >
        </li>
        <li>
          <span class="mc-waiting"><span class="mc-spinner" aria-hidden="true"></span>Waiting for your approval…</span>
        </li>
      </ol>
    `;
  if (flow.kind !== "apikey") return nothing;
  return html`
    <div class="mc-keyform">
      <label class="mc-field">
        <span
          >API key · from <a href=${`https://${p.keyConsole}`} target="_blank" rel="noopener">${p.keyConsole}</a></span
        >
        <input
          type="password"
          ?disabled=${s.busy || s.saving}
          .value=${flow.value}
          placeholder=${p.keyPlaceholder}
          autocomplete="off"
          @input=${(e: Event) => {
            flow.value = (e.target as HTMLInputElement).value;
            paint();
          }}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && saveKey(p)}
        />
      </label>
      <button class="btn primary" ?disabled=${!flow.value.trim() || s.busy} @click=${() => saveKey(p)}>
        ${s.busy ? "Checking…" : "Connect"}
      </button>
    </div>
  `;
}

function connectBody(p: ProviderMeta): TemplateResult {
  if (s.intent) {
    return html`<div class="mc-simple-flow">
      ${steps(p)} ${s.busy ? html`<p class="mc-waiting">Connecting…</p>` : nothing}
      ${!s.method ? html`<button class="btn primary" ?disabled=${s.saving} @click=${() => void pickSubscription(p)}>Sign in with ${p.name}</button>` : nothing}
      <button
        class="settings-theme-link"
        ?disabled=${s.busy || s.saving}
        @click=${() => (s.method === "apikey" ? void pickSubscription(p) : pickApiKey())}
      >
        ${s.method === "apikey" ? "Use my subscription instead" : "Use an API key instead"}
      </button>
    </div>`;
  }
  return html`
    <div class="mc-connect">
      ${methodRow(
        `Sign in with ${p.name}`,
        `Uses your ${p.subscription} subscription and its usage limits.`,
        s.method === "subscription",
        () => void pickSubscription(p),
      )}
      ${s.method === "subscription" ? steps(p) : nothing}
      ${methodRow(
        "Use an API key",
        `Paste a key from ${p.keyConsole} — usage is billed to the key.`,
        s.method === "apikey",
        pickApiKey,
      )}
      ${s.method === "apikey" ? steps(p) : nothing}
    </div>
  `;
}

function providerRow(p: ProviderMeta): TemplateResult {
  const kind = s.connections[p.apiName];
  const open = s.open === p.key;
  const inUse = s.account === p.apiName;
  let statusLine = `Chat with ${p.name} on your own account`;
  if (kind)
    statusLine = kind === "oauth" ? `Connected with your ${p.name} subscription` : "Connected with your API key";
  const action = kind
    ? html`<button
          class="btn"
          ?disabled=${s.busy || s.saving || inUse}
          @click=${() => switchAccount("personal", p.apiName)}
        >
          ${inUse ? "In use" : "Use account"}</button
        ><button class="btn mc-quiet-danger" ?disabled=${s.busy || s.saving} @click=${() => disconnect(p)}>
          ${s.busy ? "…" : "Disconnect"}
        </button>`
    : html`<button
        type=${open ? "button" : nothing}
        class="btn"
        ?disabled=${s.saving || (!open && s.busy)}
        @click=${() => {
          resetFlow();
          s.open = open ? null : p.key;
          paint();
        }}
      >
        ${open ? "Cancel" : "Connect"}
      </button>`;
  return html`
    <section class="mc-provider ${kind ? "connected" : ""} ${open ? "open" : ""}">
      <div class="mc-provider-row">
        <span class="mc-mark mc-mark-${p.key}" aria-hidden="true"
          ><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d=${p.mark} /></svg
        ></span>
        <div class="mc-provider-text">
          <strong>${p.name}</strong>
          <small>${statusLine}</small>
        </div>
        <div class="mc-provider-actions">${action}</div>
      </div>
      ${open && !kind ? connectBody(p) : nothing}
    </section>
  `;
}

function view(): TemplateResult {
  const p = s.intent;
  const anyConnected = PROVIDERS.some(
    (q) => s.connections[q.apiName] && (s.account === "personal" || s.account === q.apiName),
  );
  let choices = html`<button type="button" class="btn" @click=${() => void load()}>Retry</button>`;
  if (s.loaded && p)
    choices = html`<div class="mc-simple-connect">${s.connections[p.apiName] ? providerRow(p) : connectBody(p)}</div>`;
  else if (s.loaded)
    choices = html`<div class="mc-providers">
      ${methodRow(
        "Company access",
        s.required ? "Your organization requires a personal account." : "Use the access provided by your organization.",
        !s.personal,
        () => void switchAccount("company"),
      )}
      <p class="mc-account-hint">
        ${s.personal ? "Using a personal account. Choose a connected provider below." : "Or use your own account. Connect a provider, then choose Use account."}
      </p>
      ${PROVIDERS.map((q) => providerRow(q))}
    </div>`;
  const body = s.loading
    ? html`<div class="mc-waiting"><span class="mc-spinner" aria-hidden="true"></span>Loading…</div>`
    : html`
        ${s.error ? html`<div class="mc-error" role="alert">${s.error}</div>` : nothing}
        ${s.saving || s.notice ? html`<p class="mc-notice" role="status">${s.saving ? "Saving changes…" : s.notice}</p>` : nothing}
        ${choices}
        ${!p && s.loaded && (anyConnected || !s.personal) ? html`<button class="btn primary mc-cta" ?disabled=${s.saving} @click=${() => location.reload()}>Start chatting</button>` : nothing}
      `;
  let subCopy =
    "Choose who provides access for your chats on the web and in Slack. Background tasks continue using company access.";
  if (p)
    subCopy =
      s.method === "apikey"
        ? "New chats will be billed to this API key."
        : `Use your ${p.subscription} subscription for new chats.`;
  return html`
    <div class="signin">
      <div
        class="signin-panel mc-panel"
        role=${p ? "dialog" : "region"}
        aria-modal=${p ? "true" : nothing}
        aria-labelledby="mc-title"
      >
        ${
          p
            ? html`<button
                type="button"
                class="mc-close"
                aria-label="Close"
                title="Close"
                ?disabled=${s.saving}
                @click=${closeManager}
              >
                ×
              </button>`
            : html`<div class="signin-brand">${brandMark()}<span>${brandName()}</span></div>`
        }
        <h1 id="mc-title">${p ? `Connect ${p.name}` : "Connect your AI account"}</h1>
        <p class="signin-body">${subCopy}</p>
        ${body}
      </div>
    </div>
  `;
}

function paint(): void {
  const el = s.intent ? overlay : document.getElementById("app");
  if (s.controller.signal.aborted || !el) return;
  const focused = document.activeElement;
  render(view(), el);
  if (s.intent && focused && !focused.isConnected) {
    el.querySelector<HTMLElement>(".mc-provider.open .mc-provider-actions button, .mc-close")?.focus();
  }
}

function closeManager(): void {
  if (s.saving) return;
  retire();
  overlay?.remove();
  overlay = null;
  restoreDialogFocus(opener, () => document.querySelector<HTMLElement>("[aria-label='Settings']"));
  opener = null;
}

export function renderModelConnectGate(): void {
  if (s) retire();
  s = fresh(null);
  paint();
  void load();
}

export function openModelConnectManager(provider: ApiName): void {
  if (overlay) return;
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay = document.createElement("div");
  overlay.className = "mc-overlay";
  overlay.addEventListener("click", (e) => {
    if (!e.composedPath().some((node) => node instanceof Element && node.classList.contains("mc-panel")))
      closeManager();
  });
  overlay.addEventListener("keydown", (e) => trapDialogFocus(e, closeManager));
  document.body.appendChild(overlay);
  const intent = PROVIDERS.find((p) => p.apiName === provider)!;
  const state = (s = fresh(intent));
  paint();
  overlay.querySelector<HTMLElement>(".mc-close")?.focus();
  void load().then(() => {
    if (!current(state) || !s.loaded) return;
    s.open = intent.key;
    if (!s.connections[intent.apiName]) void pickSubscription(intent);
    else paint();
  });
}
