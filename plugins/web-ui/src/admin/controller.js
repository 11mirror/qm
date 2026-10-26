import * as governanceUI from "./admin.ts";
import { ADMIN_SECTIONS, ADMIN_VIEWS, VIEW_TITLE } from "./sections.ts";
import { ADMIN_MARKUP } from "./markup.ts";

function backArrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m12 19-7-7 7-7M5 12h14");
  svg.appendChild(path);
  return svg;
}

export function startAdmin(host, env) {
  host.innerHTML = ADMIN_MARKUP;
  governanceUI.mountCards();
  const $ = (id) => document.getElementById(id);
  const root = $("app-view");
  const EFFECT_LABELS = { allow: "Allow", deny: "Deny", require_approval: "Require approval" };
  const VIEWS = [...ADMIN_VIEWS];
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
  const fire = (target) =>
    ["input", "change"].forEach((type) => target.dispatchEvent(new Event(type, { bubbles: true })));
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
  const SCOPED = new Set("governance egress history files memory audit errors skills crons deployments".split(" "));
  const ORG_WIDE = new Set(
    "users spend keychain connectors judgments ackemoji models credentials customize slack-settings".split(" "),
  );
  const ERRORS_PAGE_SIZE = 50;
  const brandSelfLabel = () => env.productName;
  const DEFAULT_VIEW = "history";
  const orgId = env.org;
  let scope = "org:" + orgId;
  let view = DEFAULT_VIEW;
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
  const fmtTime = (ts) => new Date(ts).toLocaleString();
  const sameLocalDate = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const fmtClock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  function relTime(ts) {
    if (!ts) return "Never";
    const d = new Date(ts);
    const now = new Date();
    const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (mins >= 0 && mins < 1) return "now";
    if (mins >= 0 && mins < 60) return mins + (mins === 1 ? " min" : " mins");
    if (sameLocalDate(d, now)) return "Today " + fmtClock(d);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (sameLocalDate(d, yesterday)) return "Yesterday " + fmtClock(d);
    return (
      d.toLocaleDateString(
        [],
        d.getFullYear() === now.getFullYear()
          ? { month: "short", day: "numeric" }
          : { month: "short", day: "numeric", year: "numeric" },
      ) +
      ", " +
      fmtClock(d)
    );
  }
  const fmtMs = (n) => {
    if (n == null) return "n/a";
    return n >= 1000 ? (n / 1000).toFixed(2) + " s" : Math.round(n) + " ms";
  };
  const fmtPct = (n) => ((n || 0) * 100).toFixed(1) + "%";
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
  function el(spec, props, ...kids) {
    const [tag, className] = spec.split(".");
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (props === null || typeof props !== "object") node.textContent = props ?? "";
    else
      for (const [key, value] of Object.entries(props)) {
        if (key === "style") node.style.cssText = value;
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
      }
    node.append(...kids);
    return node;
  }
  const pick = (map, key, fallback) => (Object.hasOwn(map, key) ? map[key] : fallback);
  const settings = governanceUI.settings;
  const credentialState = settings.credentialState;
  const badge = (text, kind) => el("span", { className: "badge" + (kind ? " " + kind : ""), textContent: text });
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
  function stacked(primary, secondary, cls) {
    const d = el("div", {}, el("div.primaryline", primary));
    if (cls) d.className = cls;
    if (secondary) d.appendChild(el("div.subline", secondary));
    return d;
  }
  const shortId = (id, len = 8) => String(id || "").slice(0, len) || "-";
  const titleCase = (s) =>
    String(s || "")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());
  const labelRole = (role) => (role === "org_admin" ? "admin" : String(role || "").replace(/_/g, " "));
  const scopeKind = (scopeId) => String(scopeId || "").split(":")[0] || "scope";
  const STATUS_KIND = { done: "ok", failed: "err", running: "info", pending: "warn" };
  const statusBadge = (status) => badge(titleCase(status || "unknown"), pick(STATUS_KIND, status, "muted"));
  const entryIsNoise = (e) => ["tool_call", "tool_result", "soul", "system"].includes(e.type);
  function fileKind(path) {
    const name = String(path || "");
    return name.includes(".") ? "." + name.split(".").pop().toLowerCase() : "file";
  }
  function fileName(path) {
    return (
      String(path || "")
        .split("/")
        .filter(Boolean)
        .pop() || "download"
    );
  }
  async function fileSha256(file) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function uploadErrorMessage(text, fallback) {
    try {
      const parsed = JSON.parse(text);
      return parsed.message || parsed.error || fallback;
    } catch {
      return text.trim() || fallback;
    }
  }
  function stateToUrl(st) {
    const p = new URLSearchParams();
    const withQuery = (path) => {
      const q = p.toString();
      return q ? path + "?" + q : path;
    };
    if ((st.view || DEFAULT_VIEW) === "history") {
      if (st.session) {
        if (st.turn != null) p.set("turn", String(st.turn));
        return withQuery(PAGE_BASE + "/history/s/" + encodeURIComponent(st.session));
      }
      const scopeSegment = st.scope && scopeKind(st.scope) !== "org" ? encodeURIComponent(st.scope) : null;
      const scopeInPath = scopeSegment && !/%2F|%5C/i.test(scopeSegment);
      if (scopeSegment && !scopeInPath) p.set("scope", st.scope);
      if (st.own) p.set("own", st.own);
      if (st.cron) p.set("cron", st.cron);
      if (st.historyKind && st.historyKind !== "conversation") p.set("kind", st.historyKind);
      if (st.cursor) p.set("cursor", st.cursor);
      return withQuery(scopeInPath ? PAGE_BASE + "/history/scopes/" + scopeSegment : PAGE_BASE + "/history");
    }
    const slackSetup = ["connectors", "slack-settings"].includes(st.view);
    if (slackSetup && st.setup === "slack") p.set("setup", "slack");
    if (slackSetup && ["setup", "install", "connected"].includes(st.slack)) p.set("slack", st.slack);
    if (st.scope && SCOPED.has(st.view)) p.set("scope", st.scope);
    if (st.view === "errors" && st.page > 1) p.set("page", st.page);
    if (st.principal) p.set("principal", st.principal);
    if (st.view === "crons" && st.cron) p.set("cron", st.cron);
    if (st.own && SCOPED.has(st.view)) p.set("own", st.own);
    if (st.view === "memory" && st.mem) p.set("mem", st.mem);
    const spendWindow = st.view === "spend" ? governanceUI.spend.spendWindow(st) : null;
    if (spendWindow && spendWindow.preset === null) {
      p.set("from", spendWindow.from);
      p.set("to", spendWindow.to);
    } else if (spendWindow && st.range) p.set("range", spendWindow.preset);
    const logKeys = ["container", "decision", "jid"];
    const extra = { slack: st.container ? ["container", "ts"] : [], judgments: logKeys, ackemoji: logKeys }[st.view];
    for (const key of extra || []) if (st[key]) p.set(key, st[key]);
    return withQuery(st.view === "general" ? PAGE_BASE : PAGE_BASE + "/" + encodeURIComponent(st.view || DEFAULT_VIEW));
  }
  function decodePathSegment(seg) {
    if (!seg) return null;
    try {
      return decodeURIComponent(seg);
    } catch {
      return null;
    }
  }
  function urlToState() {
    const p = new URLSearchParams(location.search);
    const rel = location.pathname.startsWith(PAGE_BASE) ? location.pathname.slice(PAGE_BASE.length) : location.pathname;
    const segs = rel.replace(/^\/+/, "").split("/");
    const fromPath = decodePathSegment(segs[0] ?? "");
    let pathSession = null;
    let pathScope = null;
    if (fromPath === "history") {
      if (segs[1] === "s") pathSession = decodePathSegment(segs[2] ?? "");
      else if (segs[1] === "scopes") pathScope = decodePathSegment(segs[2] ?? "");
    }
    const slackStep = ["setup", "install", "connected"].includes(p.get("slack"));
    const raw = p.get("setup") === "slack" || slackStep ? "slack-settings" : p.get("view") || fromPath;
    const v = raw === "skill-packs" ? "skills" : raw;
    const session = pathSession || p.get("session") || null;
    const kindRaw = p.get("kind");
    const normalizedHistoryKind = ["conversation", "cron", "background"].includes(kindRaw) ? kindRaw : "conversation";
    const turnRaw = p.get("turn");
    let resolvedView = DEFAULT_VIEW;
    if (VIEWS.includes(v)) resolvedView = v;
    else if (session) resolvedView = "history";
    else if (!raw) resolvedView = "general";
    return {
      view: resolvedView,
      setup: p.get("setup"),
      slack: p.get("slack"),
      scope:
        pathScope ||
        p.get("scope") ||
        (resolvedView === "history" || resolvedView === "errors" ? "org:" + orgId : scope),
      session,
      turn: turnRaw == null || turnRaw === "" ? null : turnRaw,
      historyKind: normalizedHistoryKind,
      page: Math.max(1, parseInt(p.get("page"), 10) || 1),
      ...Object.fromEntries(
        ["principal", "cron", "own", "mem", "range", "from", "to", "cursor", "container", "ts", "decision", "jid"].map(
          (key) => [key, p.get(key) || null],
        ),
      ),
    };
  }
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
  const isGovLike = (v) => ["governance", "models", "credentials", "customize", "slack-settings"].includes(v);
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
    if (SCOPED.has(view) && !urlToState().session) {
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
    const logView = ["history", "slack", "judgments", "errors", "audit", "egress", "memory"].includes(view);
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
  function searchField({ placeholder = "Search…", onInput = () => {}, value = "", disabled = false }) {
    const input = el("input", {
      type: "search",
      placeholder,
      "aria-label": placeholder.replace(/[…]+$/, ""),
      autocapitalize: "none",
      value,
      disabled,
      oninput: () => onInput(input.value),
    });
    input.spellcheck = false;
    const icon = el("span.admin-search-icon", {
      "aria-hidden": "true",
      innerHTML:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
    });
    const clear = el("button.icon-button admin-search-clear", {
      type: "button",
      "aria-label": "Clear search",
      textContent: "×",
      disabled,
      onclick: () => {
        input.value = "";
        onInput("");
        input.focus();
      },
    });
    return el("div.shell-search admin-search", {}, input, icon, clear);
  }
  function transcriptEntryHidden(entryTypes, hasDelivery, visibility = transcriptVisibility) {
    return (
      (!visibility.thinking && entryTypes.includes("thinking")) ||
      (!visibility.toolResults &&
        !hasDelivery &&
        entryTypes.some((type) => type === "tool_call" || type === "tool_result"))
    );
  }
  function linkClick(go) {
    return (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go();
    };
  }
  function navLink(label, target) {
    return el("a.link", { textContent: label, href: stateToUrl(target), onclick: linkClick(() => go(target)) });
  }
  function defaultShell(extras = {}) {
    extras = { actions: view === "credentials" ? [scAddButton] : [], ...extras };
    const title = VIEW_TITLE[view] || titleCase(view);
    if (!SCOPED.has(view) || orgWideView()) return pageShell({ title, ...extras });
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
    formatTime: fmtTime,
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
    formatTime: fmtTime,
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
  governanceUI.integrations.configure({ api, orgScope, connectorName, fmtTime });
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
  const DD_CHEVRON =
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const ddNativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  let openDropdown = null;
  let dropdownSequence = 0;
  function closeDropdown(dd) {
    if (!dd) return;
    dd.classList.remove("open");
    const btn = dd.querySelector(".dd-btn");
    btn?.setAttribute("aria-expanded", "false");
    btn?.removeAttribute("aria-activedescendant");
  }
  function upgradeCustomDropdown(sel) {
    if (
      !(sel instanceof HTMLSelectElement) ||
      sel.dataset.ddHost ||
      sel.hasAttribute("hidden") ||
      sel.multiple ||
      sel.size > 1 ||
      sel.closest(".loadout-control")
    )
      return;
    sel.dataset.ddHost = "1";
    const dd = el("div.dd");
    if (sel.getAttribute("style")) dd.setAttribute("style", sel.getAttribute("style"));
    const lab = el("span");
    const menu = el("div.dd-menu", { role: "listbox", id: "dd-menu-" + ++dropdownSequence });
    const btn = el("button", { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" }, lab);
    btn.setAttribute("aria-controls", menu.id);
    btn.insertAdjacentHTML("beforeend", DD_CHEVRON);
    dd.append(btn, menu);
    sel.after(dd);
    let activeIndex = -1;
    const syncLabel = () => {
      const o = sel.selectedOptions[0];
      lab.textContent = o ? o.textContent : "";
      const label = sel.getAttribute("aria-label") || sel.labels?.[0]?.textContent?.trim() || "";
      btn.setAttribute("aria-label", label ? label + ": " + lab.textContent : lab.textContent);
      btn.className = ["dd-btn", ...sel.classList].join(" ");
      btn.disabled = sel.disabled;
    };
    const commit = (value) => {
      if (ddNativeValue.get.call(sel) === value) return;
      ddNativeValue.set.call(sel, value);
      syncLabel();
      fire(sel);
    };
    const enabledOptions = () => Array.from(sel.options).filter((o) => !o.disabled);
    const closeThis = () => {
      closeDropdown(dd);
      openDropdown = null;
    };
    const setActive = (index) => {
      const items = Array.from(menu.querySelectorAll(".dd-item:not(.dis)"));
      activeIndex = items.length ? Math.max(0, Math.min(items.length - 1, index)) : -1;
      items.forEach((it, i) => {
        it.classList.toggle("active", i === activeIndex);
        if (i !== activeIndex) return;
        btn.setAttribute("aria-activedescendant", it.id);
        it.scrollIntoView({ block: "nearest" });
      });
    };
    const buildMenu = () => {
      activeIndex = -1;
      let enabledIndex = 0;
      menu.replaceChildren(
        ...Array.from(sel.options).map((o, i) => {
          const it = el("div", {
            className: "dd-item" + (o.selected ? " sel" : "") + (o.disabled ? " dis" : ""),
            id: menu.id + "-option-" + i,
            role: "option",
            textContent: o.textContent,
            onclick: (e) => {
              e.stopPropagation();
              if (o.disabled) return;
              closeThis();
              commit(o.value);
              btn.focus();
            },
          });
          if (o.selected) it.setAttribute("aria-selected", "true");
          if (!o.disabled && o.selected) activeIndex = enabledIndex;
          if (!o.disabled) enabledIndex += 1;
          return it;
        }),
      );
      setActive(activeIndex);
    };
    const open = () => {
      if (sel.disabled) return;
      if (openDropdown && openDropdown !== dd) closeDropdown(openDropdown);
      buildMenu();
      dd.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      openDropdown = dd;
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = dd.classList.contains("open");
      closeDropdown(openDropdown);
      openDropdown = null;
      if (!wasOpen) open();
    };
    btn.onkeydown = (e) => {
      if (!["Escape", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
      e.preventDefault();
      const isOpen = dd.classList.contains("open");
      if (e.key === "Escape") return closeThis();
      if (e.key === "Enter" && isOpen) {
        const option = enabledOptions()[activeIndex];
        if (option) commit(option.value);
        return closeThis();
      }
      if (e.key !== "Enter" && !enabledOptions().length) return;
      if (!isOpen) return open();
      setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
    };
    Object.defineProperty(sel, "value", {
      get() {
        return ddNativeValue.get.call(sel);
      },
      set(v) {
        ddNativeValue.set.call(sel, v);
        syncLabel();
      },
    });
    new MutationObserver(() => {
      syncLabel();
      if (dd.classList.contains("open")) buildMenu();
    }).observe(sel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "disabled", "label", "selected", "value"],
    });
    sel.addEventListener("change", syncLabel);
    syncLabel();
  }
  document.addEventListener("click", () => {
    closeDropdown(openDropdown);
    openDropdown = null;
  });
  function initCustomDropdowns(root) {
    if (!(root instanceof Element)) return;
    if (root instanceof HTMLSelectElement) upgradeCustomDropdown(root);
    root.querySelectorAll("select").forEach(upgradeCustomDropdown);
  }
  initCustomDropdowns($("app-view"));
  new MutationObserver((muts) =>
    muts.forEach((m) => m.addedNodes.forEach((n) => n instanceof HTMLElement && initCustomDropdowns(n))),
  ).observe($("app-view"), { childList: true, subtree: true });
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
    let path = ORG_WIDE.has(view) ? `/api/${ep}` : `/api/${ep}?scope=${encodeURIComponent(scope)}`;
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
  function kpis(items, className = "") {
    const kpi = ([n, k]) => el("div.kpi", {}, el("div.n", { textContent: n }), el("div.k", { textContent: k }));
    const wrap = el("div.kpis", {}, ...items.map(kpi));
    if (className) wrap.classList.add(className);
    return wrap;
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
  function errorStripBox(errs, headText, max, rowLink) {
    const box = el("div.error-strip", {}, el("div.error-strip-head", headText));
    errs.slice(0, max).forEach((e) => {
      const link = rowLink ? rowLink(e) : null;
      const row = link
        ? el("a.error-strip-row", { href: link.href, onclick: linkClick(link.go) })
        : el("div.error-strip-row");
      const msg = el("span.mono", { textContent: firstLine(e.message || "(no message)", 160), title: e.message || "" });
      const meta = [e.category || "uncategorized", e.code, relTime(e.ts)].filter(Boolean).join(" · ");
      row.append(msg, el("span.subline", meta));
      box.appendChild(row);
    });
    if (errs.length > max) box.appendChild(el("div.subline", "…and " + (errs.length - max) + " more"));
    return box;
  }
  function egressDetail(r) {
    const bits = [];
    if (r.source === "broker") {
      if (r.slug) bits.push("cred:" + r.slug);
      if (r.upstreamStatus != null) bits.push("↑" + r.upstreamStatus);
    } else {
      if (r.via) bits.push(r.via);
      if (r.port != null) bits.push(":" + r.port);
      if (r.peerIp) bits.push(r.peerIp);
    }
    return bits.join(" · ") || "None";
  }
  function cronName(c, previewAction = false) {
    if (!c) return "Cron";
    if (c.title || c.message) return c.title || c.message;
    if (previewAction && c.action) return firstLine(c.action, 96);
    return "Cron " + shortId(c.id);
  }
  function wakeOriginLabel(trigger) {
    const labels = { cron: "Cron", monitor: "Monitor wake", webhook: "Webhook wake" };
    return pick(labels, String(trigger || "").toLowerCase(), "Background wake");
  }
  function plural(n, one, many = one + "s") {
    return `${Number(n || 0).toLocaleString()} ${Number(n || 0) === 1 ? one : many}`;
  }
  const historyCategory = (kind) => (kind === "cron" || kind === "background" ? "background" : kind);
  const KIND_LABEL = { conversation: "Conversations", cron: "Cron runs", background: "Background" };
  const historyModeLabel = (kind) => KIND_LABEL[kind] || KIND_LABEL.conversation;
  function historyKindMatches(s, kind) {
    if (kind === "conversation") return s.category !== "background";
    if (kind === "cron") return s.origin?.kind === "cron";
    if (kind === "background") return s.category === "background" && s.origin?.kind !== "cron";
    return true;
  }
  function cronFieldSet(raw, min, max, dow = false) {
    const values = new Set();
    const pieces = String(raw || "").split(",");
    let any = raw === "*";
    for (const piece of pieces) {
      if (!piece) return null;
      const [base, stepRaw] = piece.split("/");
      const step = stepRaw == null ? 1 : Number(stepRaw);
      if (!Number.isInteger(step) || step <= 0) return null;
      let start, end;
      if (base === "*") {
        start = min;
        end = max;
        any = pieces.length === 1 && step === 1;
      } else if (base.includes("-")) {
        const [a, b] = base.split("-").map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
        start = a;
        end = b;
      } else {
        const n = Number(base);
        if (!Number.isInteger(n)) return null;
        start = dow && n === 7 ? 0 : n;
        end = start;
      }
      if (start < min || end > max || start > end) return null;
      for (let n = start; n <= end; n += step) values.add(dow && n === 7 ? 0 : n);
    }
    const normalized = [...values].filter((n) => n >= min && n <= (dow ? 6 : max)).sort((a, b) => a - b);
    return normalized.length ? { any, values: normalized } : null;
  }
  function humanCron(expr) {
    const clean = String(expr || "")
      .trim()
      .replace(/\s+/g, " ");
    const parts = clean.split(" ");
    if (parts.length !== 5) return "cron " + clean;
    const minutes = cronFieldSet(parts[0], 0, 59);
    const hours = cronFieldSet(parts[1], 0, 23);
    const dom = cronFieldSet(parts[2], 1, 31);
    const months = cronFieldSet(parts[3], 1, 12);
    const dow = cronFieldSet(parts[4], 0, 7, true);
    if (!minutes || !hours || !dom || !months || !dow) return "cron " + clean;
    const minute = minutes.values.length === 1 ? minutes.values[0] : null;
    const hour = hours.values.length === 1 ? hours.values[0] : null;
    if (minute != null && hour != null && dom.any && months.any) {
      const suffix = hour < 12 ? "AM" : "PM";
      const time = (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + suffix;
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const full = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
      if (dow.any) return "daily " + time;
      if (dow.values.join(",") === "1,2,3,4,5") return "weekdays " + time;
      return (dow.values.length === 1 ? full[dow.values[0]] : dow.values.map((d) => days[d]).join(", ")) + " " + time;
    }
    if (minute != null && hours.any && dom.any && months.any && dow.any)
      return minute === 0 ? "hourly" : "hourly at :" + String(minute).padStart(2, "0");
    return "cron " + clean;
  }
  function fmtSchedule(sch) {
    if (!sch) return "None";
    if (sch.cron) {
      const label = humanCron(sch.cron);
      return (
        label +
        (sch.timezone ? " (" + sch.timezone + ")" : " (default timezone)") +
        (label === "cron " + sch.cron ? "" : " · " + sch.cron)
      );
    }
    if (sch.everyMs != null) return shortSchedule(sch);
    return sch.firstFireAt ? "once at " + fmtTime(sch.firstFireAt) : "Never";
  }
  function shortSchedule(sch) {
    if (!sch) return "Never";
    if (sch.cron) {
      const label = humanCron(sch.cron);
      return label.startsWith("cron ") ? sch.cron : label;
    }
    if (sch.everyMs != null) {
      for (const [u, n] of Object.entries({ d: 86400000, h: 3600000, m: 60000, s: 1000 }))
        if (sch.everyMs >= n && sch.everyMs % n === 0) return "every " + sch.everyMs / n + u;
      return "every " + sch.everyMs + " ms";
    }
    return sch.firstFireAt ? "once" : "Never";
  }
  const destinationSummary = (dest) => (dest ? (dest.type || "destination") + " -> " + (dest.target || "-") : "None");
  function destinationDetails(dest) {
    if (!dest) return "No delivery destination";
    const bits = [];
    if (dest.audienceScopeId) bits.push(dest.audienceScopeId);
    if (dest.onBehalfOf) bits.push("on behalf of " + dest.onBehalfOf);
    return bits.join(" / ");
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
  function packRepoLabel(url) {
    try {
      return (
        (url || "")
          .replace(/\.git$/, "")
          .split("/")
          .filter(Boolean)
          .slice(-2)
          .join("/") ||
        url ||
        ""
      );
    } catch {
      return url || "";
    }
  }
  function createdByCell(s) {
    if (s.pack) return { text: packRepoLabel(s.pack.url) || "pack " + shortId(s.pack.id, 8), cls: "mono" };
    if (s.createdBy && s.createdBy.indexOf("system:") === 0) return { text: "built-in", cls: "subline" };
    return { text: s.createdBy || "None", cls: "mono" };
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
  const fmtBytes = (n) => {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  };
  function payloadText(p) {
    if (p == null) return "";
    if (typeof p === "string") return p;
    if (typeof p === "object" && typeof p.text === "string") return p.text;
    if (typeof p === "object" && typeof p.thinking === "string")
      return p.thinking || (p.redacted ? "[redacted thinking]" : "");
    return stringify(p);
  }
  function stringify(x) {
    try {
      return JSON.stringify(x, null, 2);
    } catch {
      return String(x);
    }
  }
  function appendInlineMarkdown(parent, text) {
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    let last = 0;
    for (const m of String(text || "").matchAll(re)) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const [, , bold, code, label, href, em] = m;
      if (bold) parent.appendChild(el("strong", bold));
      else if (code) parent.appendChild(el("code", code));
      else if (label && href)
        parent.appendChild(el("a", { href, target: "_blank", rel: "noopener", textContent: label }));
      else if (em) parent.appendChild(el("em", em));
      last = m.index + m[0].length;
    }
    const rest = text.slice(last);
    if (rest) parent.append(rest);
  }
  function inlineMarkdown(tag, text) {
    const node = el(tag);
    appendInlineMarkdown(node, text);
    return node;
  }
  function renderMarkdown(text) {
    const root = el("div.message-body");
    let para = [];
    let list = null;
    let quote = [];
    let fence = null;
    const flushPara = () => {
      if (para.length) root.appendChild(inlineMarkdown("p", para.join(" ")));
      para = [];
    };
    const flushList = () => {
      if (list) root.appendChild(list.node);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length) root.appendChild(el("blockquote", {}, inlineMarkdown("p", quote.join(" "))));
      quote = [];
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
    };
    const codeBlock = () => root.appendChild(el("pre", {}, el("code", fence.join("\n"))));
    for (const line of String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n")) {
      const fenceMatch = line.match(/^```/);
      const trimmed = line.trim();
      const quoteMatch = trimmed.match(/^>\s?(.*)$/);
      const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
      if (fence && fenceMatch) {
        codeBlock();
        fence = null;
      } else if (fence) fence.push(line);
      else if (fenceMatch) {
        flushAll();
        fence = [];
      } else if (!trimmed) flushAll();
      else if (quoteMatch) {
        flushPara();
        flushList();
        quote.push(quoteMatch[1]);
      } else if (listMatch) {
        flushPara();
        flushQuote();
        const ordered = /\d+\./.test(listMatch[1]);
        if (list?.ordered !== ordered) {
          flushList();
          list = { ordered, node: el(ordered ? "ol" : "ul") };
        }
        list.node.appendChild(inlineMarkdown("li", listMatch[2]));
      } else {
        flushList();
        flushQuote();
        para.push(trimmed);
      }
    }
    if (fence) codeBlock();
    flushAll();
    if (!root.childNodes.length) root.appendChild(el("p"));
    return root;
  }
  const isXmlishText = (text) => /^\s*<[A-Za-z][\w-]*(\s|\/?>)/.test(String(text || ""));
  function renderXmlish(text) {
    const root = el("div.message-body xml-body");
    const row = (cls, depth) => {
      const div = root.appendChild(el("div." + cls));
      div.style.paddingLeft = Math.min(depth, 8) * 18 + "px";
      return div;
    };
    const addText = (s, depth) => {
      const t = s.replace(/^[\s\n]+|[\s\n]+$/g, "");
      if (t) appendInlineMarkdown(row("xml-text", depth), slackUnescape(t.replace(/&quot;/g, '"')));
    };
    const tagRe = /<\/?[A-Za-z][\w-]*(?:\s+[\w-]+(?:="[^"]*")?)*\s*\/?>/g;
    let depth = 0,
      last = 0;
    for (const m of String(text || "").matchAll(tagRe)) {
      addText(text.slice(last, m.index), depth);
      const tok = m[0];
      const closing = tok.startsWith("</");
      if (closing) depth = Math.max(0, depth - 1);
      row("xml-tag" + (closing ? " closing" : ""), depth).textContent = tok;
      if (!closing && !tok.endsWith("/>")) depth += 1;
      last = m.index + tok.length;
    }
    addText(text.slice(last), depth);
    return root;
  }
  function firstLine(text, max = 120) {
    const line =
      String(text || "")
        .split("\n")
        .find((x) => x.trim()) ||
      String(text || "").split("\n")[0] ||
      "";
    const compact = line.trim().replace(/\s+/g, " ");
    return compact.length > max ? compact.slice(0, Math.max(0, max - 3)) + "..." : compact;
  }
  function payloadName(p) {
    return p && typeof p === "object" && typeof p.name === "string" ? p.name.trim() : "";
  }
  function toolName(callPayload, resultPayload) {
    return String(callPayload.tool || resultPayload.tool || callPayload.name || resultPayload.name || "tool");
  }
  function toolLabelText(tool, callPayload, resultPayload) {
    if (tool === "background") {
      const action = callPayload.action || resultPayload.action;
      return action ? `background ${action}` : "background";
    }
    return tool;
  }
  function toolStatusMeta(tool, resultPayload, hasResult) {
    if (!hasResult) return [metaChip("pending result")];
    if (resultPayload.blocked === "needs_approval") return [metaChip("approval needed", "danger")];
    if (resultPayload.denied === true) return [metaChip("denied", "danger")];
    if (resultPayload.error) return [metaChip("error", "danger")];
    const out = [];
    if (tool === "execute" && typeof resultPayload.code === "number") {
      out.push(metaChip("exit " + resultPayload.code, resultPayload.code === 0 ? "" : "danger"));
      if (resultPayload.timedOut) out.push(metaChip("timed out", "danger"));
    } else if (resultPayload.status) {
      const status =
        typeof resultPayload.status === "object" && resultPayload.status !== null
          ? resultPayload.status.state || resultPayload.status.status || stringify(resultPayload.status)
          : resultPayload.status;
      out.push(metaChip(titleCase(String(status)), status === "error" || status === "failed" ? "danger" : ""));
    } else if (typeof resultPayload.found === "boolean") {
      out.push(metaChip(resultPayload.found ? "found" : "missing", resultPayload.found ? "" : "danger"));
    }
    if (typeof resultPayload.bytes === "number") out.push(metaChip(fmtBytes(resultPayload.bytes)));
    if (typeof resultPayload.count === "number")
      out.push(metaChip(resultPayload.count + " result" + (resultPayload.count === 1 ? "" : "s")));
    return out;
  }
  function toolTextValue(v) {
    if (v == null) return "";
    if (Array.isArray(v)) return v.map(toolTextValue).filter(Boolean).join("\n");
    if (typeof v === "object") return stringify(v);
    return String(v);
  }
  function toolPrimaryText(callPayload, resultPayload, hasCall, hasResult) {
    if (hasCall) {
      for (const key of ["command", "path", "query", "url", "name", "id"]) {
        const text = toolTextValue(callPayload[key]);
        if (text) return text;
      }
    }
    if (hasResult) {
      for (const key of ["stdout", "stderr", "output", "chunks", "result", "error", "reason"]) {
        const text = toolTextValue(resultPayload[key]);
        if (text) return text;
      }
    }
    const fallback = hasResult ? resultPayload : callPayload;
    return toolTextValue(fallback);
  }
  function toolCopyText(callEntry, resultEntry) {
    const parts = [];
    if (callEntry)
      parts.push(`tool_call #${callEntry.seq} · ${fmtTime(callEntry.createdAt)}\n${payloadText(callEntry.payload)}`);
    if (resultEntry)
      parts.push(
        `tool_result #${resultEntry.seq} · ${fmtTime(resultEntry.createdAt)}\n${payloadText(resultEntry.payload)}`,
      );
    return parts.join("\n\n");
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      void 0;
    }
    const ta = document.body.appendChild(el("textarea", { value: text, style: "position: fixed; opacity: 0;" }));
    ta.select();
    let ok;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
  function copyButton(label, getText) {
    const btn = el("button.copy", { type: "button", textContent: label });
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await copyText(getText());
      btn.textContent = ok ? "Copied" : "Copy failed";
      if (ok) btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove("copied");
      }, 1200);
    };
    return btn;
  }
  function renderToolEntry(callEntry, resultEntry, contextBtn = null, timingEl = null, delivery = null) {
    const callPayload = callEntry?.payload ?? {};
    const resultPayload = resultEntry?.payload ?? {};
    const tool = toolName(callPayload, resultPayload);
    const block = el("div.entry tool-entry");
    const who = el("div.who");
    if (contextBtn) who.appendChild(contextBtn);
    who.append(el("span.tool-label", toolLabelText(tool, callPayload, resultPayload)));
    if (timingEl) who.appendChild(timingEl);
    who.append(
      el(
        "span.when",
        resultEntry
          ? `#${callEntry?.seq ?? "?"}→#${resultEntry.seq} · ${fmtTime(callEntry?.createdAt ?? resultEntry.createdAt)}`
          : `#${callEntry?.seq ?? resultEntry?.seq ?? "?"} · ${fmtTime(callEntry?.createdAt ?? resultEntry?.createdAt)}`,
      ),
      el("div.meta-row", {}, ...toolStatusMeta(tool, resultPayload, !!resultEntry)),
      copyButton("Copy", () => toolCopyText(callEntry, resultEntry)),
    );
    const body = el("div.tool-body");
    const primaryText = toolPrimaryText(callPayload, resultPayload, !!callEntry, !!resultEntry);
    if (primaryText) {
      const truncated = primaryText.length > 1800;
      const preview = truncated ? primaryText.slice(0, 1800) + "…" : primaryText;
      const card = el("pre.tool-command", { textContent: preview, tabIndex: 0, role: "button" });
      const syncExpanded = () => {
        const expanded = block.classList.contains("expanded");
        card.setAttribute("aria-expanded", String(expanded));
        card.title = expanded ? "Click to collapse tool text" : "Click to expand tool text";
        if (truncated) card.textContent = expanded ? primaryText : preview;
      };
      const toggle = () => {
        block.classList.toggle("expanded");
        syncExpanded();
      };
      card.onclick = toggle;
      card.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        toggle();
      };
      syncExpanded();
      body.appendChild(card);
    }
    if (delivery) {
      const drow = el("div.who", {}, el("span.entry-label important", deliveryLabel(delivery)));
      if (delivery.shadow) {
        const title = "Recorded for observability, never sent to the human (shadow-mode rollout)";
        drow.appendChild(el("span.entry-label", { title, textContent: "not sent" }));
      }
      drow.appendChild(badge(deliverySurfaceLabel(delivery), "info"));
      const mirror = slackMirrorRef(delivery);
      if (mirror) {
        const ml = navLink("View in Slack mirror ↗", { view: "slack", container: mirror.container, ts: mirror.ts });
        ml.title = "Jump to this message in the mirrored Slack channel " + mirror.container;
        drow.appendChild(ml);
      }
      drow.appendChild(el("span.when", `${delivery.shadow ? "shadow" : "delivered"} · ${fmtTime(delivery.createdAt)}`));
      const from = delivery.destination?.onBehalfOf ? `from ${delivery.destination.onBehalfOf}\n` : "";
      const to = delivery.destination?.target ? `to ${delivery.destination.target}\n` : "";
      const recipientLine = delivery.recipientThreadRef ? `recipient thread ${delivery.recipientThreadRef}\n` : "";
      const dv = el(
        "div.tool-delivery",
        {},
        drow,
        el("pre", `${from}${to}${recipientLine}${delivery.text || ""}`.trim()),
      );
      const files = deliveryFileBadges(delivery.attachments);
      if (files) dv.appendChild(files);
      body.appendChild(dv);
    }
    block.append(who, body);
    return { block, sync: () => {} };
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
  function slackUnescape(s) {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  function slackEntityNode(inner, mentions) {
    const u = slackUnescape(inner);
    const [id, label] = u.slice(1).split("|");
    if (u[0] === "@") return el("span.sm-mention", "@" + (label || (mentions && mentions[id]) || id));
    if (u[0] === "#") return el("span.sm-mention", "#" + (label || id));
    if (u[0] === "!") return el("span.sm-mention", "@" + (label || id.split("^")[0]));
    const bar = u.indexOf("|");
    const url = bar === -1 ? u : u.slice(0, bar);
    const text = bar === -1 ? url : u.slice(bar + 1);
    if (!/^(https?:|mailto:|tel:)/i.test(url)) return document.createTextNode(text);
    return el("a", { href: url, target: "_blank", rel: "noopener", textContent: text });
  }
  function slackAppendMrkdwn(raw, parent) {
    const text = slackUnescape(raw);
    const re = /\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|~([^~\n]+)~|(https?:\/\/[^\s<>]+)/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      const styled = [
        ["strong", m[1]],
        ["em", m[2]],
        ["s", m[3]],
      ].find(([, value]) => value != null);
      if (styled) parent.appendChild(el(...styled));
      else {
        let url = m[4].replace(/[.,;!?]+$/, "");
        while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)
          url = url.slice(0, -1);
        parent.append(slackEntityNode(url), m[4].slice(url.length));
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }
  function slackParseInline(text, parent, mentions) {
    const re = /`([^`\n]+)`|<([^>\n]+)>|:([a-z0-9_+'-]+):/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) slackAppendMrkdwn(text.slice(last, m.index), parent);
      const emoji = m[3] != null && governanceUI.charForName(m[3]);
      if (m[1] != null) parent.appendChild(el("code.sm-code", slackUnescape(m[1])));
      else if (m[2] != null) parent.appendChild(slackEntityNode(m[2], mentions));
      else if (emoji) parent.append(emoji);
      else slackAppendMrkdwn(m[0], parent);
      last = re.lastIndex;
    }
    if (last < text.length) slackAppendMrkdwn(text.slice(last), parent);
  }
  function slackParseText(raw, mentions) {
    const frag = document.createDocumentFragment();
    if (!raw) return frag;
    raw.split("```").forEach((part, i) => {
      if (i % 2 === 1)
        return frag.appendChild(el("pre", {}, el("code", slackUnescape(part.replace(/^\n/, "").replace(/\n$/, "")))));
      let quote = null;
      part.split("\n").forEach((line, lineIndex) => {
        if (/^(?:>|&gt;) ?/.test(line)) {
          if (quote) quote.append("\n");
          else quote = frag.appendChild(el("blockquote"));
          slackParseInline(line.replace(/^(?:>|&gt;) ?/, ""), quote, mentions);
        } else {
          if (lineIndex && !quote) frag.append("\n");
          quote = null;
          slackParseInline(line, frag, mentions);
        }
      });
    });
    return frag;
  }
  function deliverySurfaceLabel(event) {
    const type = event?.destination?.type;
    return pick({ principal: "Slack DM", slack: "Slack", web: "Web" }, type, type || "Unknown surface");
  }
  const deliveryLabel = (event) => (event.shadow ? "Shadow delivery" : `${deliverySurfaceLabel(event)} delivery`);
  function slackMirrorRef(event) {
    const d = event?.destination || {};
    if (d.type !== "slack" || !d.editRef || typeof d.target !== "string" || !d.target) return null;
    return { container: d.target.split(":")[0], ts: d.editRef };
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
  const estimateTokens = (text) => ((text || "").length ? Math.max(1, Math.round(text.length / 4)) : 0);
  function fmtTokens(n) {
    if (!n) return "0 tokens";
    if (n < 20) return "< 20 tokens";
    if (n < 1000) return n.toLocaleString() + " tokens";
    if (n < 1000000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k tokens";
    return (n / 1000000).toFixed(1) + "m tokens";
  }
  function blockText(o) {
    if (o == null) return "";
    if (typeof o === "string") return o;
    if (typeof o !== "object") return String(o);
    if (Array.isArray(o)) return o.map(blockText).join("\n");
    if (typeof o.text === "string" && (o.type === "text" || o.type == null)) return o.text;
    if (o.type === "image") {
      const data = typeof o.source?.data === "string" && o.source.data ? " · " + o.source.data : "";
      return "[image " + (o.source?.media_type || "image") + data + "]";
    }
    if (o.type === "tool_use")
      return "[tool_use " + (o.name || "tool") + (o.id ? " · " + o.id : "") + "]\n" + stringify(o.input ?? {});
    if (o.type === "tool_result")
      return `[tool_result${o.tool_use_id ? " " + o.tool_use_id : ""}${o.is_error ? " · error" : ""}]\n${blockText(o.content)}`;
    if (o.type === "thinking") {
      const signature = typeof o.signature === "string" ? "\n[signature " + o.signature + "]" : "";
      return "[thinking]\n" + (typeof o.thinking === "string" ? o.thinking : "") + signature;
    }
    if (o.type === "redacted_thinking")
      return "[redacted_thinking" + (typeof o.data === "string" ? " " + o.data : "") + "]";
    if (o.type === "document") return "[document " + (o.title || o.name || "attachment") + "]";
    return stringify(o);
  }
  function messageEntryText(m) {
    const obj = m && typeof m === "object";
    const content = blockText(obj ? m.content : m);
    const name = obj && m.name ? " (" + m.name + ")" : "";
    return (
      "[" + String(obj ? m.role || "message" : "message") + name + "]\n" + (content.length ? content : "(no content)")
    );
  }
  function systemToText(system) {
    if (system == null) return { text: "", cacheSplit: false };
    if (typeof system === "string") return { text: system, cacheSplit: false };
    if (!Array.isArray(system)) return { text: stringify(system), cacheSplit: false };
    let out = "",
      cacheSplit = false;
    system.forEach((b, i) => {
      const t = b && typeof b === "object" && typeof b.text === "string" ? b.text : blockText(b);
      out += (i ? "\n" : "") + t;
      const cc = b && typeof b === "object" ? b.cache_control : null;
      if (!cc) return;
      const ttl = typeof cc === "object" && cc.ttl ? " " + cc.ttl : "";
      out += "\n\n────── cache breakpoint (" + (cc.type || "ephemeral") + ttl + ") ──────\n";
      cacheSplit = true;
    });
    return { text: out, cacheSplit };
  }
  function transportText(transport) {
    if (!transport || typeof transport !== "object") return "";
    const lines = [];
    if (transport.modelId) lines.push("model: " + transport.modelId);
    const h = transport.headers;
    if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) lines.push(k + ": " + v);
    if (!lines.length) return "";
    return (
      lines.join("\n") +
      "\n\n(auth + anthropic-version headers are added by the provider SDK below the capture point, so they aren't shown)"
    );
  }
  const requestBody = (q) => (q && q.promptEnvelope != null ? q.promptEnvelope : null);
  function contextSections(request, transport) {
    const req = request && typeof request === "object" ? request : {};
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const params = Object.fromEntries(
      Object.entries(req).filter(([k]) => !["system", "messages", "tools"].includes(k)),
    );
    const paramCount = Object.keys(params).length;
    const count = (n, word) => n + " " + word + (n === 1 ? "" : "s");
    const sys = systemToText(req.system);
    const messageNote = messages.length
      ? count(messages.length, "message")
      : "not re-captured per step; the transcript is the record";
    return [
      ["transport", "Transport", "model + headers", transportText(transport)],
      ["system", "System prompt", sys.cacheSplit ? "verbatim · cache split shown" : "verbatim", sys.text],
      ["messages", "Messages", messageNote, messages.map(messageEntryText).join("\n\n")],
      [
        "tools",
        "Tool schemas",
        Array.isArray(req.tools) ? count(req.tools.length, "tool") : "tools",
        req.tools == null ? "" : stringify(req.tools),
      ],
      ["params", "Request params", count(paramCount, "field"), paramCount ? stringify(params) : ""],
    ]
      .filter(([, , , text]) => text)
      .map(([key, label, note, text]) => ({
        key,
        label,
        note,
        text,
        tokens: estimateTokens(text),
        chars: text.length,
      }));
  }
  function callCacheUsage(q) {
    const u = q && q.usage;
    if (!u || typeof u !== "object") return null;
    return {
      cacheRead: Number(u.cacheRead) || 0,
      cacheWrite: Number(u.cacheWrite) || 0,
      uncachedInput: Number(u.input) || 0,
    };
  }
  function sumCacheUsage(requests) {
    const usages = (requests || []).map(callCacheUsage).filter(Boolean);
    const sum = (key) => usages.reduce((n, u) => n + u[key], 0);
    return usages.length
      ? { cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), uncachedInput: sum("uncachedInput") }
      : null;
  }
  const usageTotal = (u) => u.cacheRead + u.cacheWrite + u.uncachedInput;
  function fmtContextSize(q, sections) {
    const u = callCacheUsage(q);
    return u && usageTotal(u) > 0
      ? fmtTokens(usageTotal(u))
      : "~" + fmtTokens(sections.reduce((n, s) => n + s.tokens, 0));
  }
  const cacheHitRatio = (u) => (u && usageTotal(u) > 0 ? u.cacheRead / usageTotal(u) : null);
  function isStablePrefixMiss(u) {
    const ratio = cacheHitRatio(u);
    return ratio !== null && u.cacheWrite >= 1024 && ratio < 0.1;
  }
  const metaChip = (text, kind = "") =>
    el("span", { className: "meta-chip" + (kind ? " " + kind : ""), textContent: text });
  function cacheMetaItems(u) {
    if (!u) return [];
    const ratio = cacheHitRatio(u);
    const miss = isStablePrefixMiss(u);
    const out = [metaChip("cache " + (ratio === null ? "n/a" : fmtPct(ratio)), miss ? "danger" : "")];
    if (miss) out.push(metaChip("stable-prefix miss", "danger"));
    return out;
  }
  function durSeg(ms, label) {
    let cls = "";
    if (ms >= 30000) cls = "dur-hot";
    else if (ms >= 5000) cls = "dur-warm";
    const span = el("span." + cls, fmtMs(ms));
    if (!label) return span;
    const wrap = document.createDocumentFragment();
    wrap.append(el("span.seg-label", label + " "), span);
    return wrap;
  }
  function stepDurEl(segs) {
    const parts = (segs || []).filter(([ms]) => ms != null && ms >= 0);
    if (!parts.length) return null;
    const node = el("span.step-dur");
    parts.forEach(([ms, label], i) => node.append(...(i ? [" · "] : []), durSeg(ms, label)));
    return node;
  }
  function rawJsonLink(requests, label = "Raw JSON") {
    let payload = requests.map((q) => ({
      step: q.step,
      model: q.model,
      createdAt: q.createdAt,
      truncated: !!q.truncated,
      ...(q.transport ? { transport: q.transport } : {}),
      request: requestBody(q),
    }));
    if (requests.length === 1)
      payload = requests[0]?.transport
        ? { request: requestBody(requests[0]), transport: requests[0].transport }
        : requestBody(requests[0]);
    const a = el("a.context-raw", { href: "#", target: "_blank", rel: "noopener", textContent: label });
    let url = null;
    a.addEventListener("click", () => {
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      a.href = url;
    });
    return a;
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
      go,
      stateToUrl,
      openScopeRow,
      scopeKind,
      shortName,
      dirLabel,
      plural,
      relTime,
      fmtTime,
      fmtBytes,
      shortId,
      titleCase,
      firstLine,
      fileName,
      fileKind,
      fileSha256,
      uploadErrorMessage,
      downloadFile,
      cronName,
      shortSchedule,
      fmtSchedule,
      destinationSummary,
      destinationDetails,
      createdByCell,
      packRepoLabel,
      scopeCell,
      statusBadge,
      scopeRows,
      buildScopeMultiSelect,
      webUiAsButton,
      adminErrors,
      errorStripBox,
      renderToolEntry,
      stepDurEl,
      toolName,
      toolLabelText,
      toolPrimaryText,
      toolStatusMeta,
      toolCopyText,
      copyButton,
      payloadText,
      payloadName,
      isXmlishText,
      renderXmlish,
      renderMarkdown,
      entryIsNoise,
      brandSelfLabel,
      wakeOriginLabel,
      deliveryLabel,
      deliverySurfaceLabel,
      slackMirrorRef,
      metaChip,
      deliveryFileBadges,
      contextSections,
      requestBody,
      sumCacheUsage,
      cacheMetaItems,
      rawJsonLink,
      fmtContextSize,
      fmtTokens,
      isStablePrefixMiss,
      defaultShell,
      navLink,
      egressDetail,
      historyKindMatches,
      historyModeLabel,
      selectScope,
      adminErrorCount,
      urlToState,
      slackParseText,
      slackContainerLabel,
      slackContainerScope,
      loadSlackContainers,
      labelRole,
      copyText,
      openWebUiAs,
      openUser,
      fmtPct,
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
