import * as governanceUI from "./admin.ts";
import { ADMIN_SECTIONS, LOG_VIEWS, SCOPED_VIEWS, SETTINGS_VIEWS, VIEW_TITLE } from "./sections.ts";
import { ADMIN_MARKUP } from "./markup.ts";
import * as routes from "./routes.ts";
import { fire, initCustomDropdowns, watchCustomDropdowns } from "./dropdown.ts";
import { backArrow, badge, el, kpis, linkClick, searchField, stacked } from "./dom.ts";
import {
  KIND_LABEL,
  fileName,
  fmtBytes,
  historyCategory,
  pick,
  plural,
  relTime,
  scopeKind,
  titleCase,
} from "./format.ts";

export function startAdmin(host, env) {
  host.innerHTML = ADMIN_MARKUP;
  governanceUI.mountCards();
  const $ = (id) => document.getElementById(id);
  const root = $("app-view");
  const EFFECT_LABELS = { allow: "Allow", deny: "Deny", require_approval: "Require approval" };
  $("card-feature-flags").classList.remove("hidden");
  $("connector-dm-tip").firstChild.textContent =
    "Tip: the easiest way to change these settings is to ask " +
    env.productName +
    " in a DM. It can make the edit for you and confirm what changed.";
  document.querySelectorAll("#view-governance section.card > .foot > .viewlink").forEach((link) => {
    link.closest("section.card").querySelector(":scope > .head").appendChild(link);
  });
  const scAddButton = $("sc-add");
  const scStatusHome = $("st-service-credentials").parentElement;
  $("card-service-credentials").insertAdjacentHTML(
    "beforeend",
    '<dialog id="sc-dialog" class="custom-provider-dialog credential-dialog" aria-labelledby="sc-dialog-title" aria-describedby="sc-dialog-description"><div class="project-dialog-head"><div><h2 id="sc-dialog-title">Add credential</h2><p id="sc-dialog-description">Connect a service securely, then choose what the agent can access.</p></div><button class="project-icon-button" type="button" id="sc-dialog-close" aria-label="Close credential dialog">×</button></div><div class="project-dialog-actions" id="sc-dialog-actions"></div></dialog>',
  );
  const dialog = $("sc-dialog");
  dialog.insertBefore($("sc-editor"), $("sc-dialog-actions"));
  $("sc-dialog-actions").append($("sc-reset"), $("sc-save"));
  const dismiss = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-dialog-close").onclick = dismiss;
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("click", (event) => {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (event.target === dialog && (x < left || x > right || y < top || y > bottom)) dismiss();
  });
  function openScDialog() {
    $("sc-dialog-title").textContent = scEditing ? "Edit credential" : "Add credential";
    setStatus("st-service-credentials", "", "");
    $("sc-dialog-actions").prepend($("st-service-credentials"));
    if (!dialog.open) dialog.showModal();
  }
  document.querySelectorAll("[data-choice-for]").forEach((input) => {
    if (input.closest(".sv-governance, .sv-slack-settings, .sv-models, .sv-customize")) return;
    input.onchange = () => {
      const select = $(input.dataset.choiceFor);
      select.value = input.value;
      fire(select);
    };
  });
  document.querySelectorAll("[data-checkbox-for]").forEach((input) => {
    if (input.closest(".sv-slack-settings")) return;
    input.onchange = () => {
      const checkbox = $(input.dataset.checkboxFor);
      checkbox.checked = input.value === "on";
      fire(checkbox);
    };
  });
  const ERRORS_PAGE_SIZE = 50;
  const brandSelfLabel = () => env.productName;
  const orgId = env.org;
  let scope = "org:" + orgId;
  let view = routes.DEFAULT_VIEW;
  let page = 1;
  let historyCursor = null;
  const viewLoadedAt = {};
  let cronDestinationEditId = null;
  const transcriptVisibility = { thinking: true, toolResults: true };
  const API_BASE = env.apiBase;
  const PAGE_BASE = env.pageBase;
  async function api(method, path, body) {
    try {
      const res = await fetch(API_BASE + path.replace(/^\/api(?=\/)/, ""), {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        console.warn("[swallowed] admin api: non-JSON response", method, path, res.status, error);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      console.warn("[swallowed] admin api: request failed", method, path, error);
      return { ok: false, status: 0, data: { message: "Network request failed." } };
    }
  }
  const scopeUrl = (id, rest = "") => "/api/scopes/" + encodeURIComponent(id) + rest;
  const viewUrl = (id, name) => scopeUrl(id, "?view=" + encodeURIComponent(name));
  async function openWebUiAs(target) {
    if (!target) return;
    try {
      const res = await fetch("/auth/impersonate?target=" + encodeURIComponent(target), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        return alert("Couldn't start impersonation: " + ((j && j.message) || "Failed (" + res.status + ")"));
      }
    } catch (e) {
      return alert("Couldn't start impersonation: " + (e && e.message ? e.message : e));
    }
    window.open("/web-ui/", "_blank", "noopener");
  }
  function webUiAsButton(target) {
    const title = "View the assistant web UI as " + target + " (audited)";
    return el(
      "button.link",
      { type: "button", title, onclick: () => openWebUiAs(target) },
      "Open web UI as this person ↗",
    );
  }
  const statusTimers = new Map();
  function setStatus(id, msg, kind, sticky = false) {
    if (id === "st-service-credentials") {
      settings.credentialStatus(msg, kind || "");
      return;
    }
    const governanceKey = governanceUI.statusKey(id);
    if (governanceKey) {
      governanceUI.status(governanceKey, msg, kind || "");
      return;
    }
    const el = $(id);
    if (!el) return;
    if (statusTimers.has(id)) {
      clearTimeout(statusTimers.get(id));
      statusTimers.delete(id);
    }
    el.textContent = msg;
    el.className = "status " + (kind || "");
    if (msg && !sticky) {
      const timer = setTimeout(() => {
        if (el.textContent === msg) {
          el.textContent = "";
          el.className = "status";
        }
        statusTimers.delete(id);
      }, 4000);
      statusTimers.set(id, timer);
    }
  }
  let governanceReviewResolve = null;
  function finishGovernanceReview(confirmed) {
    const dialog = $("governance-review");
    if (dialog.open) dialog.close();
    const resolve = governanceReviewResolve;
    governanceReviewResolve = null;
    if (resolve) resolve(confirmed);
  }
  function reviewGovernanceChange({ title, subtitle, facts, warning, confirmLabel, danger = false }) {
    if (governanceReviewResolve) finishGovernanceReview(false);
    const dialog = $("governance-review");
    $("governance-review-title").textContent = title;
    $("governance-review-subtitle").textContent = subtitle;
    $("governance-review-facts").replaceChildren(...facts.flatMap(([key, value]) => [el("dt", key), el("dd", value)]));
    $("governance-review-warning").textContent = warning;
    const confirm = $("governance-review-confirm");
    confirm.textContent = confirmLabel || "";
    confirm.classList.toggle("hidden", !confirmLabel);
    confirm.classList.toggle("danger", danger);
    dialog.showModal();
    $("governance-review-cancel").focus();
    return new Promise((resolve) => {
      governanceReviewResolve = resolve;
    });
  }
  $("governance-review-cancel").onclick = () => finishGovernanceReview(false);
  $("governance-review-confirm").onclick = () => finishGovernanceReview(true);
  $("governance-review").addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGovernanceReview(false);
  });
  const settings = governanceUI.settings;
  const credentialState = settings.credentialState;
  function deliveryFileBadges(filesPayload) {
    const filesWithNames = (filesPayload || []).filter((f) => f && f.name);
    if (!filesWithNames.length) return null;
    return el(
      "div.badges",
      {},
      ...filesWithNames.map((f) => {
        const label = `${f.name}${f.sizeBytes ? " · " + fmtBytes(f.sizeBytes) : ""}`;
        if (!f.artifactId) return badge(label, "muted");
        const file = { id: f.artifactId, name: f.name, size: f.sizeBytes, mimetype: f.mimetype, openable: true };
        return el("button.badge info", { textContent: label, onclick: () => downloadFile(file) });
      }),
    );
  }
  const stateToUrl = (st) => routes.stateToUrl(st, PAGE_BASE);
  const urlToState = () => routes.urlToState(PAGE_BASE, orgId, scope);
  let transcriptObserver = null;
  function render(st) {
    governanceUI.transcript.cancel();
    transcriptObserver?.disconnect();
    transcriptObserver = null;
    $("header-controls").textContent = "";
    view = st.view;
    scope = st.scope;
    page = st.page || 1;
    historyCursor = st.cursor || null;
    historyKind = st.historyKind || "conversation";
    for (const v of ["history", "slack", "judgments", "errors", "deployments", "crons"])
      root.classList.toggle(v + "-view", view === v);
    root.classList.toggle("governance-view", isGovLike(view));
    root.dataset.subview = view;
    setGovernancePending(view === "governance" && governanceReadyScope !== scope);
    root.dataset.adminKit = String(ADMIN_SECTIONS.some((section) => section.views.includes(view)));
    root.classList.toggle("context-fullpage", view === "history" && !!st.session && st.turn != null);
    if (!isGovLike(view) && !["general", "connectors", "onboarding"].includes(view) && !scopeDir)
      void loadScopeDirectory();
    defaultShell();
    env.onView(view);
    $("view-governance").classList.toggle("hidden", !isGovLike(view));
    $("view-onboarding").classList.toggle("hidden", view !== "onboarding");
    $("connector-dm-tip").classList.toggle("hidden", view !== "connectors");
    $("view-connectors").classList.toggle("hidden", view !== "connectors");
    $("view-data").classList.toggle(
      "hidden",
      ["general", "onboarding", "connectors"].includes(view) || isGovLike(view),
    );
    if (view === "general") return;
    if (view === "onboarding") return void governanceUI.onboarding.load();
    if (isGovLike(view)) {
      if (view === "slack-settings") void governanceUI.integrations.loadSlackInstallation();
      return void loadScope();
    }
    if (view === "connectors") return void governanceUI.integrations.loadConnectors();
    if (view === "user") return void showUserDetail(st.principal);
    if (view === "slack") return void governanceUI.slackActivity.renderSlackMirror(st);
    if (view === "judgments") return void governanceUI.slackActivity.renderAmbientJudgments(st);
    if (view === "ackemoji") return void governanceUI.slackActivity.renderAckEmojiPicks(st);
    if (view === "history" && st.session && st.turn != null)
      return void governanceUI.transcript.contextPage(st.session, st.turn, transcriptServices());
    if (view === "history" && st.session)
      return void governanceUI.transcript.show(st.session, undefined, undefined, transcriptServices());
    renderData();
  }
  const isGovLike = (v) => SETTINGS_VIEWS.has(v);
  const hasGovernanceDraft = () => isGovLike(view) && !!$("view-governance").querySelector(".card.dirty");
  function governanceScopeName(scopeId = scope) {
    return scopeKind(scopeId) === "org"
      ? "Organization · " + scopeId.split(":").slice(1).join(":")
      : shortName(scopeId);
  }
  function commitGo(st) {
    history.pushState(st, "", stateToUrl(st));
    render(st);
  }
  function reviewLeave(destination) {
    const facts = [
      ["Current scope", governanceScopeName()],
      ["Destination", VIEW_TITLE[destination] || titleCase(destination)],
    ];
    if (isGovLike(view) && $("view-governance").querySelector(".status.saving")) {
      void reviewGovernanceChange({
        title: "Governance save in progress",
        subtitle: "Wait for the current save to finish before leaving.",
        facts,
        warning: "The change may already be committing and cannot be safely discarded.",
        confirmLabel: null,
      });
      return Promise.resolve(false);
    }
    return reviewGovernanceChange({
      title: "Discard unsaved governance changes?",
      subtitle: "This page has a draft that has not been applied.",
      facts,
      warning: "Leaving now discards every unsaved setting on this Governance page.",
      confirmLabel: "Discard and leave",
      danger: true,
    });
  }
  function go(st) {
    if (!hasGovernanceDraft() || (st.view === view && st.scope === scope)) return commitGo(st);
    void reviewLeave(st.view).then((confirmed) => {
      if (!confirmed) return;
      if (view === "governance") governanceReadyScope = null;
      commitGo(st);
    });
  }
  function setView(v) {
    go({
      view: v,
      scope: v === "history" || v === "errors" ? "org:" + orgId : scope,
      session: null,
      historyKind: "conversation",
    });
  }
  document.querySelectorAll("[data-viewlink]").forEach((button) => {
    button.onclick = () => setView(button.dataset.viewlink);
  });
  $("add-custom-provider").onclick = () => settings.openProvider(null);
  $("onboarding-add-custom-provider").onclick = () => settings.openProvider(null);
  function route() {
    const st = urlToState();
    if (st.view === "history" && st.session) {
      const list = { ...st, session: null, turn: null };
      history.replaceState(list, "", stateToUrl(list));
      if (st.turn != null)
        history.pushState({ ...st, turn: null, deepLink: true }, "", stateToUrl({ ...st, turn: null }));
      history.pushState({ ...st, deepLink: true }, "", stateToUrl(st));
    } else if (st.view === "user" && st.principal) {
      const list = { ...st, view: "users", principal: null };
      history.replaceState(list, "", stateToUrl(list));
      history.pushState(st, "", stateToUrl(st));
    } else {
      history.replaceState(st, "", stateToUrl(st));
    }
    render(st);
  }
  let allowGovernancePop = false;
  window.addEventListener("popstate", () => {
    if (!root.isConnected) return;
    if (allowGovernancePop) {
      allowGovernancePop = false;
      return render(urlToState());
    }
    const next = urlToState();
    if (!hasGovernanceDraft()) return render(next);
    if (next.view === view && next.scope === scope) return;
    const current = { view, scope, session: null, page };
    history.pushState(current, "", stateToUrl(current));
    void reviewLeave(next.view).then((confirmed) => {
      if (!confirmed) return;
      allowGovernancePop = true;
      history.back();
    });
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasGovernanceDraft()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  let scopeDir = null;
  let environmentDir = [];
  async function loadScopeDirectory() {
    const r = await api("GET", "/api/scopes");
    if (!r.ok) return;
    viewLoadedAt.history = Date.now();
    scopeDir = r.data.scopes || [];
    environmentDir = r.data.environments || [];
    if (SCOPED_VIEWS.has(view) && !urlToState().session) {
      const memoryEditor = view === "memory" && !(orgWideView() && urlToState().mem !== "edit");
      if (!(memoryEditor && orgWideView())) defaultShell();
      if (view !== "governance" && !memoryEditor) renderData();
    }
  }
  const dirLabel = (id) => (scopeDir || []).find((x) => x.scopeId === id)?.label || "";
  function shortName(scopeId) {
    if (!scopeId) return "";
    const kind = scopeKind(scopeId);
    if (kind === "org") return "org";
    const lbl = dirLabel(scopeId);
    if (lbl) return lbl;
    const rest = String(scopeId).slice(kind.length + 1);
    if (kind === "channel" || kind === "group") return rest.startsWith("#") ? rest : "#" + rest;
    if (kind === "personal") {
      const local = rest.split("@")[0];
      return /^[a-z]/.test(local) ? local[0].toUpperCase() + local.slice(1) : local || rest;
    }
    return rest || scopeId;
  }
  function scopeCell(id, extraCls) {
    const lbl = dirLabel(id);
    return { node: stacked(lbl || id, lbl ? id : ""), cls: "mono" + (extraCls ? " " + extraCls : "") };
  }
  const orgWideView = () => scopeKind(scope) === "org";
  function scopeRows() {
    const rows = (scopeDir || []).filter((s) => scopeKind(s.scopeId) !== "org");
    if (scopeKind(scope) !== "org" && !rows.some((s) => s.scopeId === scope)) rows.unshift({ scopeId: scope });
    return rows;
  }
  function selectScope(id) {
    if (id !== scope) {
      const next = { view, scope: id, session: null, page: 1 };
      if (view === "history") next.historyKind = historyKind;
      go(next);
    }
  }
  function pageShell(opts = {}) {
    const bar = $("shellbar");
    bar.textContent = "";
    const logView = LOG_VIEWS.has(view);
    bar.classList.toggle("logs-shell", logView);
    const counts = el("div.log-counts");
    const countText = (label, value) => {
      const number = Number(value);
      const noun = number === 1 ? label.replace(/s$/, "") : label;
      const amount = Number.isFinite(number) ? number.toLocaleString() : String(value);
      return el("span.log-count", amount + " " + noun.toLowerCase());
    };
    if (opts.back) {
      const back = el("button.back", { type: "button", onclick: opts.back.onClick }, backArrow());
      back.append(el("span", opts.back.label.replace(/^←\s*/, "")));
      bar.appendChild(el("div.shell-back-row", {}, back));
    }
    if (opts.title) bar.appendChild(el("h2.shell-title", opts.title));
    if (logView) bar.appendChild(counts);
    if (opts.context) {
      const c = opts.contextGo ? navLink(opts.context, opts.contextGo) : el("span", opts.context);
      c.classList.add("shell-context");
      bar.appendChild(c);
    }
    if (opts.tabs && opts.tabs.length) {
      const wrap = el("div.shell-tabs" + (view === "judgments" ? " judgment-filters" : ""));
      for (const tab of opts.tabs)
        wrap.appendChild(
          el("button.shell-tab" + (tab.active ? " active" : ""), {
            type: "button",
            "aria-pressed": String(!!tab.active),
            textContent:
              logView || tab.count == null ? tab.label : tab.label + " " + Number(tab.count).toLocaleString(),
            onclick: tab.onClick,
          }),
        );
      const active = opts.tabs.find((tab) => tab.active);
      if (logView && active?.count != null) {
        let noun = active.label;
        if (view === "judgments") noun = "judgments";
        else if (active.label === "Background") noun = "background runs";
        counts.appendChild(countText(noun, active.count));
      }
      bar.appendChild(wrap);
    } else if (opts.count != null && opts.count !== "") {
      const c = el("span.shell-count", String(opts.count));
      const match = String(opts.count).match(/^([\d,.]+\+?)\s*(.*)$/);
      if (!logView) bar.appendChild(c);
      else counts.appendChild(match ? countText(match[2] || "records", match[1].replaceAll(",", "")) : c);
    }
    if (logView) (opts.stats || []).forEach(([value, label]) => counts.appendChild(countText(label, value)));
    bar.appendChild(el("span.shell-spacer"));
    if (!logView && opts.stats && opts.stats.length) bar.appendChild(kpis(opts.stats, "shell-stats"));
    if (opts.search) bar.appendChild(searchField(opts.search));
    (opts.actions || []).forEach((n) => bar.appendChild(n));
  }
  function transcriptEntryHidden(kinds, visibility = transcriptVisibility) {
    return (
      (!visibility.thinking && kinds.includes("Reasoning")) ||
      (!visibility.toolResults && kinds.some((kind) => kind === "ToolCall" || kind === "ToolResult"))
    );
  }
  function navLink(label, target) {
    return el("a.link", { textContent: label, href: stateToUrl(target), onclick: linkClick(() => go(target)) });
  }
  function defaultShell(extras = {}) {
    extras = { actions: view === "credentials" ? [scAddButton] : [], ...extras };
    const title = VIEW_TITLE[view] || titleCase(view);
    if (!SCOPED_VIEWS.has(view) || orgWideView()) return pageShell({ title, ...extras });
    const back = () =>
      go({ view, scope: "org:" + orgId, session: null, page: 1, ...(view === "history" && { historyKind }) });
    pageShell({ back: { label: "← " + title, onClick: back }, title: shortName(scope), ...extras });
  }
  const orgOwnView = () => orgWideView() && urlToState().own === "1";
  function openScopeRow(scopeId, extra = {}) {
    if (scopeKind(scopeId) === "org") return go({ view, scope: scopeId, own: "1", session: null, page: 1, ...extra });
    selectScope(scopeId);
  }
  window.addEventListener("focus", () => {
    if (!root.isConnected) return;
    if (view === "slack-settings") return void governanceUI.integrations.loadSlackInstallation();
    if (isGovLike(view) || view === "connectors" || view === "user") return;
    if (Date.now() - (viewLoadedAt[view] || 0) < 60000) return;
    if (view === "memory" && !(orgWideView() && urlToState().mem !== "edit")) return;
    if (view === "history" && urlToState().session) return;
    if (view === "onboarding") return void governanceUI.onboarding.load();
    if (view === "slack" && !urlToState().container) governanceUI.slackActivity.renderSlackMirror(urlToState());
    if (view === "slack" || (view === "crons" && cronDestinationEditId)) return;
    renderData();
  });
  let loadedGovernanceScope = null;
  let governanceReadyScope = null;
  let loadedCommandPolicyPresent = false;
  let serviceCredDirectory = [];
  let serviceCredChannels = [];
  settings.configureSoul({
    restore: async (revision) => {
      const immutable = { ...revision };
      const targetScope = scope;
      const targetGeneration = governanceReq;
      const draftBefore = JSON.stringify(settings.collect("soul"));
      const expectedVersion = settings.collect("soul").expectedVersion;
      const confirmed = await reviewGovernanceChange({
        title: "Restore SOUL version " + immutable.version + "?",
        subtitle: "The saved instructions from this revision will replace the current SOUL.",
        facts: [
          ["Scope", governanceScopeName(targetScope)],
          ["Current", "Version " + expectedVersion],
          ["Restore", "Version " + immutable.version],
        ],
        warning:
          "This does not erase history. A new revision will be created, and future turns will use it immediately.",
        confirmLabel: "Restore version " + immutable.version,
        danger: true,
      });
      if (!confirmed || scope !== targetScope || governanceReq !== targetGeneration) return;
      setStatus("st-soul", "Restoring…", "saving", true);
      const r = await api("PUT", scopeUrl(targetScope, "/soul"), {
        content: immutable.content,
        expectedVersion,
      });
      if (scope !== targetScope || governanceReq !== targetGeneration) return;
      if (!r.ok) {
        if (r.status === 409) await refreshSoulConflict();
        return setStatus(
          "st-soul",
          r.status === 409
            ? "SOUL changed; latest revision loaded and your draft was preserved."
            : r.data?.message || "Restore failed.",
          "err",
          true,
        );
      }
      const fresh = await api("GET", viewUrl(targetScope, "customize"));
      if (scope !== targetScope || governanceReq !== targetGeneration) return;
      if (!fresh.ok)
        return setStatus("st-soul", "Restored, but the latest version could not be refreshed.", "warn", true);
      if (JSON.stringify(settings.collect("soul")) === draftBefore) settings.load(fresh.data, targetScope, "soul");
      else settings.refreshSoul(fresh.data);
      sectionSnapshots.set("soul", settings.states.get("soul").baseline);
      if (!settings.states.get("soul").dirty)
        setStatus("st-soul", "Version " + immutable.version + " restored as a new revision", "ok", true);
    },
  });
  function renderEnvironmentNotice(data) {
    const notice = $("environment-notice");
    const attachment = data?.environmentAttachment;
    notice.classList.toggle("hidden", !attachment);
    if (!attachment) return;
    const name = attachment.environmentName || shortName(attachment.environmentId);
    $("environment-notice-title").textContent = "Uses named environment " + name;
    $("environment-notice-detail").textContent =
      "Computer files and working memory resolve to this environment. Governance and conversation history remain scoped here.";
    $("environment-notice-open").textContent = "Open " + name;
    $("environment-notice-open").onclick = () =>
      go({ view: "governance", scope: attachment.environmentId, session: null, page: 1 });
  }
  function setGovernancePending(pending) {
    const root = $("view-governance");
    if (pending) $("governance-loading").textContent = "Loading settings…";
    root.classList.toggle("governance-pending", pending);
    root.setAttribute("aria-busy", String(pending));
    $("governance-loading").classList.toggle("hidden", !pending);
  }
  let governanceReq = 0;
  async function loadScope() {
    const requestedScope = scope;
    const requestedView = view;
    const requestId = ++governanceReq;
    const scopeChanged = scope !== loadedGovernanceScope;
    if (requestedView === "credentials") {
      serviceCredList = [];
      settings.credentialLoading();
      void loadPersonalKeychainSummary(requestId, requestedScope);
    }
    const r = await api("GET", viewUrl(scope, requestedView));
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
    if (!r.ok) {
      const denied = r.status === 403 ? "You don't administer this scope." : null;
      if (requestedView === "credentials") settings.credentialLoading(denied || "Could not load credentials.", true);
      if (requestedView === "governance" && governanceReadyScope !== requestedScope)
        $("governance-loading").textContent = denied || "Could not load settings. Select Governance to retry.";
      return setStatus("st-policy", denied || r.data?.message || "Failed to load.", "err");
    }
    if (requestedView === "governance") {
      renderEnvironmentNotice(r.data);
      loadedCommandPolicyPresent = r.data.commandPolicy != null;
      governanceUI.load(r.data, scope);
      if (scopeChanged) $("auto-flagger-test-result").hidden = true;
    }
    if (requestedView === "customize") {
      savedBranding = r.data.branding || {};
      settings.load(r.data, scope, "soul");
      settings.load(r.data, scope, "branding");
      void settings.loadFlags(r.data, scope);
      settings.loadDecisions(r.data, scope);
    }
    if (requestedView === "slack-settings") governanceUI.integrations.loadScope(r.data, scope);
    const opts = r.data.baseModelOptions || [];
    if (requestedView === "models") {
      for (const key of "runtime cron-runtime subagent-runtime fallback-runtime webui-models memory-embedding-model".split(
        " ",
      ))
        settings.load(r.data, scope, key);
      void settings.loadProviders();
    }
    if (requestedView === "credentials") {
      loadServiceCredDirectory(r.data);
      renderServiceCreds(r.data.serviceCredentials || []);
      void loadServiceCredentialUsage(requestedScope, requestId);
    }
    if (scopeChanged) resetScForm();
    if (requestedView === "governance") {
      governanceReadyScope = requestedScope;
      setGovernancePending(false);
      flattenGovernanceCards();
    }
    loadedGovernanceScope = scope;
    initCustomDropdowns($("view-governance"));
    captureGovernanceSnapshots();
    if (r.data.modelCatalogRefreshing) {
      void api("GET", viewUrl(requestedScope, requestedView) + "&catalog=refresh")
        .then((fresh) => {
          if (!fresh.ok || requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
          for (const model of fresh.data.baseModelOptions || []) {
            const existing = opts.findIndex((candidate) => candidate.id === model.id);
            if (existing < 0) opts.push(model);
            else opts[existing] = model;
          }
          if (requestedView === "governance") governanceUI.updateCatalog(fresh.data);
          settings.updateCatalog(r.data);
          initCustomDropdowns($("view-governance"));
        })
        .catch((error) => console.warn("[swallowed] admin: model catalog refresh", error));
    }
  }
  async function refreshSoulConflict() {
    const fresh = await api("GET", viewUrl(scope, view));
    if (!fresh.ok) return false;
    settings.refreshSoul(fresh.data);
    sectionSnapshots.set("soul", settings.states.get("soul").baseline);
    return true;
  }
  async function refreshServiceCredentialConflict() {
    const requestedScope = scope;
    const requestedView = view;
    const requestId = ++governanceReq;
    const fresh = await api("GET", viewUrl(scope, view));
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view || !fresh.ok) return false;
    loadServiceCredDirectory(fresh.data);
    const credentials = fresh.data.serviceCredentials || [];
    const refreshedEditing = credentials.find((credential) => credential.slug === scEditing);
    if (refreshedEditing) credentialState.version = refreshedEditing.updatedAt;
    renderServiceCreds(credentials);
    void loadServiceCredentialUsage(requestedScope, requestId);
    credentialState.render();
    credentialState.changed();
    return refreshedEditing ? "present" : "missing";
  }
  function loadServiceCredDirectory(data) {
    serviceCredDirectory = data.directoryMembers || [];
    serviceCredChannels = data.directoryChannels || [];
    $("sc-people-options").replaceChildren(
      ...serviceCredDirectory.map((member) =>
        Object.assign(new Option(), { value: member.principalId, label: member.displayName }),
      ),
    );
  }
  let savedBranding = {};
  settings.configureDecisions({
    save: (targetScope, body) => api("PUT", scopeUrl(targetScope, "/decisions"), body),
  });
  settings.configureFlags({
    buildSelector: buildScopeMultiSelect,
    loadChoices: async () => {
      if (!scopeDir) await loadScopeDirectory();
      return (scopeDir || []).map((row) => ({ scopeId: row.scopeId, label: row.label || row.scopeId }));
    },
    save: (targetScope, body) => api("PUT", scopeUrl(targetScope, "/feature-flags"), body),
  });
  let scEditing = null;
  let serviceCredList = [];
  async function loadServiceCredentialUsage(requestedScope, requestId) {
    if (!serviceCredList.length) return;
    const result = await api("GET", scopeUrl(requestedScope, "/credential-usage"));
    if (requestId !== governanceReq || requestedScope !== scope || view !== "credentials") return;
    const summaries = new Map((result.data?.summaries || []).map((summary) => [summary.slug, summary]));
    renderServiceCreds(
      serviceCredList.map((credential) => ({
        ...credential,
        ...(result.ok ? summaries.get(credential.slug) : {}),
        usageUnavailable: !result.ok || !summaries.has(credential.slug),
      })),
    );
  }
  settings.configureCredentials({
    label: serviceCredentialPrincipalLabel,
    edit: loadScForm,
    remove: deleteSc,
    reload: loadScope,
  });
  function renderServiceCreds(list) {
    serviceCredList = list;
    settings.loadCredentials(list, serviceCredDirectory, serviceCredChannels, scopeDir || [], scope);
  }
  function loadScForm(c) {
    if (c) scEditing = c.slug;
    credentialState.begin(c);
    openScDialog();
    $("sc-name").focus();
  }
  function resetScForm() {
    const dialog = $("sc-dialog");
    const wasOpen = dialog.open;
    if (wasOpen) dialog.close();
    scStatusHome.appendChild($("st-service-credentials"));
    scEditing = null;
    credentialState.reset();
    if (wasOpen) scAddButton.focus();
  }
  function serviceCredentialPrincipalLabel(grantee) {
    if (grantee.startsWith("org:")) return "Everyone in this organization";
    if (grantee.startsWith("channel:")) {
      const label = dirLabel(grantee);
      return label ? "#" + label + " (" + grantee + ")" : grantee;
    }
    const id = grantee.startsWith("personal:") ? grantee.slice("personal:".length) : grantee;
    const member = serviceCredDirectory.find((candidate) => candidate.principalId === id || candidate.slackId === id);
    return member ? member.displayName + " (" + id + ")" : grantee;
  }
  async function deleteSc(credential) {
    const c = {
      ...credential,
      grantees: [...(credential.grantees || [])],
      recentUsagePrincipals: [...(credential.recentUsagePrincipals || [])],
    };
    const targetScope = scope;
    const principals = c.grantees.some((g) => g.startsWith("org:"))
      ? "everyone in the organization"
      : c.grantees.map(serviceCredentialPrincipalLabel).join(", ");
    let recent = " No successful use appears in the retained window.";
    if (c.usageCount == null || c.usageUnavailable) recent = " Recent usage is unavailable.";
    else if (c.recentUsagePrincipals.length)
      recent =
        " Recent users in the retained window: " +
        c.recentUsagePrincipals.map((id) => serviceCredentialPrincipalLabel("personal:" + id)).join(", ") +
        ".";
    const confirmed = await reviewGovernanceChange({
      title: "Delete “" + (c.name || c.slug) + "”?",
      subtitle: "This credential currently grants broker access to " + principals + "." + recent,
      facts: [
        ["Scope", governanceScopeName(targetScope)],
        ["Credential", c.name || c.slug],
        ["Slug", c.slug],
      ],
      warning:
        "Deletion immediately revokes every grant and removes the stored secret. Existing agent work that depends on “" +
        c.slug +
        "” will fail. This cannot be undone.",
      confirmLabel: "Delete credential",
      danger: true,
    });
    if (!confirmed || targetScope !== scope) return;
    const r = await api("PUT", scopeUrl(targetScope, "/service-credentials"), {
      slug: c.slug,
      delete: true,
      expectedUpdatedAt: c.updatedAt,
    });
    if (targetScope !== scope) return;
    if (r.ok) {
      resetScForm();
      await loadScope();
      return setStatus("st-service-credentials", "Deleted", "ok");
    }
    const conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
    let message = r.data?.message || "Delete failed.";
    if (r.status === 409 && conflictState)
      message = "Credential changed; the latest state is shown. Review it before deleting.";
    else if (r.status === 409)
      message = "Credential changed, but the latest state could not be loaded. Refresh the page before deleting.";
    setStatus("st-service-credentials", message, "err");
  }
  scAddButton.onclick = () => {
    resetScForm();
    loadScForm(null);
  };
  $("sc-reset").onclick = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-save").onclick = async () => {
    const status = (message, kind, sticky) => setStatus("st-service-credentials", message, kind, sticky);
    const unreachable = () => {
      credentialState.changed();
      status(
        "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
        "err",
        true,
      );
    };
    const body = credentialState.collect();
    const targetScope = scope;
    const invalid = credentialState.validate(body);
    if (invalid) return status(invalid, "err");
    $("sc-save").disabled = true;
    status("Saving...", "saving", true);
    let r;
    try {
      r = await api("PUT", scopeUrl(targetScope, "/service-credentials"), body);
    } catch {
      if (targetScope === scope) unreachable();
      return;
    }
    if (scope !== targetScope) return;
    if (r.ok) {
      await loadScope();
      if (scope !== targetScope) return;
      credentialState.commit(body);
      if (!credentialState.dirty) resetScForm();
      return status("Saved", "ok");
    }
    let conflictState;
    try {
      conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
    } catch {
      return unreachable();
    }
    credentialState.changed();
    let message = r.data?.message || "Save failed.";
    if (r.status === 403) message = "Not authorized for this scope.";
    else if (r.status === 409 && conflictState === "missing")
      message =
        "This credential was deleted elsewhere. Your draft is preserved, but it remains an edit and cannot recreate the credential. Cancel the edit before creating a new credential.";
    else if (r.status === 409 && conflictState === "present")
      message = "Credential changed; latest revision loaded and your draft was preserved.";
    else if (r.status === 409)
      message =
        "Credential changed, but the latest revision could not be loaded. Your draft is preserved; refresh the page before retrying.";
    status(message, "err");
  };
  governanceUI.onboarding.configure({
    api,
    orgScope: () => orgScope(),
    connectorName: (id) => connectorName(id),
    view: () => view,
    loadCustomProviders: () => settings.loadProviders(),
    loaded: () => {
      viewLoadedAt.onboarding = Date.now();
    },
    navigate: (target) => openOnboardingTarget(target),
  });
  settings.configureProviders({
    api,
    refresh: async () => {
      await settings.loadProviders();
      if (view !== "models") return;
      const requestedScope = scope;
      const requestedGeneration = governanceReq;
      const fresh = await api("GET", viewUrl(requestedScope, "models"));
      if (fresh.ok && scope === requestedScope && view === "models" && governanceReq === requestedGeneration)
        settings.updateCatalog(fresh.data);
    },
  });
  async function loadPersonalKeychainSummary(requestId, requestedScope) {
    settings.keychainSummary(null);
    const res = await api("GET", "/api/keychain?summary=1");
    if (requestId !== governanceReq || requestedScope !== scope || view !== "credentials") return;
    settings.keychainSummary(res.ok ? res.data : null);
  }
  function openOnboardingTarget(target) {
    setView(target === "slack" ? "slack-settings" : "connectors");
    const card = target === "slack" ? "card-slack-installation" : "card-connectors";
    setTimeout(() => $(card)?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  }
  const connectorName = (id) => (id === "x" ? "X" : id.charAt(0).toUpperCase() + id.slice(1));
  const orgScope = () => "org:" + orgId;
  governanceUI.integrations.configure({ api, orgScope, connectorName });
  governanceUI.integrations.mountBuiltIns();
  $("policy-test-open").onclick = () => {
    $("policy-test-dialog").showModal();
    $("policy-sample").focus();
  };
  $("policy-test-close").onclick = () => $("policy-test-dialog").close();
  async function simulatePolicy() {
    const command = $("policy-sample").value;
    const result = $("policy-result");
    const show = (tone, text) => {
      result.dataset.tone = tone;
      result.textContent = text;
    };
    if (!command.trim()) return show("", "Enter a sample command first.");
    let policy;
    try {
      policy = governanceUI.collect("command-policy");
    } catch (err) {
      return show("danger", err instanceof Error ? err.message : "Policy is invalid.");
    }
    $("policy-simulate").disabled = true;
    show("", "Evaluating with the server’s command scanner…");
    const simulateBody = { command };
    if (loadedCommandPolicyPresent || $("card-command-policy").classList.contains("dirty"))
      simulateBody.policy = policy;
    const response = await api("PUT", scopeUrl(scope, "/command-policy-simulate"), simulateBody);
    $("policy-simulate").disabled = false;
    if (!response.ok) return show("danger", response.data?.message || "Simulation failed.");
    const { decision, ruleSource, ruleIndex, matched, reason } = response.data;
    let rule = "No scope-policy rule matches";
    if (ruleSource === "organization") rule = "Organization rule " + (ruleIndex + 1) + " matches";
    else if (ruleSource === "scope") rule = "This scope’s rule " + (ruleIndex + 1) + " matches";
    if (matched && (ruleSource === "organization" || ruleSource === "scope")) rule += " “" + matched + "”";
    const outcome = " → " + (EFFECT_LABELS[decision] || decision) + (reason ? " · " + reason : "");
    show(pick({ allow: "ok", deny: "danger" }, decision, "warn"), rule + outcome);
  }
  $("policy-simulate").onclick = simulatePolicy;
  $("policy-sample").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      simulatePolicy();
    }
  });
  const statusIdOf = (key) =>
    ({ "command-policy": "st-policy", "org-ambient": "st-governance-org-ambient" })[key] || "st-" + key;
  const sectionSnapshots = new Map();
  function autoFlaggerTestSummary(data) {
    if (!data.sampled) return data.message || "No past screenings to replay yet.";
    const pct = (value) => (value == null ? "n/a" : (value * 100).toFixed(1) + "%");
    const parts = ["Flagged " + data.flagged + " of " + data.scored + " scored (" + pct(data.flagRate) + ")"];
    if (data.baseline) {
      parts.push(
        "current rubric flags " +
          pct(data.baseline.flagRate) +
          " · " +
          plural(data.baseline.changed, "verdict") +
          " changed",
      );
    }
    if (data.unscreened) parts.push(plural(data.unscreened, "sample") + " came back unscreened");
    if (data.errors) parts.push(plural(data.errors, "sample") + " errored");
    if (data.partial) parts.push("stopped at the time limit — partial result");
    parts.push("sampled " + data.sampled + " · " + Math.round(data.durationMs / 100) / 10 + "s");
    return parts.join(" · ");
  }
  function captureGovernanceSnapshots() {
    governanceUI.states.forEach((state, key) => {
      sectionSnapshots.set(key, JSON.stringify(state.collect(false)));
      governanceUI.capture(key);
    });
  }
  function governanceSaveReview(key, body) {
    const before = () => JSON.parse(sectionSnapshots.get(key) || "{}");
    const review = (current, proposed, options) =>
      reviewGovernanceChange({
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", current],
          ["Proposed", proposed],
        ],
        ...options,
      });
    if (key === "security-posture") {
      const dangerous = body.posture === "dangerous";
      return review(titleCase(before().posture || "auto"), titleCase(body.posture), {
        title: dangerous ? "Enable Dangerous autonomy?" : "Change security posture?",
        subtitle: "Review the immutable change below before it is applied.",
        warning: dangerous
          ? "Dangerous disables posture-based content screening and tool approval gates. Deployment-required screening still applies. Predeclared command approvals, hard denials, identity, authorization, credential scope, revocation, and audit remain enforced."
          : "This changes the effective tools and approval behavior for future turns in this scope.",
        confirmLabel: dangerous ? "Enable Dangerous" : "Apply posture",
        danger: dangerous,
      });
    }
    if (key === "sharing-posture") {
      const open = body.posture === "open";
      return review(titleCase(before().posture || "isolated"), titleCase(body.posture), {
        title: open ? "Enable Open sharing?" : "Return to Isolated sharing?",
        subtitle: "This applies to future live human turns in the selected scope.",
        warning: open
          ? "Open can reveal a speaker's private information in shared replies. It does not carry credentials, history, writes, automation, or another person's resources. Organization, personal, and room policy must all allow it."
          : "Cross-context resources will again require explicit shares or grants.",
        confirmLabel: open ? "Enable Open" : "Use Isolated",
        danger: open,
      });
    }
    if (key === "external-slack-participants") {
      const label = (on) => (on ? "External audiences enabled" : "Internal only");
      return review(label(!!before().on), label(body.on), {
        title: body.on ? "Allow external Slack audiences?" : "Return Slack to internal-only?",
        subtitle: "This organization-wide audience boundary applies to future Slack turns.",
        warning: body.on
          ? "Agent replies and anything read in a mixed Slack room can be visible to guests or Slack Connect participants. External users still cannot drive the agent."
          : "Mixed-audience Slack rooms will stop receiving agent replies after this change.",
        confirmLabel: body.on ? "Allow external audiences" : "Require internal audiences",
        danger: !!body.on,
      });
    }
    return Promise.resolve(true);
  }
  $("sharing-posture-inherit").onclick = async () => {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const stale = () => requestedScope !== scope || requestedGeneration !== governanceReq;
    const draftBefore = JSON.stringify(governanceUI.collect("sharing-posture"));
    const confirmed = await reviewGovernanceChange({
      title: "Follow organization sharing?",
      subtitle: "Remove this scope's sharing override.",
      facts: [["Scope", governanceScopeName()]],
      warning:
        "The organization's sharing setting will apply. A personal or room Isolated override still takes precedence.",
      confirmLabel: "Follow organization",
    });
    if (!confirmed || stale()) return;
    const result = await api("PUT", scopeUrl(requestedScope, "/sharing-posture"), { inherit: true });
    if (stale()) return;
    if (result.ok)
      await refreshPolicySetting("sharing-posture", requestedScope, requestedGeneration, draftBefore, "Saved");
    else setStatus("st-sharing-posture", "Could not reset sharing.", "err");
  };
  async function refreshPolicySetting(key, requestedScope, requestedGeneration, draftBefore, message) {
    const fresh = await api("GET", viewUrl(requestedScope, "governance"));
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (!fresh.ok) return governanceUI.status(key, "Saved, but the current setting could not be refreshed.", "warn");
    const state = governanceUI.states.get(key);
    const currentDraft = state.collect();
    const changed = JSON.stringify(currentDraft) !== draftBefore;
    governanceUI.load(fresh.data, requestedScope, key);
    sectionSnapshots.set(key, state.baseline);
    if (changed) {
      state.draft = currentDraft;
      state.changed();
    } else governanceUI.status(key, message, "ok");
  }
  let governanceSaveSeq = 0;
  $("auto-flagger-test").onclick = async () => {
    const requestedScope = scope;
    const button = $("auto-flagger-test");
    $("auto-flagger-test-result").hidden = false;
    const requested = Number($("auto-flagger-window").value);
    if (!Number.isInteger(requested) || requested < 1 || requested > 500)
      return setStatus("st-auto-flagger-test", "Window must be a whole number between 1 and 500.", "err", true);
    setStatus("st-auto-flagger-test", "Replaying the last " + requested + " screenings through this rubric…", "", true);
    button.disabled = true;
    try {
      const r = await api("POST", scopeUrl(requestedScope, "/auto-flagger/test"), {
        window: requested,
        compare: $("auto-flagger-compare").checked,
        modelId: $("auto-flagger-model").value,
        rubric: $("auto-flagger-rubric").value,
      });
      if (requestedScope !== scope) return;
      if (!r.ok) return setStatus("st-auto-flagger-test", r.data?.message || "Test run failed.", "err", true);
      setStatus("st-auto-flagger-test", autoFlaggerTestSummary(r.data), r.data.errors ? "warn" : "ok", true);
    } finally {
      button.disabled = false;
    }
  };
  $("auto-flagger-reset").onclick = async () => {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const draftBefore = JSON.stringify(governanceUI.collect("auto-flagger"));
    const r = await api("PUT", scopeUrl(requestedScope, "/auto-flagger"), {
      reset: true,
    });
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (!r.ok) return setStatus("st-auto-flagger", r.data?.message || "Reset failed.", "err");
    await refreshPolicySetting("auto-flagger", requestedScope, requestedGeneration, draftBefore, "Default restored");
  };
  async function saveSetting(key, btn) {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const stale = () => requestedScope !== scope || requestedGeneration !== governanceReq;
    let body;
    try {
      body = governanceUI.collect(key);
    } catch (err) {
      return setStatus(statusIdOf(key), err instanceof Error ? err.message : "Could not save.", "err");
    }
    if (!(await governanceSaveReview(key, body)) || stale()) return;
    const saveRequest = String(++governanceSaveSeq);
    if (btn) {
      btn.dataset.saveRequest = saveRequest;
      btn.disabled = true;
    }
    setStatus(statusIdOf(key), "Saving...", "saving", true);
    const isBranding = key === "branding";
    const brandingBody = isBranding ? { ...savedBranding, ...body } : body;
    const r = await api("PUT", scopeUrl(requestedScope, "/" + (isBranding ? "branding" : key)), brandingBody);
    if (requestedGeneration !== governanceReq) return;
    if (requestedScope !== scope) {
      if (btn && btn.dataset.saveRequest !== saveRequest) return;
      if (btn) {
        delete btn.dataset.saveRequest;
        btn.disabled = !btn.classList.contains("dirty");
      }
      return setStatus(statusIdOf(key), "", "");
    }
    if (btn?.dataset.saveRequest === saveRequest) delete btn.dataset.saveRequest;
    if (!r.ok) {
      const soulConflict = key === "soul" && r.status === 409;
      if (soulConflict) await refreshSoulConflict();
      let message = r.data?.message || "Save failed.";
      if (soulConflict) message = "SOUL changed; latest revision loaded and your draft was preserved.";
      else if (r.status === 403) message = "Not authorized for this scope.";
      return setStatus(statusIdOf(key), message, "err");
    }
    governanceUI.commit(key, body);
    sectionSnapshots.set(key, JSON.stringify(body));
    if (isBranding) {
      savedBranding = brandingBody;
      if (!hasGovernanceDraft()) location.reload();
      return;
    }
    if (key === "soul") {
      const fresh = await api("GET", viewUrl(requestedScope, "customize"));
      if (stale()) return;
      if (!fresh.ok) return governanceUI.status(key, "Saved, but the latest version could not be refreshed.", "warn");
      settings.refreshSoul(fresh.data);
      sectionSnapshots.set(key, governanceUI.states.get(key).baseline);
      if (!governanceUI.states.get(key).dirty) governanceUI.status(key, "Saved", "ok");
      return;
    }
    if (key === "command-policy") loadedCommandPolicyPresent = true;
    if (!["security-posture", "sharing-posture", "ambient-policy", "auto-flagger"].includes(key)) return;
    const fresh = await api("GET", viewUrl(requestedScope, "governance"));
    if (stale() || !fresh.ok || governanceUI.states.get(key).dirty) return;
    governanceUI.load(fresh.data, requestedScope, key);
    sectionSnapshots.set(key, JSON.stringify(governanceUI.collect(key)));
    governanceUI.status(key, "Saved", "ok");
  }
  document.querySelectorAll("[data-save]").forEach((btn) => {
    btn.onclick = () => saveSetting(btn.dataset.save, btn);
  });
  settings.configureRuntimes({ save: (key) => saveSetting(key) });
  const credentialEdited = (e) => {
    if (e.target.matches("input, textarea, select") && e.target.closest("#card-service-credentials"))
      credentialState.changed();
  };
  $("view-governance").addEventListener("input", credentialEdited);
  $("view-governance").addEventListener("change", credentialEdited);
  watchCustomDropdowns($("app-view"));
  const govFlatContent = document.querySelector("#view-governance .governance-content");
  function flattenGovernanceCards() {
    const cards = [...govFlatContent.children];
    const last = cards.findLast((el) => el.matches("section.card") && getComputedStyle(el).display !== "none");
    cards.forEach((el) => el.classList.toggle("flat-last", el === last));
  }
  let govFlatRaf = 0;
  function scheduleGovFlatten() {
    cancelAnimationFrame(govFlatRaf);
    govFlatRaf = requestAnimationFrame(flattenGovernanceCards);
  }
  new MutationObserver(scheduleGovFlatten).observe(root, { attributes: true, attributeFilter: ["data-subview"] });
  new MutationObserver(scheduleGovFlatten).observe(govFlatContent, {
    attributes: true,
    attributeFilter: ["class"],
    subtree: true,
  });
  flattenGovernanceCards();
  resetScForm();
  let dataReq = 0;
  let historyKind = "conversation";
  const dataCache = new Map();
  function paintData(root, data) {
    root.textContent = "";
    if (["files", "memory", "skills", "crons", "deployments"].includes(view))
      return governanceUI.artifacts[view](root, data, artifactContext());
    if (["errors", "audit", "egress"].includes(view))
      return governanceUI.activity[view](root, data, {
        ...helpers(),
        all: orgWideView(),
        scope,
        errorsPageSize: ERRORS_PAGE_SIZE,
      });
    ({ spend: renderSpend, history: renderHistory, users: renderUsers, keychain: renderKeychain })[view](root, data);
  }
  async function renderData() {
    const root = $("view-data");
    const reqId = ++dataReq;
    const ep = view === "history" ? "sessions" : view;
    let path = !SCOPED_VIEWS.has(view) ? `/api/${ep}` : `/api/${ep}?scope=${encodeURIComponent(scope)}`;
    if (view === "memory" && orgWideView() && urlToState().mem !== "edit") path = "/api/memory/scopes";
    if (view === "history") {
      path += `&limit=50&category=${encodeURIComponent(historyCategory(historyKind))}`;
      if (historyCursor) path += `&cursor=${encodeURIComponent(historyCursor)}`;
      const cronSel = urlToState().cron;
      if (historyKind === "cron") path += `&origin=cron` + (cronSel ? `&cron=${encodeURIComponent(cronSel)}` : "");
      if (historyKind === "background") path += "&origin=other_background";
    }
    if (view === "errors") path += `&limit=${ERRORS_PAGE_SIZE}&offset=${(page - 1) * ERRORS_PAGE_SIZE}`;
    if (view === "spend") path += `?${spendQuery(urlToState())}`;
    const cacheable = view !== "memory";
    const cached = cacheable ? dataCache.get(path) : undefined;
    if (cached !== undefined) paintData(root, cached);
    else root.replaceChildren(el("div.loadingline", "Loading " + (VIEW_TITLE[view] || view).toLowerCase() + "..."));
    const r = await api("GET", path);
    if (reqId !== dataReq) return;
    if (!r.ok) {
      const message =
        r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`;
      if (cached === undefined) root.replaceChildren(el("p.empty", message));
      return;
    }
    if (cacheable) dataCache.set(path, r.data);
    viewLoadedAt[view] = Date.now();
    paintData(root, r.data);
  }
  function spendQuery(st) {
    const { from, to, bucket } = governanceUI.spend.spendWindow(st);
    return new URLSearchParams({ from, to, bucket }).toString();
  }
  function clickLink(props) {
    const a = el("a", { rel: "noreferrer", ...props });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  const openUser = (principal) => go({ view: "user", scope, session: null, principal });
  function renderSpend(root, d) {
    governanceUI.spend.spend(root, d, {
      ...helpers(),
      window: governanceUI.spend.spendWindow(urlToState()),
      openCronRuns: (cron, cronScope) =>
        go({ view: "history", scope: cronScope, session: null, historyKind: "cron", cron }),
      setRange: (range) => go({ ...urlToState(), view: "spend", range, from: null, to: null }),
      setCustomRange: (from, to) => go({ ...urlToState(), view: "spend", range: null, from, to }),
      downloadCsv: (breakdown = "entity") =>
        clickLink({
          href:
            API_BASE + "/spend?format=csv&breakdown=" + encodeURIComponent(breakdown) + "&" + spendQuery(urlToState()),
        }),
    });
  }
  async function adminErrors(query) {
    const r = await api("GET", "/api/errors?" + query);
    return r.ok ? r.data?.errors || [] : [];
  }
  async function adminErrorCount(query) {
    const r = await api("GET", "/api/errors?count=1&" + query);
    return r.ok ? Number(r.data?.total || 0) : 0;
  }
  let artifactRenderGeneration = 0;
  function artifactContext() {
    const capturedScope = scope;
    const capturedView = view;
    const capturedRequest = dataReq;
    const generation = ++artifactRenderGeneration;
    const current = () =>
      scope === capturedScope &&
      view === capturedView &&
      dataReq === capturedRequest &&
      generation === artifactRenderGeneration;
    return {
      ...helpers(),
      view,
      scope: capturedScope,
      scopeDir,
      orgWide: orgWideView(),
      index: orgWideView() && !orgOwnView(),
      own: orgOwnView(),
      cron: urlToState().cron,
      apiBase: API_BASE,
      fmtHistoryTime: relTime,
      deploymentHref: (dep) => dep.publicUrl || "",
      stacked,
      invalidate: () => dataCache.clear(),
      reload: () => (current() ? renderData() : Promise.resolve()),
      setCronEditing: (id) => {
        if (current()) cronDestinationEditId = id;
      },
    };
  }
  function buildScopeMultiSelect(choices, selected, onChange) {
    const row = "display:flex; align-items:center; gap:6px; flex-wrap:wrap;";
    const pick = el("div.scopepick", { style: row });
    const labelOf = (id) => (choices.find((c) => c.scopeId === id) || {}).label || dirLabel(id) || id;
    const orgFirst = (ids) =>
      ids.sort((a, b) => {
        if (scopeKind(a) === "org") return -1;
        if (scopeKind(b) === "org") return 1;
        return a.localeCompare(b);
      });
    const changed = () => {
      renderChips();
      renderList();
      onChange();
    };
    const chips = el("div", { style: row });
    const renderChips = () => {
      if (!selected.size)
        return chips.replaceChildren(
          el("span", { style: "font-size:12px; color:var(--muted);", textContent: "no scopes selected" }),
        );
      chips.replaceChildren(
        ...orgFirst([...selected]).map((id) => {
          const remove = el("button", {
            type: "button",
            textContent: "✕",
            "aria-label": "Remove " + labelOf(id),
            style:
              "border:none; background:transparent; cursor:pointer; color:var(--muted); font-size:11px; line-height:1; padding:0 1px;",
            onclick: (e) => {
              e.stopPropagation();
              selected.delete(id);
              changed();
            },
          });
          const style =
            "display:inline-flex; align-items:center; gap:5px; padding:2px 5px 2px 9px; border:1px solid var(--border); border-radius:12px; background:var(--subtle); font-size:12px; white-space:nowrap;";
          return el("span", { style, title: id }, el("span", labelOf(id)), remove);
        }),
      );
    };
    const addBtn = el("button.rowbtn", {
      type: "button",
      textContent: "+ Add scope ▾",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
    });
    const filter = el("input", {
      type: "text",
      placeholder: "Filter scopes…",
      autocapitalize: "none",
      style:
        "width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border); border-radius:var(--radius); font:inherit;",
    });
    filter.spellcheck = false;
    const list = el("div.scope-list", { role: "listbox" });
    const bulkLink = (text, onclick) =>
      el("button", {
        type: "button",
        textContent: text,
        style:
          "border:none; background:transparent; cursor:pointer; color:var(--text); font:inherit; font-size:12px; text-decoration:underline; text-underline-offset:2px; padding:0;",
        onclick,
      });
    const bulk = el(
      "div",
      { style: "display:flex; gap:14px; padding:8px 10px; border-top:1px solid var(--border);" },
      bulkLink("Select all", () => {
        choices.forEach((c) => selected.add(c.scopeId));
        changed();
      }),
      bulkLink("Clear", () => {
        selected.clear();
        changed();
      }),
    );
    const renderList = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = choices.filter(
        (c) => !q || c.label.toLowerCase().includes(q) || c.scopeId.toLowerCase().includes(q),
      );
      if (!shown.length) return list.replaceChildren(el("div.scope-note", "No scopes match."));
      list.replaceChildren(
        ...shown.map((c) => {
          const on = selected.has(c.scopeId);
          const name = el("span.scope-name", {}, stacked(c.label, c.label === c.scopeId ? "" : c.scopeId));
          return el(
            "button.scope-option" + (on ? " selected" : ""),
            {
              type: "button",
              role: "option",
              "aria-selected": String(on),
              title: c.scopeId,
              onclick: () => {
                if (selected.has(c.scopeId)) selected.delete(c.scopeId);
                else selected.add(c.scopeId);
                changed();
                filter.focus();
              },
            },
            name,
            el("span.count", on ? "✓" : ""),
          );
        }),
      );
    };
    const menu = el(
      "div.scope-menu hidden",
      { style: "left:0; right:auto; width:min(320px, 80vw);" },
      el("div.scope-filter", {}, filter),
      list,
      bulk,
    );
    let onDocClick = null;
    const setOpen = (open) => {
      menu.classList.toggle("hidden", !open);
      addBtn.setAttribute("aria-expanded", String(open));
      if (open) {
        filter.value = "";
        renderList();
        filter.focus();
        onDocClick = (e) => {
          if (!pick.contains(e.target)) setOpen(false);
        };
        document.addEventListener("click", onDocClick);
      } else if (onDocClick) {
        document.removeEventListener("click", onDocClick);
        onDocClick = null;
      }
    };
    addBtn.onclick = (e) => {
      e.stopPropagation();
      setOpen(menu.classList.contains("hidden"));
    };
    filter.addEventListener("input", renderList);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        addBtn.focus();
      }
    });
    pick.append(chips, addBtn, menu);
    renderChips();
    return pick;
  }
  const renderKeychain = (root, d) => governanceUI.keychain.keychain(root, d, helpers());
  function renderUsers(root, d) {
    governanceUI.users.users(root, d, {
      ...helpers(),
      confirm: (message) => window.confirm(message),
      orgScope: "org:" + orgId,
      clearCache: () => dataCache.clear(),
    });
  }
  function renderHistory(root, d) {
    governanceUI.history.history(root, d, {
      ...helpers(),
      historyKind,
      cron: urlToState().cron,
      cursor: historyCursor,
      scope,
      orgScope: "org:" + orgId,
      environments: environmentDir,
      title: VIEW_TITLE.history,
      kindLabels: KIND_LABEL,
    });
  }
  let userDetailRequest = 0;
  async function showUserDetail(principalId) {
    const request = ++userDetailRequest;
    const root = $("view-data");
    root.textContent = "";
    return governanceUI.userDetail.detail(root, principalId, {
      ...helpers(),
      confirm: (message) => window.confirm(message),
      current: (principal) => request === userDetailRequest && view === "user" && urlToState().principal === principal,
      reload: showUserDetail,
    });
  }
  let slackContainers = null;
  let slackContainersTruncated = false;
  async function loadSlackContainers() {
    const r = await api("GET", "/api/slack-mirror");
    if (r.ok) {
      slackContainers = r.data.containers || [];
      slackContainersTruncated = !!r.data.hasMore;
    }
    return r;
  }
  function slackContainerLabel(id) {
    const c = (slackContainers || []).find((x) => x.container === id) || {};
    const nm = c.name || null;
    const kind = c.kind || (nm ? "channel" : "");
    if (kind === "channel") return "#" + (nm || id);
    if (kind === "dm") return nm || id;
    if (kind === "group") return nm || ((c.members || []).length ? c.members.length + " people" : id);
    return nm ? "#" + nm : id;
  }
  function slackContainerScope(id) {
    const kind = ((slackContainers || []).find((x) => x.container === id) || {}).kind;
    if (kind === "channel") return "channel:" + id;
    if (kind === "group") return "group:" + id;
    return null;
  }
  function transcriptServices() {
    return {
      ...helpers(),
      scope,
      historyKind,
      pageSize: 500,
      visibility: transcriptVisibility,
      entryHidden: transcriptEntryHidden,
      current: (id, turn) => {
        const st = urlToState();
        return view === "history" && st.session === id && (turn == null ? !st.turn : String(st.turn) === String(turn));
      },
      setObserver: (observer) => {
        transcriptObserver = observer;
      },
    };
  }
  async function downloadFile(f) {
    if (!f.openable) return;
    const check = await api("GET", "/api/files/read?id=" + encodeURIComponent(f.id));
    if (!check.ok) {
      alert(check.data?.message || `Couldn't open file (${check.status}).`);
      return;
    }
    const href = API_BASE + "/files/download?id=" + encodeURIComponent(f.id);
    const mime = (f.mimetype || "").split(";")[0].trim().toLowerCase();
    if (/^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/.test(mime)) {
      window.open(href, "_blank", "noreferrer");
      return;
    }
    clickLink({ href, download: f.name || fileName(f.path) });
  }
  function helpers() {
    return {
      orgId,
      api,
      pageShell,
      defaultShell,
      go,
      stateToUrl,
      urlToState,
      navLink,
      openScopeRow,
      selectScope,
      openUser,
      shortName,
      dirLabel,
      scopeCell,
      scopeRows,
      buildScopeMultiSelect,
      webUiAsButton,
      openWebUiAs,
      adminErrors,
      adminErrorCount,
      downloadFile,
      deliveryFileBadges,
      brandSelfLabel,
      slackContainerLabel,
      slackContainerScope,
      loadSlackContainers,
    };
  }
  governanceUI.slackActivity.configure({
    ...helpers(),
    containers: () => slackContainers,
    truncated: () => slackContainersTruncated,
    view: () => view,
    loaded: () => {
      viewLoadedAt.slack = Date.now();
    },
  });
  route();
  return {
    route,
    show: (v) => (v === "general" ? go({ view: "general", scope, session: null }) : setView(v)),
  };
}
