import { html, nothing, render } from "lit";
import { withBase } from "./core-bridge";
import { swallowAs } from "../../chassis/src/errors";
import { brandMark, brandName } from "./ui";
import { renderList } from "./sessions";
import { appState, quietly } from "./shell-state";
import { ADMIN_HOME_URL, bootSafely, mountShell, showMainEmpty, signOut } from "./shell";

let impersonationExitFailed = false;

async function exitImpersonation(): Promise<void> {
  const stopped = await fetch("/auth/impersonate/stop", { method: "POST", headers: { accept: "application/json" } })
    .then((r) => r.ok)
    .catch(swallowAs("web-ui: exit impersonation", false));
  if (!stopped) {
    impersonationExitFailed = true;
    mountShell();
    return;
  }
  window.location.href = ADMIN_HOME_URL;
}

export function impersonationBanner(by: string) {
  return html`
    <div class="top-banner" role="status">
      <span
        >${
          impersonationExitFailed
            ? "Couldn't exit impersonation. Try again."
            : html`Viewing the assistant as <b>${appState.me?.user ?? ""}</b>. You are <b>${by}</b>`
        }</span
      >
      <button class="top-banner-action" type="button" @click=${exitImpersonation}>Exit impersonation</button>
    </div>
  `;
}

export function outdatedBanner() {
  return html`<div class="top-banner" role="alert">
    <span>This page is out of date. Reload to continue.</span>
    <button class="top-banner-action" type="button" @click=${() => location.reload()}>Reload</button>
  </div>`;
}

function gateShell(body: unknown) {
  return html`
    <div class="signin">
      <div class="signin-panel">
        <div class="signin-brand">${brandMark()}<span>${brandName()}</span></div>
        ${body}
      </div>
    </div>
  `;
}

const PORTAL_ATTEMPT_KEY = "qm.portal.signin.attempt";
const PORTAL_ATTEMPT_WINDOW_MS = 20_000;

function portalAttemptedRecently(): boolean {
  const at = Number(quietly(() => sessionStorage.getItem(PORTAL_ATTEMPT_KEY), null) ?? "");
  return Number.isFinite(at) && Date.now() - at < PORTAL_ATTEMPT_WINDOW_MS;
}

function signInWithPortal(): void {
  quietly(() => sessionStorage.setItem(PORTAL_ATTEMPT_KEY, String(Date.now())), undefined);
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function clearPortalAttempt(): void {
  quietly(() => sessionStorage.removeItem(PORTAL_ATTEMPT_KEY), undefined);
}

export function portalGate() {
  if (portalAttemptedRecently())
    return gateShell(html`
      <h1>Sign in through the portal</h1>
      <p class="signin-body">
        This surface is reached through the portal, and signing in there didn't produce a session for it. Open the
        portal address directly rather than this one.
      </p>
      <div class="hint">
        If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.
      </div>
    `);
  return gateShell(html`
    <h1>Your session ended</h1>
    <p class="signin-body">You've been signed out. Sign in again and you'll come back to this page.</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>Sign in</button>
  `);
}

export function deniedGate() {
  return gateShell(html`
    <h1>You don't have access</h1>
    <p class="signin-body">
      Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.
    </p>
    <button class="btn" type="button" @click=${signOut}>Sign out</button>
  `);
}

export function unreachableGate() {
  return gateShell(html`
    <h1>We couldn't reach the assistant</h1>
    <p class="signin-body">The service didn't respond. This is usually temporary.</p>
    <button class="btn primary" type="button" @click=${() => void bootSafely()}>Try again</button>
    <div class="hint">If this keeps happening, the core service may be down.</div>
  `);
}

export type AuthGate = { kind: "portal" } | { kind: "denied" } | { kind: "unreachable" };

export function gateFor(reason: "unauthenticated" | "not_allowed" | undefined): AuthGate {
  return reason === "not_allowed" ? { kind: "denied" } : { kind: "portal" };
}

export function showConversationError(unavailable: boolean): void {
  showMainEmpty("");
  if (!appState.mainEl) return;
  render(
    html`
      <section class="conversation-error" aria-labelledby="conversation-error-title">
        <span class="conversation-error-code">${unavailable ? "Connection problem" : "404"}</span>
        <h1 id="conversation-error-title" tabindex="-1">
          ${unavailable ? "Couldn't load conversation" : "Conversation not found"}
        </h1>
        <p>
          ${unavailable ? "Something went wrong loading this conversation. Please try again." : "This conversation may have been deleted, or you may be signed into an account that doesn’t have access."}
        </p>
        <div class="conversation-error-actions">
          <a class="btn" href=${withBase("/")}>Back to chats</a>
          ${unavailable ? html`<button class="btn" @click=${() => location.reload()}>Try again</button>` : nothing}
        </div>
      </section>
    `,
    appState.mainEl,
  );
  appState.mainEl.querySelector<HTMLElement>("h1")?.focus();
  renderList();
  document.title = `${unavailable ? "Couldn't load conversation" : "Conversation not found"} · ${brandName()}`;
}
