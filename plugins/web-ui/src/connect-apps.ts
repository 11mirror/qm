import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import {
  takeConnectionReturn,
  completeConnectionReturn,
  saveConnectionAttempt,
  clearConnectionAttempt,
  type ConnectionAttempt,
  type PickerState,
  ACCOUNT_ID,
} from "./connection-return";
import { LitElement, html, nothing, render } from "lit";
import { ArrowUpRight, Check, RefreshCw, Search, TriangleAlert } from "lucide";
import { icon } from "./icons";
import { askConfirm } from "./dialog-focus";
import { brandName } from "./ui";
import { webFetch } from "./core-bridge";
import { connectorLogo } from "./connector-logo";
import type { Me } from "./shell-state";
import "./connect-apps.css";
import "./slack-account";

interface ConnectedAccount {
  id: string;
  toolkit: string;
  missingScopes?: string[];
}

const continuedAttempts = new Set<string>();

async function fetchPages<T>(
  url: string,
  signal: AbortSignal,
  unfinished: string,
  failed: (result: { message?: string }) => string,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor = "";
  do {
    if (seen.has(cursor) || seen.size >= 100) throw new Error(unfinished);
    seen.add(cursor);
    const response = await webFetch(`${url}?${new URLSearchParams({ cursor })}`, { signal });
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.items)) throw new Error(failed(result));
    items.push(...result.items);
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
  } while (cursor);
  return items;
}

interface ConnectionService {
  id: string;
  name: string;
  description: string;
  popularity: number;
  logoUrl?: string;
  connected?: boolean;
  stale?: boolean;
}

