import { openDesktopBrowser } from "../../chassis/src/desktop-browser";
import { html, nothing } from "lit";
import { ArrowUpRight, Check, Link2, UserRound } from "lucide";
import { slackMark } from "./slack-mark";
import { icon } from "./icons";
import "./slack-account.css";
import { webFetch, withBase } from "./core-bridge";
import { UI_BASE } from "./deep-link";
import { SlackStatus } from "./slack-setup";

interface SlackAttempt {
  user: string;
  state: string;
  ticket: string;
  expiresAt: number;
}

let returnUrl: URL | null = null;

export function captureSlackReturn(url: string): void {
  const parsed = new URL(url);
  returnUrl = parsed.searchParams.has("slackReturn") ? parsed : null;
}

async function postJson(path: string, body: object, fallback: string, ms = 30_000) {
  const response = await webFetch(withBase(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.message ?? fallback);
  return result;
}

function verifiedUrl(href: string, ok: (url: URL) => boolean): string {
  const url = new URL(href);
  if (url.username || url.password || !ok(url)) throw Error("Could not verify the Slack authorization link.");
  return url.href;
}

const accountLabel = (result: { user?: string; workspace?: string }) =>
  [result.user, result.workspace].filter(Boolean).join(" · ");

export class SlackAccount extends SlackStatus {
  static properties = {
    user: {},
    reply: { type: Boolean },
    busy: { state: true },
    error: { state: true },
    connected: { state: true },
    label: { state: true },
  };
  user = "";
  reply = false;
  private busy = false;
  private error = "";
  private connected = false;
  private label = "";
  private nativeOAuth = false;
  private attempt: SlackAttempt | null = null;

  protected firstUpdated(): void {
    const url = returnUrl ?? new URL(location.href);
    returnUrl = null;
    const state = url.searchParams.get("slackReturn");
    try {
      const saved = JSON.parse(sessionStorage.getItem("qm-slack-account") ?? "null") as SlackAttempt | null;
      if (saved?.user === this.user && saved.expiresAt > Date.now()) this.attempt = saved;
    } catch {
      this.attempt = null;
    }
    if (!state) return void this.refresh();
    const cancelled = url.searchParams.has("error");
    for (const key of ["slackReturn", "status", "error", "connectedAccountId"]) url.searchParams.delete(key);
    history.replaceState(history.state, "", url);
    if (!this.attempt || this.attempt.state !== state) {
      this.error =
        "This connection expired or was started in another QM account. Sign in to the account you want to connect and try again.";
      return;
    }
    if (!cancelled) return void this.complete();
    this.clearAttempt();
    this.error = "Slack authorization was cancelled. Your QM account has not been linked.";
  }

  private clearAttempt(): void {
    this.attempt = null;
    sessionStorage.removeItem("qm-slack-account");
  }

  protected async refresh(): Promise<void> {
    const response = await webFetch(withBase("/api/composio/slack"), {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    const result = response?.ok ? await response.json().catch(() => null) : null;
    if (!result) return;
    this.nativeOAuth = result.nativeOAuth === true;
    this.connected = result.connected === true;
    this.label = accountLabel(result);
  }

  private async connect(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    const returnTo = `${location.pathname}${location.search}`;
    try {
      if (await openDesktopBrowser(withBase("/settings"))) return;
      await this.refresh();
      if (this.nativeOAuth) {
        const result = await postJson(
          "/api/connectors/slack/start",
          { returnTo },
          "Could not start Slack authorization.",
        );
        return location.assign(
          verifiedUrl(
            result.authorizeUrl,
            (url) => url.origin === "https://slack.com" && url.pathname === "/oauth/v2/authorize",
          ),
        );
      }
      const state = crypto.randomUUID();
      const result = await postJson(
        "/api/composio/slack/authorize",
        { state, returnTo },
        "Could not start Slack authorization. Please try again.",
      );
      const href = verifiedUrl(
        result.url,
        (url) =>
          url.protocol === "https:" &&
          ["connect.composio.dev", "app.composio.dev"].includes(url.hostname) &&
          typeof result.ticket === "string",
      );
      this.attempt = { user: this.user, state, ticket: result.ticket, expiresAt: Date.now() + 20 * 60_000 };
      sessionStorage.setItem("qm-slack-account", JSON.stringify(this.attempt));
      location.assign(href);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not connect Slack.";
    } finally {
      this.busy = false;
    }
  }

  private async complete(): Promise<void> {
    if (this.busy || !this.attempt) return;
    this.busy = true;
    this.error = "";
    try {
      const result = await postJson(
        "/api/composio/slack/complete",
        { ticket: this.attempt.ticket },
        "Could not verify your Slack account. Try again.",
        45_000,
      );
      this.connected = true;
      this.label = accountLabel(result);
      this.clearAttempt();
      this.dispatchEvent(new CustomEvent("slack-linked", { bubbles: true }));
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Could not verify your Slack account.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    return html`<section class="slack-account" aria-label="Your Slack account">
      ${
        this.connected && !this.reply
          ? html`<div class="slack-connected" role="status">
              ${icon(Check, 14)}<span>Your Slack account is linked${this.label ? ` · ${this.label}` : ""}</span>
            </div>`
          : html`<button class="slack-connect" type="button" ?disabled=${this.busy} @click=${() => void this.connect()}>
              <div class="slack-link-icon" aria-hidden="true">
                <span class="slack-link-person">${icon(UserRound, 17)}</span>
                <span class="slack-link-service">${slackMark(18)}</span>
                <span class="slack-link-chain">${icon(Link2, 13)}</span>
              </div>
              <span
                ><strong>${this.busy ? "Linking Slack…" : "Link your Slack account"}</strong
                ><small
                  >${this.reply ? "Send replies here as yourself in Slack." : "Let QM search Slack and take action on your behalf."}</small
                ></span
              >
              ${icon(ArrowUpRight, 16)}
            </button>`
      }
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error}</p>` : nothing}
      ${this.attempt && !this.connected ? html`<button class="btn" type="button" ?disabled=${this.busy} @click=${() => void this.complete()}>Check connection</button>` : nothing}
    </section>`;
  }
}

if (!customElements.get("qm-slack-account")) customElements.define("qm-slack-account", SlackAccount);

const SLACK_SETTINGS = `${UI_BASE}/settings/slack-settings`;

export class OnboardingSlack extends SlackStatus {
  static properties = {
    installAvailable: { state: true },
    connected: { state: true },
    busy: { state: true },
    error: { state: true },
  };
  private connected = false;
  private installAvailable: boolean | undefined;
  private busy = false;
  private error = "";
  private pollUntil = 0;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  protected refresh(): Promise<void> {
    return this.installation(
      async (response) => {
        if (!response.ok) throw new Error();
        const status = await response.json();
        this.installAvailable = status.installAvailable === true;
        this.connected = status.configured === true && !status.setupUnavailable && status.setup?.connected !== false;
        this.error = "";
      },
      () => {
        if (!this.isConnected) return;
        this.connected = false;
        this.error = "Could not check the Slack installation. Try again.";
      },
      () => {
        this.dispatchEvent(
          new window.CustomEvent("slack-installation-status", { detail: { connected: this.connected } }),
        );
        return this.isConnected && !this.connected && Date.now() < this.pollUntil;
      },
    );
  }

  private poll(): void {
    this.pollUntil = Date.now() + 10 * 60_000;
    void this.refresh();
  }

  private async install(): Promise<void> {
    if (this.busy || this.installAvailable === undefined) return;
    try {
      if (await openDesktopBrowser(`${SLACK_SETTINGS}?slack=install`)) return this.poll();
    } catch {
      this.error = "Could not open your browser. Please try again.";
      return;
    }
    const popup = window.open("", "_blank");
    if (!popup) {
      this.error = "Allow a new tab to install QM, then try again.";
      return;
    }
    popup.opener = null;
    if (this.installAvailable === false) {
      popup.location.href = `${SLACK_SETTINGS}?setup=slack`;
      return;
    }
    popup.document.title = "Connecting Slack";
    popup.document.body.textContent = "Opening Slack…";
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(`${UI_BASE}/api/admin/slack-installation/start`, {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: "install" }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok || typeof result.url !== "string") throw new Error();
      const target = new URL(result.url);
      if (target.protocol !== "https:" || target.username || target.password || popup.closed) throw new Error();
      const form = popup.document.createElement("form");
      form.method = "POST";
      form.action = target.href;
      popup.document.body.append(form);
      form.submit();
      this.poll();
    } catch {
      popup.close();
      this.error = "Could not start Slack installation. Please try again.";
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    let label = this.busy ? "Opening Slack…" : "Add to Slack";
    if (this.installAvailable === undefined) label = "Checking Slack…";
    return html`${
      this.connected
        ? html`<div class="slack-connected" role="status">${icon(Check, 14)} QM added to Slack</div>`
        : html`<button
            class="slack-connect"
            type="button"
            ?disabled=${this.busy || this.installAvailable === undefined}
            @click=${() => void this.install()}
          >
            ${slackMark(24)}<span
              ><strong>${label}</strong><small>Work with QM where your team already talks.</small></span
            >${icon(ArrowUpRight, 16)}
          </button>`
    }
    ${this.error ? html`<p role="status">${this.error} <button type="button" @click=${() => void this.refresh()}>Check again</button></p>` : nothing}`;
  }
}

if (!customElements.get("qm-onboarding-slack")) customElements.define("qm-onboarding-slack", OnboardingSlack);