function mountConnectionPicker(
  container: HTMLElement,
  services: ConnectionService[],
  onSelect: (service: ConnectionService) => void,
  state: PickerState,
  only?: ConnectionService,
): void {
  const sorted = [...services].sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name));
  function draw(): void {
    const words = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = sorted.filter((service) => {
      const text = `${service.name} ${service.description}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    const shown = state.expanded || words.length ? matches : matches.slice(0, 6);
    render(
      html`<section class="connection-picker" aria-label=${only ? `Connect ${only.name}` : "Connect your apps"}>
        <header class="connection-picker-header">
          <div>
            <h3>${only ? `Connect ${only.name}` : "Connect your apps"}</h3>
          </div>
        </header>
        ${
          only
            ? nothing
            : html`<label class="connection-picker-search">
                  ${icon(Search, 16)}
                  <input
                    type="search"
                    aria-label="Search apps"
                    placeholder="Search apps…"
                    .value=${state.query}
                    @input=${(event: Event) => {
                      state.query = (event.target as HTMLInputElement).value;
                      draw();
                    }}
                  />
                </label>
                <div class="connection-picker-caption" role="status" aria-live="polite">
                  ${words.length ? `${matches.length} ${matches.length === 1 ? "app" : "apps"} found` : "Popular apps"}
                </div>`
        }
        <div class="connection-picker-grid">
          ${shown.map((service) => {
            let action = { label: `Connect ${service.name}`, mark: ArrowUpRight };
            if (service.stale) action = { label: `Reconnect ${service.name}`, mark: RefreshCw };
            else if (service.connected) action = { label: `${service.name} connected`, mark: Check };
            return html`<button
              type="button"
              class=${service.stale ? "connection-picker-app stale" : "connection-picker-app"}
              ?disabled=${service.connected && !service.stale}
              aria-label=${action.label}
              @click=${() => onSelect(service)}
            >
              ${connectorLogo(service.id, service.logoUrl)}
              <span class="connection-picker-name">${service.name}</span>
              <span class="connection-picker-trailing">${icon(action.mark, 14)}</span>
            </button>`;
          })}
        </div>
        ${matches.length === 0 ? html`<p class="connection-picker-empty">No apps match “${state.query}”. Try another name.</p>` : nothing}
        ${
          !words.length && matches.length > 6
            ? html`<button
                class="connection-picker-more"
                type="button"
                @click=${() => {
                  state.expanded = !state.expanded;
                  draw();
                }}
              >
                ${state.expanded ? "Show fewer apps" : `Browse all ${services.length} apps`}
              </button>`
            : nothing
        }
      </section>`,
      container,
    );
  }
  draw();
}

export class ConnectApps extends LitElement {
  static properties = {
    me: { attribute: false },
    onConnected: { attribute: false },
    widget: {},
    toolkit: {},
    returnKey: {},
    base: {},
    loading: { state: true },
    error: { state: true },
    authorizing: { state: true },
    authorizationError: { state: true },
    connectionOutcome: { state: true },
    connections: { state: true },
    connectionError: { state: true },
    workspaceConnected: { state: true },
    workspaceError: { state: true },
    disconnecting: { state: true },
  };
  me: Me | null = null;
  declare onConnected: ((name: string) => void) | undefined;
  widget: "apps" | "slack" | "slack-account" = "apps";
  toolkit = "";
  returnKey = "settings";
  base = "/";
  loading = true;
  error = "";
  authorizing = "";
  authorizationError = "";
  private connections: ConnectedAccount[] = [];
  private disconnecting = "";
  private connectionError = "";
  private workspaceConnected: boolean | null = null;
  private workspaceError = false;
  private realReturn: ConnectionAttempt | null = null;
  private connectionsController?: AbortController;
  private restoreScrollTop: number | null = null;
  private returnError = "";
  private returnAccount = "";
  private refreshConnections = () => {
    if (!document.hidden) void this.refreshWorkspace();
    if (this.widget === "apps" && !document.hidden) void this.loadConnections();
  };
  private pickerState: PickerState = { query: "", expanded: false };
  private retryService: ConnectionAttempt["service"] | null = null;
  connectionOutcome: "" | "checking" | "success" | "cancelled" | "failed" | "expired" = "";
  private controller?: AbortController;
  private services: ConnectionService[] = [];

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  private accountUser(): string {
    return `${this.me?.org}:${this.me?.user}`;
  }
  private async refreshWorkspace(): Promise<void> {
    if (this.widget === "apps" || (this.widget !== "slack-account" && this.me?.permissions?.includes("admin"))) return;
    try {
      const response = await webFetch(`${this.base}api/composio/slack`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("Slack status unavailable");
      this.workspaceConnected = (await response.json()).workspaceInstalled === true;
      this.workspaceError = false;
    } catch {
      this.workspaceConnected = null;
      this.workspaceError = true;
    }
  }
  protected firstUpdated(): void {
    void this.refreshWorkspace();
    window.addEventListener("focus", this.refreshConnections);
    document.addEventListener("visibilitychange", this.refreshConnections);
    if (this.widget !== "apps") return;
    const returnUrl = takeConnectionReturn(this.accountUser(), this.returnKey);
    if (returnUrl) {
      const params = returnUrl.url.searchParams;
      const attempt = returnUrl.attempt;
      this.realReturn = returnUrl.verified ? null : attempt;
      this.returnError = params.get("error") ?? "";
      this.returnAccount = params.get("connectedAccountId") ?? "";
      if (attempt) {
        this.pickerState = { ...attempt.picker };
        this.restoreScrollTop = attempt.scrollTop;
        this.retryService = attempt.service;
        this.connectionOutcome = returnUrl.verified ? "" : "checking";
      } else this.connectionOutcome = "expired";
      const clean = new URL(location.href);
      for (const key of ["composioReturn", "status", "error", "connectedAccountId"]) clean.searchParams.delete(key);
      history.replaceState(history.state, "", clean);
    }
    void this.loadConnections();
    void this.loadCatalog();
  }
  private drawPicker(): void {
    const target = this.querySelector<HTMLElement>(".connect-apps-picker");
    const connected = this.connections.map((account) => account.toolkit);
    const healthy = new Set(this.connections.filter((a) => !a.missingScopes?.length).map((a) => a.toolkit));
    const services = this.services.map((service) => ({
      ...service,
      connected: connected.includes(service.id),
      stale: connected.includes(service.id) && !healthy.has(service.id),
    }));
    const requested = services.find((service) => service.id === this.requestedToolkit());
    if (target && !this.error && !this.loading)
      mountConnectionPicker(
        target,
        requested ? [requested] : services,
        (service) =>
          this.authorize(
            service,
            service.stale ? this.connections.find((a) => a.toolkit === service.id)?.id : undefined,
          ),
        requested ? { query: "", expanded: false } : this.pickerState,
        requested,
      );
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.controller?.abort();
    this.connectionsController?.abort();
    window.removeEventListener("focus", this.refreshConnections);
    document.removeEventListener("visibilitychange", this.refreshConnections);
  }
  private async disconnect(account: ConnectedAccount, name: string): Promise<boolean> {
    this.disconnecting = account.id;
    this.connectionError = "";
    try {
      const response = await webFetch(`${this.base}api/composio/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });
      if (!response.ok && response.status !== 404) throw new Error(`Could not disconnect ${name}. Please try again.`);
      this.connections = this.connections.filter((candidate) => candidate.id !== account.id);
      return true;
    } catch (error) {
      this.connectionError = error instanceof Error ? error.message : `Could not disconnect ${name}.`;
      return false;
    } finally {
      this.disconnecting = "";
      await this.updateComplete;
      this.drawPicker();
    }
  }
  private async confirmDisconnect(account: ConnectedAccount, name: string): Promise<void> {
    const confirmed = await askConfirm({
      id: "connect-apps-disconnect",
      title: `Disconnect ${name}?`,
      body: `${brandName()} will lose access to it until you connect it again.`,
      confirm: "Disconnect",
    });
    if (confirmed) void this.disconnect(account, name);
  }
  private requestedToolkit(): string {
    return this.services.some((service) => service.id === this.toolkit) ? this.toolkit : "";
  }
  private async loadConnections(): Promise<void> {
    this.connectionsController?.abort();
    const controller = (this.connectionsController = new AbortController());
    this.connectionError = "";
    try {
      const accounts = await fetchPages<ConnectedAccount>(
        `${this.base}api/composio/connections`,
        controller.signal,
        "Could not finish checking connected apps.",
        () => "Could not check connected apps. Please try again.",
      );
      if (!this.isConnected || controller.signal.aborted) return;
      this.connections = accounts;
      if (this.realReturn) {
        const attempt = this.realReturn;
        const verified = accounts.some(
          (account) => account.id === attempt.accountId && account.toolkit === attempt.service.id,
        );
        if (verified && (!this.returnAccount || this.returnAccount === attempt.accountId))
          this.connectionOutcome = "success";
        else this.connectionOutcome = this.returnError === "access_denied" ? "cancelled" : "failed";
        clearConnectionAttempt(this.accountUser());
        if (this.connectionOutcome === "success") {
          completeConnectionReturn(this.accountUser(), attempt.state);
          this.realReturn = null;
          const replaced = accounts.find(
            (account) => account.id === attempt.replaces && account.id !== attempt.accountId,
          );
          if (replaced && !(await this.disconnect(replaced, attempt.service.name)))
            this.connectionError = `${attempt.service.name} is reconnected, but the old connection is still there. Disconnect it below.`;
          if (attempt.service.id === this.toolkit && !continuedAttempts.has(attempt.state)) {
            continuedAttempts.add(attempt.state);
            this.onConnected?.(attempt.service.name);
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted || !this.isConnected) return;
      this.connections = [];
      this.connectionOutcome = "";
      this.connectionError = error instanceof Error ? error.message : "Could not check connected apps.";
    }
    await this.updateComplete;
    this.drawPicker();
  }
  private async loadCatalog(): Promise<void> {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    this.loading = true;
    this.error = "";
    const services: ConnectionService[] = [];
    try {
      const items = await fetchPages<{ id: string; name: string; description: string }>(
        `${this.base}api/composio/toolkits`,
        controller.signal,
        "Could not finish loading apps. Please try again.",
        (result) => result.message ?? "App connections are unavailable right now. Please try again.",
      );
      for (const item of items)
        if (item.id !== "slack" && !services.some((service) => service.id === item.id))
          services.push({ ...item, popularity: 100000 - services.length });
      this.services = services;
    } catch (error) {
      if (controller.signal.aborted) return;
      this.error = error instanceof Error ? error.message : "Could not load apps. Please try again.";
    }
    if (!this.isConnected || controller.signal.aborted) return;
    this.loading = false;
    await this.updateComplete;
    this.drawPicker();
    const restoreTop = this.restoreScrollTop;
    if (restoreTop !== null && restoreTop !== undefined) {
      await this.updateComplete;
      requestAnimationFrame(() => {
        const scroller = this.closest(".chat-scroll");
        if (scroller && this.isConnected) scroller.scrollTop = restoreTop;
        this.restoreScrollTop = null;
      });
    }
  }
  private async authorize(service: ConnectionService, replaces?: string): Promise<void> {
    if (this.authorizing) return;
    this.authorizing = service.name;
    this.authorizationError = "";
    try {
      if (await openDesktopBrowser(`${this.base}settings`)) return;
      const state = crypto.randomUUID();
      const attempt: ConnectionAttempt = {
        state,
        user: this.accountUser(),
        service: { id: service.id, name: service.name },
        accountId: "",
        ...(replaces ? { replaces } : {}),
        widget: this.returnKey,
        expiresAt: Date.now() + 20 * 60_000,
        path: location.pathname,
        picker: { ...this.pickerState },
        scrollTop: this.closest(".chat-scroll")?.scrollTop ?? 0,
      };
      saveConnectionAttempt(attempt);
      const response = await webFetch(`${this.base}api/composio/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: service.id, returnTo: location.pathname + location.search, state }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Could not open authorization. Please try again.");
      if (typeof result.accountId !== "string" || !ACCOUNT_ID.test(result.accountId))
        throw new Error("Could not start authorization. Please try again.");
      saveConnectionAttempt({ ...attempt, accountId: result.accountId });
      window.location.assign(result.url);
    } catch (error) {
      this.authorizationError =
        error instanceof Error ? error.message : "Could not open authorization. Please try again.";
    } finally {
      this.authorizing = "";
    }
  }
  protected render() {
    const serviceName = this.retryService?.name ?? "App";
    const requested = this.requestedToolkit();
    const connectedAccounts = this.connections.filter((account) => !requested || account.toolkit === requested);
    const serviceFor = (id: string) =>
      this.services.find((service) => service.id === id) ?? { id, name: id, description: "", popularity: 0 };
    const outcome = {
      "": { title: "", detail: "" },
      checking: {
        title: `Checking ${serviceName} connection…`,
        detail: "Confirming access before marking it connected.",
      },
      success: { title: `${serviceName} connected`, detail: "" },
      cancelled: {
        title: `${serviceName} wasn’t connected`,
        detail: "You cancelled authorization. You can try again whenever you’re ready.",
      },
      expired: { title: "This connection attempt has expired", detail: "Choose an app below to start again." },
      failed: {
        title: `Couldn’t connect ${serviceName}`,
        detail: "We couldn’t confirm an active connection yet. Try checking again, or restart authorization.",
      },
    }[this.connectionOutcome];
    return html`<section class="connect-apps">
      ${
        this.widget === "slack" && this.me?.permissions?.includes("admin")
          ? html`<qm-onboarding-slack
              @slack-installation-status=${(event: CustomEvent<{ connected: boolean }>) => {
                this.workspaceConnected = event.detail.connected;
              }}
            ></qm-onboarding-slack>`
          : nothing
      }
      ${this.widget === "slack-account" && this.workspaceError ? html`<p role="status">Could not check Slack setup. <button class="btn" @click=${() => void this.refreshWorkspace()}>Try again</button></p>` : nothing}
      ${this.widget === "slack-account" && this.workspaceConnected === false ? html`<p role="status">QM needs to be added to your company’s Slack workspace before you can link your account. Ask an administrator to finish setup.</p>` : nothing}
      ${this.workspaceConnected && this.widget !== "apps" ? html`<qm-slack-account .user=${this.accountUser()}></qm-slack-account>` : nothing}
      ${
        this.widget !== "apps"
          ? nothing
          : html`<div>
              ${this.loading ? html`<div class="connect-apps-load" role="status">Loading your available apps…</div>` : nothing}
              ${
                this.error
                  ? html`<div class="connect-apps-load">
                      <strong>Connect your apps</strong>
                      <p role="status">${this.error}</p>
                      <button
                        type="button"
                        class="btn"
                        @click=${() => {
                          void this.loadCatalog();
                          void this.loadConnections();
                          void this.refreshWorkspace();
                        }}
                      >
                        Try again
                      </button>
                    </div>`
                  : nothing
              }
              ${
                this.connectionOutcome && this.connectionOutcome !== "success"
                  ? html`<div
                      class="connection-result"
                      data-outcome=${this.connectionOutcome}
                      role="status"
                      aria-live="polite"
                    >
                      <strong>${outcome.title}</strong>
                      ${outcome.detail ? html`<p>${outcome.detail}</p>` : nothing}
                      ${["cancelled", "failed"].includes(this.connectionOutcome) && this.retryService ? html`<button class="btn" @click=${() => this.authorize({ ...this.retryService!, description: "", popularity: 0 })}>Try again</button>` : nothing}
                    </div>`
                  : nothing
              }
              ${this.connectionError && !this.error && !this.loading ? html`<div class="connect-apps-status" role="status">${this.connectionError} <button class="btn" @click=${() => void this.loadConnections()}>Check again</button></div>` : nothing}
              ${this.connectionOutcome === "failed" ? html`<button class="btn" @click=${() => void this.loadConnections()}>Check again</button>` : nothing}
              <div class="connect-apps-picker" ?inert=${Boolean(this.authorizing)}></div>
              ${
                connectedAccounts.length
                  ? html`<div class="connection-connected" role="status" aria-live="polite">
                      ${connectedAccounts.map((account) => {
                        const service = serviceFor(account.toolkit);
                        const stale = Boolean(account.missingScopes?.length);
                        return html`<span class=${stale ? "stale" : ""}
                          >${icon(stale ? TriangleAlert : Check, 10)}${`${service.name} ${stale ? "needs new permissions" : "connected"}`}
                          ${
                            account.id
                              ? html`<button
                                    type="button"
                                    class="kc-text-action"
                                    ?disabled=${Boolean(this.authorizing || this.disconnecting)}
                                    @click=${() => void this.authorize(service, account.id)}
                                  >
                                    Reconnect
                                  </button>
                                  <button
                                    type="button"
                                    class="kc-text-action danger"
                                    ?disabled=${Boolean(this.authorizing || this.disconnecting)}
                                    @click=${() => void this.confirmDisconnect(account, service.name)}
                                  >
                                    Disconnect
                                  </button>`
                              : nothing
                          }</span
                        >`;
                      })}
                    </div>`
                  : nothing
              }
              ${this.authorizing ? html`<p class="connect-apps-status" role="status">Opening ${this.authorizing}…</p>` : nothing}
              ${this.authorizationError ? html`<p class="connect-apps-status" role="alert">${this.authorizationError}</p>` : nothing}
            </div>`
      }
    </section>`;
  }
}
if (!customElements.get("qm-connect-apps")) customElements.define("qm-connect-apps", ConnectApps);
