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

  async function openWebUiAs(target) {
    if (!target) return;
    try {
      const res = await fetch("/auth/impersonate?target=" + encodeURIComponent(target), {
        method: "POST",
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        let msg = "Failed (" + res.status + ")";
        const j = await res.json().catch(() => null);
        if (j && j.message) msg = j.message;
        alert("Couldn't start impersonation: " + msg);
        return;
      }
    } catch (e) {
      alert("Couldn't start impersonation: " + (e && e.message ? e.message : e));
      return;
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
      governanceUI.settings.credentialStatus(msg, kind || "");
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
  function labelRole(role) {
    return role === "org_admin" ? "admin" : String(role || "").replace(/_/g, " ");
  }
  function scopeKind(scopeId) {
    return String(scopeId || "").split(":")[0] || "scope";
  }
  const STATUS_KIND = { done: "ok", failed: "err", running: "info", pending: "warn" };
  const statusBadge = (status) => badge(titleCase(status || "unknown"), STATUS_KIND[status] || "muted");
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
    if (transcriptObserver) {
      transcriptObserver.disconnect();
      transcriptObserver = null;
    }
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
      view === "general" || view === "onboarding" || isGovLike(view) || view === "connectors",
    );
    if (view === "general") return;
    if (view === "onboarding") return void governanceUI.onboarding.load();
    if (isGovLike(view)) {
      if (view === "slack-settings") void governanceUI.integrations.loadSlackInstallation();
      return void loadScope();
    }
    if (view === "connectors") return void governanceUI.integrations.loadConnectors();
    if (view === "user") return void showUserDetail(st.principal);
    if (view === "slack") return void renderSlackMirror(st);
    if (view === "judgments") return void governanceUI.slackActivity.renderAmbientJudgments(st);
    if (view === "ackemoji") return void governanceUI.slackActivity.renderAckEmojiPicks(st);
    if (view === "history" && st.session && st.turn != null) return void showContextPage(st.session, st.turn);
    if (view === "history" && st.session) return void showTranscript(st.session);
    renderData();
  }

  const GOV_LIKE = new Set(["governance", "models", "credentials", "customize", "slack-settings"]);
  function isGovLike(v) {
    return GOV_LIKE.has(v);
  }
  function hasGovernanceDraft() {
    return isGovLike(view) && !!$("view-governance").querySelector(".card.dirty");
  }
  function governanceSaveInFlight() {
    return isGovLike(view) && !!$("view-governance").querySelector(".status.saving");
  }
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
    if (governanceSaveInFlight()) {
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
    const leavingDraft = hasGovernanceDraft() && (st.view !== view || st.scope !== scope);
    if (!leavingDraft) return commitGo(st);
    void reviewLeave(st.view).then((confirmed) => {
      if (confirmed) {
        if (view === "governance") governanceReadyScope = null;
        commitGo(st);
      }
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
  $("add-custom-provider").onclick = () => governanceUI.settings.openProvider(null);
  $("onboarding-add-custom-provider").onclick = () => governanceUI.settings.openProvider(null);
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
  function dirLabel(id) {
    const s = (scopeDir || []).find((x) => x.scopeId === id);
    return (s && s.label) || "";
  }

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

  function navLink(label, target) {
    const a = document.createElement("a");
    a.className = "link";
    a.textContent = label;
    a.href = stateToUrl(target);
    a.onclick = (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go(target);
    };
    return a;
  }

  function defaultShell(extras = {}) {
    extras = { actions: view === "credentials" ? [scAddButton] : [], ...extras };
    const title = VIEW_TITLE[view] || titleCase(view);
    if (SCOPED.has(view) && !orgWideView()) {
      pageShell({
        back: {
          label: "← " + title,
          onClick: () =>
            go({
              view,
              scope: "org:" + orgId,
              session: null,
              page: 1,
              ...(view === "history" ? { historyKind } : {}),
            }),
        },
        title: shortName(scope),
        ...extras,
      });
    } else {
      pageShell({ title, ...extras });
    }
  }

  const orgOwnView = () => orgWideView() && urlToState().own === "1";
  function openScopeRow(scopeId, extra = {}) {
    if (scopeKind(scopeId) === "org") return go({ view, scope: scopeId, own: "1", session: null, page: 1, ...extra });
    selectScope(scopeId);
  }

  const FOCUS_REFRESH_EXEMPT = new Set(["governance", "connectors", "slack-settings", "user"]);
  window.addEventListener("focus", () => {
    if (!root.isConnected) return;
    if (view === "slack-settings") {
      void governanceUI.integrations.loadSlackInstallation();
      return;
    }
    if (isGovLike(view) || FOCUS_REFRESH_EXEMPT.has(view)) return;
    if (Date.now() - (viewLoadedAt[view] || 0) < 60000) return;
    if (view === "memory" && !(orgWideView() && urlToState().mem !== "edit")) return;
    if (view === "history" && urlToState().session) return;
    if (view === "onboarding") {
      governanceUI.onboarding.load();
      return;
    }
    if (view === "slack") {
      if (!urlToState().container) renderSlackMirror(urlToState());
      return;
    }
    if (view === "crons" && cronDestinationEditId) return;
    renderData();
  });

  let loadedGovernanceScope = null;
  let governanceReadyScope = null;
  let loadedCommandPolicyPresent = false;
  let serviceCredDirectory = [];
  let serviceCredChannels = [];
  governanceUI.settings.configureSoul({
    formatTime: fmtTime,
    restore: async (revision) => {
      const immutable = { ...revision };
      const targetScope = scope;
      const targetGeneration = governanceReq;
      const draftBefore = JSON.stringify(governanceUI.settings.collect("soul"));
      const expectedVersion = governanceUI.settings.collect("soul").expectedVersion;
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
      const r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/soul", {
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
      const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(targetScope) + "?view=customize");
      if (scope !== targetScope || governanceReq !== targetGeneration) return;
      if (!fresh.ok)
        return setStatus("st-soul", "Restored, but the latest version could not be refreshed.", "warn", true);
      if (JSON.stringify(governanceUI.settings.collect("soul")) === draftBefore)
        governanceUI.settings.load(fresh.data, targetScope, "soul");
      else governanceUI.settings.refreshSoul(fresh.data);
      sectionSnapshots.set("soul", governanceUI.settings.states.get("soul").baseline);
      if (!governanceUI.settings.states.get("soul").dirty)
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
      governanceUI.settings.credentialLoading();
      void loadPersonalKeychainSummary(requestId, requestedScope);
    }
    const r = await api(
      "GET",
      "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(requestedView),
    );
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
    if (!r.ok) {
      if (requestedView === "credentials") {
        governanceUI.settings.credentialLoading(
          r.status === 403 ? "You don't administer this scope." : "Could not load credentials.",
          true,
        );
      }
      if (requestedView === "governance" && governanceReadyScope !== requestedScope) {
        $("governance-loading").textContent =
          r.status === 403
            ? "You don't administer this scope."
            : "Could not load settings. Select Governance to retry.";
      }
      setStatus(
        "st-policy",
        r.status === 403 ? "You don't administer this scope." : r.data?.message || "Failed to load.",
        "err",
      );
      return;
    }
    if (requestedView === "governance") {
      renderEnvironmentNotice(r.data);
      loadedCommandPolicyPresent = r.data.commandPolicy != null;
      governanceUI.load(r.data, scope);
      if (scopeChanged) $("auto-flagger-test-result").hidden = true;
    }
    if (requestedView === "customize") {
      savedBranding = r.data.branding || {};
      governanceUI.settings.load(r.data, scope, "soul");
      governanceUI.settings.load(r.data, scope, "branding");
      void governanceUI.settings.loadFlags(r.data, scope);
      governanceUI.settings.loadDecisions(r.data, scope);
    }
    if (requestedView === "slack-settings") governanceUI.integrations.loadScope(r.data, scope);
    const opts = r.data.baseModelOptions || [];
    if (requestedView === "models") {
      for (const key of [
        "runtime",
        "cron-runtime",
        "subagent-runtime",
        "fallback-runtime",
        "webui-models",
        "memory-embedding-model",
      ])
        governanceUI.settings.load(r.data, scope, key);
      void governanceUI.settings.loadProviders();
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
      void api(
        "GET",
        "/api/scopes/" +
          encodeURIComponent(requestedScope) +
          "?view=" +
          encodeURIComponent(requestedView) +
          "&catalog=refresh",
      )
        .then((fresh) => {
          if (!fresh.ok || requestId !== governanceReq || requestedScope !== scope || requestedView !== view) return;
          const append = (target, incoming) => {
            for (const model of incoming || []) {
              const existing = target.findIndex((candidate) => candidate.id === model.id);
              if (existing < 0) target.push(model);
              else target[existing] = model;
            }
          };
          append(opts, fresh.data.baseModelOptions);
          if (requestedView === "governance") governanceUI.updateCatalog(fresh.data);
          governanceUI.settings.updateCatalog(r.data);
          initCustomDropdowns($("view-governance"));
        })
        .catch((error) => console.warn("[swallowed] admin: model catalog refresh", error));
    }
  }
  async function refreshSoulConflict() {
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(view));
    if (!fresh.ok) return false;
    governanceUI.settings.refreshSoul(fresh.data);
    sectionSnapshots.set("soul", governanceUI.settings.states.get("soul").baseline);
    return true;
  }
  async function refreshServiceCredentialConflict() {
    const requestedScope = scope;
    const requestedView = view;
    const requestId = ++governanceReq;
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(scope) + "?view=" + encodeURIComponent(view));
    if (requestId !== governanceReq || requestedScope !== scope || requestedView !== view || !fresh.ok) return false;
    loadServiceCredDirectory(fresh.data);
    const credentials = fresh.data.serviceCredentials || [];
    const refreshedEditing = credentials.find((credential) => credential.slug === scEditing);
    if (refreshedEditing) {
      scEditVersion = refreshedEditing.updatedAt;
      governanceUI.settings.credentialState.version = scEditVersion;
    }
    renderServiceCreds(credentials);
    void loadServiceCredentialUsage(requestedScope, requestId);
    governanceUI.settings.credentialState.render();
    governanceUI.settings.credentialState.changed();
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
  governanceUI.settings.configureDecisions({
    save: (targetScope, body) => api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/decisions", body),
  });
  governanceUI.settings.configureFlags({
    buildSelector: buildScopeMultiSelect,
    loadChoices: async () => {
      if (!scopeDir) await loadScopeDirectory();
      return (scopeDir || []).map((row) => ({ scopeId: row.scopeId, label: row.label || row.scopeId }));
    },
    save: (targetScope, body) => api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/feature-flags", body),
  });

  let scEditing = null;
  let scEditVersion = null;
  let serviceCredList = [];
  async function loadServiceCredentialUsage(requestedScope, requestId) {
    if (!serviceCredList.length) return;
    const result = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "/credential-usage");
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
  governanceUI.settings.configureCredentials({
    label: serviceCredentialPrincipalLabel,
    formatTime: fmtTime,
    edit: loadScForm,
    remove: deleteSc,
    reload: loadScope,
  });
  function renderServiceCreds(list) {
    serviceCredList = list;
    governanceUI.settings.loadCredentials(list, serviceCredDirectory, serviceCredChannels, scopeDir || [], scope);
  }
  function loadScForm(c) {
    scEditing = c.slug;
    scEditVersion = c.updatedAt;
    governanceUI.settings.credentialState.begin(c);
    openScDialog();
    $("sc-name").focus();
  }
  function resetScForm() {
    const dialog = $("sc-dialog");
    const wasOpen = dialog.open;
    if (wasOpen) dialog.close();
    scStatusHome.appendChild($("st-service-credentials"));
    scEditing = null;
    scEditVersion = null;
    governanceUI.settings.credentialState.reset();
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
    const r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/service-credentials", {
      slug: c.slug,
      delete: true,
      expectedUpdatedAt: c.updatedAt,
    });
    if (targetScope !== scope) return;
    if (r.ok) {
      resetScForm();
      await loadScope();
      setStatus("st-service-credentials", "Deleted", "ok");
    } else {
      const conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
      let message = r.data?.message || "Delete failed.";
      if (r.status === 409) {
        message = conflictState
          ? "Credential changed; the latest state is shown. Review it before deleting."
          : "Credential changed, but the latest state could not be loaded. Refresh the page before deleting.";
      }
      setStatus("st-service-credentials", message, "err");
    }
  }
  scAddButton.onclick = () => {
    resetScForm();
    governanceUI.settings.credentialState.begin(null);
    openScDialog();
    $("sc-name").focus();
  };
  $("sc-reset").onclick = () => {
    if (!$("st-service-credentials").classList.contains("saving")) resetScForm();
  };
  $("sc-save").onclick = async () => {
    const body = governanceUI.settings.credentialState.collect();
    const targetScope = scope;
    const invalid = governanceUI.settings.credentialState.validate(body);
    if (invalid) {
      setStatus("st-service-credentials", invalid, "err");
      return;
    }
    $("sc-save").disabled = true;
    setStatus("st-service-credentials", "Saving...", "saving", true);
    let r;
    try {
      r = await api("PUT", "/api/scopes/" + encodeURIComponent(targetScope) + "/service-credentials", body);
    } catch {
      if (targetScope !== scope) return;
      governanceUI.settings.credentialState.changed();
      setStatus(
        "st-service-credentials",
        "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
        "err",
        true,
      );
      return;
    }
    if (scope !== targetScope) return;
    if (r.ok) {
      await loadScope();
      if (scope !== targetScope) return;
      governanceUI.settings.credentialState.commit(body);
      if (!governanceUI.settings.credentialState.dirty) resetScForm();
      setStatus("st-service-credentials", "Saved", "ok");
    } else {
      let conflictState;
      try {
        conflictState = r.status === 409 ? await refreshServiceCredentialConflict() : false;
      } catch {
        governanceUI.settings.credentialState.changed();
        setStatus(
          "st-service-credentials",
          "Save failed because the admin service could not be reached. Your draft is preserved; try again.",
          "err",
          true,
        );
        return;
      }
      governanceUI.settings.credentialState.changed();
      let message = r.data?.message || "Save failed.";
      if (r.status === 403) {
        message = "Not authorized for this scope.";
      } else if (r.status === 409) {
        if (conflictState === "missing") {
          message =
            "This credential was deleted elsewhere. Your draft is preserved, but it remains an edit and cannot recreate the credential. Cancel the edit before creating a new credential.";
        } else if (conflictState === "present") {
          message = "Credential changed; latest revision loaded and your draft was preserved.";
        } else {
          message =
            "Credential changed, but the latest revision could not be loaded. Your draft is preserved; refresh the page before retrying.";
        }
      }
      setStatus("st-service-credentials", message, "err");
    }
  };

  governanceUI.onboarding.configure({
    api,
    orgScope: () => orgScope(),
    connectorName: (id) => connectorName(id),
    view: () => view,
    loadCustomProviders: () => governanceUI.settings.loadProviders(),
    loaded: () => {
      viewLoadedAt.onboarding = Date.now();
    },
    navigate: (target) => openOnboardingTarget(target),
  });

  governanceUI.settings.configureProviders({
    api,
    refresh: async () => {
      await governanceUI.settings.loadProviders();
      if (view !== "models") return;
      const requestedScope = scope;
      const requestedGeneration = governanceReq;
      const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=models");
      if (fresh.ok && scope === requestedScope && view === "models" && governanceReq === requestedGeneration)
        governanceUI.settings.updateCatalog(fresh.data);
    },
  });
  async function loadPersonalKeychainSummary(requestId, requestedScope) {
    governanceUI.settings.keychainSummary(null);
    const res = await api("GET", "/api/keychain?summary=1");
    if (requestId !== governanceReq || requestedScope !== scope || view !== "credentials") return;
    governanceUI.settings.keychainSummary(res.ok ? res.data : null);
  }
  function openOnboardingTarget(target) {
    setView(target === "slack" ? "slack-settings" : "connectors");
    setTimeout(
      () =>
        $(target === "slack" ? "card-slack-installation" : "card-connectors")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        }),
      100,
    );
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
    if (!command.trim()) {
      result.dataset.tone = "";
      result.textContent = "Enter a sample command first.";
      return;
    }
    let policy;
    try {
      policy = governanceUI.collect("command-policy");
    } catch (err) {
      result.dataset.tone = "danger";
      result.textContent = err instanceof Error ? err.message : "Policy is invalid.";
      return;
    }
    $("policy-simulate").disabled = true;
    result.dataset.tone = "";
    result.textContent = "Evaluating with the server’s command scanner…";
    const simulateBody = { command };
    if (loadedCommandPolicyPresent || $("card-command-policy").classList.contains("dirty"))
      simulateBody.policy = policy;
    const response = await api(
      "PUT",
      "/api/scopes/" + encodeURIComponent(scope) + "/command-policy-simulate",
      simulateBody,
    );
    $("policy-simulate").disabled = false;
    if (!response.ok) {
      result.dataset.tone = "danger";
      result.textContent = response.data?.message || "Simulation failed.";
      return;
    }
    const decision = response.data.decision;
    let tone = "warn";
    if (decision === "allow") tone = "ok";
    else if (decision === "deny") tone = "danger";
    result.dataset.tone = tone;
    let ruleLabel = null;
    if (response.data.ruleSource === "organization") {
      ruleLabel = "Organization rule " + (response.data.ruleIndex + 1);
    } else if (response.data.ruleSource === "scope") {
      ruleLabel = "This scope’s rule " + (response.data.ruleIndex + 1);
    }
    result.textContent = ruleLabel
      ? ruleLabel +
        " matches" +
        (response.data.matched ? " “" + response.data.matched + "”" : "") +
        " → " +
        (EFFECT_LABELS[decision] || decision) +
        (response.data.reason ? " · " + response.data.reason : "")
      : "No scope-policy rule matches → " +
        (EFFECT_LABELS[decision] || decision) +
        (response.data.reason ? " · " + response.data.reason : "");
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
    if (key === "security-posture") {
      const before = JSON.parse(sectionSnapshots.get(key) || "{}").posture || "auto";
      const dangerous = body.posture === "dangerous";
      return reviewGovernanceChange({
        title: dangerous ? "Enable Dangerous autonomy?" : "Change security posture?",
        subtitle: "Review the immutable change below before it is applied.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", titleCase(before)],
          ["Proposed", titleCase(body.posture)],
        ],
        warning: dangerous
          ? "Dangerous disables posture-based content screening and tool approval gates. Deployment-required screening still applies. Predeclared command approvals, hard denials, identity, authorization, credential scope, revocation, and audit remain enforced."
          : "This changes the effective tools and approval behavior for future turns in this scope.",
        confirmLabel: dangerous ? "Enable Dangerous" : "Apply posture",
        danger: dangerous,
      });
    }
    if (key === "sharing-posture") {
      const before = JSON.parse(sectionSnapshots.get(key) || "{}").posture || "isolated";
      const open = body.posture === "open";
      return reviewGovernanceChange({
        title: open ? "Enable Open sharing?" : "Return to Isolated sharing?",
        subtitle: "This applies to future live human turns in the selected scope.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", titleCase(before)],
          ["Proposed", titleCase(body.posture)],
        ],
        warning: open
          ? "Open can reveal a speaker's private information in shared replies. It does not carry credentials, history, writes, automation, or another person's resources. Organization, personal, and room policy must all allow it."
          : "Cross-context resources will again require explicit shares or grants.",
        confirmLabel: open ? "Enable Open" : "Use Isolated",
        danger: open,
      });
    }
    if (key === "external-slack-participants") {
      const before = !!JSON.parse(sectionSnapshots.get(key) || "{}").on;
      return reviewGovernanceChange({
        title: body.on ? "Allow external Slack audiences?" : "Return Slack to internal-only?",
        subtitle: "This organization-wide audience boundary applies to future Slack turns.",
        facts: [
          ["Scope", governanceScopeName()],
          ["Current", before ? "External audiences enabled" : "Internal only"],
          ["Proposed", body.on ? "External audiences enabled" : "Internal only"],
        ],
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
    const draftBefore = JSON.stringify(governanceUI.collect("sharing-posture"));
    if (
      !(await reviewGovernanceChange({
        title: "Follow organization sharing?",
        subtitle: "Remove this scope's sharing override.",
        facts: [["Scope", governanceScopeName()]],
        warning:
          "The organization's sharing setting will apply. A personal or room Isolated override still takes precedence.",
        confirmLabel: "Follow organization",
      })) ||
      requestedScope !== scope ||
      requestedGeneration !== governanceReq
    )
      return;
    const result = await api("PUT", "/api/scopes/" + encodeURIComponent(requestedScope) + "/sharing-posture", {
      inherit: true,
    });
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (result.ok)
      await refreshPolicySetting("sharing-posture", requestedScope, requestedGeneration, draftBefore, "Saved");
    else setStatus("st-sharing-posture", "Could not reset sharing.", "err");
  };
  async function refreshPolicySetting(key, requestedScope, requestedGeneration, draftBefore, message) {
    const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=governance");
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
    const windowField = $("auto-flagger-window");
    const requested = Number(windowField.value);
    if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
      return setStatus("st-auto-flagger-test", "Window must be a whole number between 1 and 500.", "err", true);
    }
    setStatus("st-auto-flagger-test", "Replaying the last " + requested + " screenings through this rubric…", "", true);
    button.disabled = true;
    try {
      const r = await api("POST", "/api/scopes/" + encodeURIComponent(requestedScope) + "/auto-flagger/test", {
        window: requested,
        compare: $("auto-flagger-compare").checked,
        modelId: $("auto-flagger-model").value,
        rubric: $("auto-flagger-rubric").value,
      });
      if (requestedScope !== scope) return;
      if (!r.ok) {
        return setStatus("st-auto-flagger-test", r.data?.message || "Test run failed.", "err", true);
      }
      setStatus("st-auto-flagger-test", autoFlaggerTestSummary(r.data), r.data.errors ? "warn" : "ok", true);
    } finally {
      button.disabled = false;
    }
  };
  $("auto-flagger-reset").onclick = async () => {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    const draftBefore = JSON.stringify(governanceUI.collect("auto-flagger"));
    const r = await api("PUT", "/api/scopes/" + encodeURIComponent(requestedScope) + "/auto-flagger", {
      reset: true,
    });
    if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
    if (!r.ok) return setStatus("st-auto-flagger", r.data?.message || "Reset failed.", "err");
    await refreshPolicySetting("auto-flagger", requestedScope, requestedGeneration, draftBefore, "Default restored");
  };

  async function saveSetting(key, btn) {
    const requestedScope = scope;
    const requestedGeneration = governanceReq;
    let body;
    try {
      body = governanceUI.collect(key);
    } catch (err) {
      setStatus(statusIdOf(key), err instanceof Error ? err.message : "Could not save.", "err");
      return;
    }
    if (!(await governanceSaveReview(key, body)) || requestedScope !== scope || requestedGeneration !== governanceReq)
      return;
    const saveRequest = String(++governanceSaveSeq);
    if (btn) {
      btn.dataset.saveRequest = saveRequest;
      btn.disabled = true;
    }
    setStatus(statusIdOf(key), "Saving...", "saving", true);
    const isBranding = key === "branding";
    const brandingBody = isBranding ? { ...savedBranding, ...body } : body;
    const r = await api(
      "PUT",
      "/api/scopes/" + encodeURIComponent(requestedScope) + "/" + (isBranding ? "branding" : key),
      brandingBody,
    );
    if (requestedGeneration !== governanceReq) return;
    if (requestedScope !== scope) {
      if (!btn || btn.dataset.saveRequest === saveRequest) {
        if (btn) {
          delete btn.dataset.saveRequest;
          btn.disabled = !btn.classList.contains("dirty");
        }
        setStatus(statusIdOf(key), "", "");
      }
      return;
    }
    if (btn?.dataset.saveRequest === saveRequest) delete btn.dataset.saveRequest;
    if (r.ok) {
      governanceUI.commit(key, body);
      sectionSnapshots.set(key, JSON.stringify(body));
      if (isBranding) {
        savedBranding = brandingBody;
        if (!hasGovernanceDraft()) location.reload();
        return;
      }
      if (key === "soul") {
        const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=customize");
        if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
        if (fresh.ok) {
          governanceUI.settings.refreshSoul(fresh.data);
          sectionSnapshots.set(key, governanceUI.states.get(key).baseline);
          if (!governanceUI.states.get(key).dirty) governanceUI.status(key, "Saved", "ok");
        } else governanceUI.status(key, "Saved, but the latest version could not be refreshed.", "warn");
        return;
      }
      if (key === "command-policy") loadedCommandPolicyPresent = true;
      if (["security-posture", "sharing-posture", "ambient-policy", "auto-flagger"].includes(key)) {
        const fresh = await api("GET", "/api/scopes/" + encodeURIComponent(requestedScope) + "?view=governance");
        if (requestedScope !== scope || requestedGeneration !== governanceReq) return;
        if (fresh.ok && !governanceUI.states.get(key).dirty) {
          governanceUI.load(fresh.data, requestedScope, key);
          sectionSnapshots.set(key, JSON.stringify(governanceUI.collect(key)));
          governanceUI.status(key, "Saved", "ok");
        }
      }
    } else {
      if (key === "soul" && r.status === 409) await refreshSoulConflict();
      let message = r.data?.message || "Save failed.";
      if (key === "soul" && r.status === 409) {
        message = "SOUL changed; latest revision loaded and your draft was preserved.";
      } else if (r.status === 403) {
        message = "Not authorized for this scope.";
      }
      setStatus(statusIdOf(key), message, "err");
    }
  }
  document.querySelectorAll("[data-save]").forEach((btn) => {
    btn.onclick = () => saveSetting(btn.dataset.save, btn);
  });
  governanceUI.settings.configureRuntimes({ save: (key) => saveSetting(key) });
  const credentialEdited = (e) => {
    if (e.target.matches("input, textarea, select") && e.target.closest("#card-service-credentials"))
      governanceUI.settings.credentialState.changed();
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
    root.querySelectorAll("select").forEach((sel) => upgradeCustomDropdown(sel));
  }
  initCustomDropdowns($("app-view"));
  new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n instanceof HTMLSelectElement) upgradeCustomDropdown(n);
        else initCustomDropdowns(n);
      });
    });
  }).observe($("app-view"), { childList: true, subtree: true });

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
    if (["errors", "audit", "egress"].includes(view)) return governanceUI.activity[view](root, data, activityContext());
    ({ spend: renderSpend, history: renderHistory, users: renderUsers, keychain: renderKeychain })[view](root, data);
  }
  async function renderData() {
    const root = $("view-data");
    const reqId = ++dataReq;
    const q = "scope=" + encodeURIComponent(scope);
    const ep = view === "history" ? "sessions" : view;
    let path = ORG_WIDE.has(view) ? `/api/${ep}` : `/api/${ep}?${q}`;

    if (view === "memory" && orgWideView() && urlToState().mem !== "edit") path = "/api/memory/scopes";
    if (view === "history") {
      path += `&limit=50&category=${encodeURIComponent(historyCategory(historyKind))}`;
      if (historyCursor) path += `&cursor=${encodeURIComponent(historyCursor)}`;
      if (historyKind === "cron") {
        path += `&origin=${encodeURIComponent(historyKind)}`;
        const cronSel = urlToState().cron;
        if (cronSel) path += `&cron=${encodeURIComponent(cronSel)}`;
      }
      if (historyKind === "background") path += "&origin=other_background";
    }
    if (view === "errors") path += `&limit=${ERRORS_PAGE_SIZE}&offset=${(page - 1) * ERRORS_PAGE_SIZE}`;
    if (view === "spend") path += `?${spendQuery(urlToState())}`;
    const cacheable = view !== "memory";
    const cached = cacheable ? dataCache.get(path) : undefined;
    if (cached !== undefined) {
      paintData(root, cached);
    } else {
      root.textContent = "";
      const loading = document.createElement("div");
      loading.className = "loadingline";
      loading.textContent = "Loading " + (VIEW_TITLE[view] || view).toLowerCase() + "...";
      root.appendChild(loading);
    }
    const r = await api("GET", path);
    if (reqId !== dataReq) return;
    if (!r.ok) {
      if (cached !== undefined) return;
      root.textContent = "";
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent =
        r.status === 403 ? "You don't administer this scope." : r.data?.message || `Failed to load (${r.status}).`;
      root.appendChild(p);
      return;
    }
    if (cacheable) dataCache.set(path, r.data);
    viewLoadedAt[view] = Date.now();
    paintData(root, r.data);
  }
  function kpis(items, className = "") {
    const wrap = document.createElement("div");
    wrap.className = "kpis";
    if (className) wrap.classList.add(className);
    items.forEach(([n, k]) => {
      const d = document.createElement("div");
      d.className = "kpi";
      const a = document.createElement("div");
      a.className = "n";
      a.textContent = n;
      const b = document.createElement("div");
      b.className = "k";
      b.textContent = k;
      d.append(a, b);
      wrap.appendChild(d);
    });
    return wrap;
  }

  function spendQuery(st) {
    const { from, to, bucket } = governanceUI.spend.spendWindow(st);
    return new URLSearchParams({ from, to, bucket }).toString();
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
      downloadCsv: (breakdown = "entity") => {
        const a = document.createElement("a");
        a.href =
          API_BASE + "/spend?format=csv&breakdown=" + encodeURIComponent(breakdown) + "&" + spendQuery(urlToState());
        a.rel = "noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    });
  }
  function activityContext() {
    return {
      ...helpers(),
      all: orgWideView(),
      scope,
      errorsPageSize: ERRORS_PAGE_SIZE,
    };
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
    const box = document.createElement("div");
    box.className = "error-strip";
    const head = document.createElement("div");
    head.className = "error-strip-head";
    head.textContent = headText;
    box.appendChild(head);
    errs.slice(0, max).forEach((e) => {
      const link = rowLink ? rowLink(e) : null;
      const row = document.createElement(link ? "a" : "div");
      row.className = "error-strip-row";
      if (link) {
        row.href = link.href;
        row.onclick = (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
          ev.preventDefault();
          link.go();
        };
      }
      const msg = document.createElement("span");
      msg.className = "mono";
      msg.textContent = firstLine(e.message || "(no message)", 160);
      msg.title = e.message || "";
      const meta = document.createElement("span");
      meta.className = "subline";
      meta.textContent = [e.category || "uncategorized", e.code, relTime(e.ts)].filter(Boolean).join(" · ");
      row.append(msg, meta);
      box.appendChild(row);
    });
    if (errs.length > max) {
      const more = document.createElement("div");
      more.className = "subline";
      more.textContent = "…and " + (errs.length - max) + " more";
      box.appendChild(more);
    }
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
    switch (String(trigger || "").toLowerCase()) {
      case "cron":
        return "Cron";
      case "monitor":
        return "Monitor wake";
      case "webhook":
        return "Webhook wake";
      default:
        return "Background wake";
    }
  }
  function plural(n, one, many = one + "s") {
    return `${Number(n || 0).toLocaleString()} ${Number(n || 0) === 1 ? one : many}`;
  }
  function historyCategory(kind) {
    return kind === "cron" || kind === "background" ? "background" : kind;
  }

  const KIND_LABEL = { conversation: "Conversations", cron: "Cron runs", background: "Background" };
  function historyModeLabel(kind) {
    return KIND_LABEL[kind] || KIND_LABEL.conversation;
  }
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
      const units = [
        [86400000, "d"],
        [3600000, "h"],
        [60000, "m"],
        [1000, "s"],
      ];
      for (const [n, u] of units) if (sch.everyMs >= n && sch.everyMs % n === 0) return "every " + sch.everyMs / n + u;
      return "every " + sch.everyMs + " ms";
    }
    return sch.firstFireAt ? "once" : "Never";
  }
  function destinationSummary(dest) {
    if (!dest) return "None";
    return (dest.type || "destination") + " -> " + (dest.target || "-");
  }
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

  let openOvMenu = null;
  const closeOvMenus = () => {
    if (!openOvMenu) return;
    openOvMenu.menu.classList.add("hidden");
    openOvMenu.btn.setAttribute("aria-expanded", "false");
    openOvMenu = null;
  };
  document.addEventListener("click", closeOvMenus);
  document.addEventListener("scroll", closeOvMenus, true);
  window.addEventListener("resize", closeOvMenus);
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
  function renderKeychain(root, d) {
    governanceUI.keychain.keychain(root, d, {
      ...helpers(),
    });
  }
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
    try {
      return JSON.stringify(p, null, 2);
    } catch {
      return String(p);
    }
  }
  const stringify = (x) => {
    try {
      return JSON.stringify(x, null, 2);
    } catch {
      return String(x);
    }
  };
  const TOOL_PREVIEW_CHARS = 1800;
  function appendInlineMarkdown(parent, text) {
    const pushText = (s) => {
      if (s) parent.appendChild(document.createTextNode(s));
    };
    const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*([^*]+)\*)/g;
    let last = 0;
    for (const m of String(text || "").matchAll(re)) {
      pushText(text.slice(last, m.index));
      if (m[2]) {
        const strong = document.createElement("strong");
        strong.textContent = m[2];
        parent.appendChild(strong);
      } else if (m[3]) {
        const code = document.createElement("code");
        code.textContent = m[3];
        parent.appendChild(code);
      } else if (m[4] && m[5]) {
        const a = document.createElement("a");
        a.href = m[5];
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = m[4];
        parent.appendChild(a);
      } else if (m[6]) {
        const em = document.createElement("em");
        em.textContent = m[6];
        parent.appendChild(em);
      }
      last = m.index + m[0].length;
    }
    pushText(text.slice(last));
  }
  function renderMarkdown(text) {
    const root = document.createElement("div");
    root.className = "message-body";
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    let para = [];
    let list = null;
    let quote = [];
    let fence = null;
    const flushPara = () => {
      if (!para.length) return;
      const p = document.createElement("p");
      appendInlineMarkdown(p, para.join(" "));
      root.appendChild(p);
      para = [];
    };
    const flushList = () => {
      if (list) {
        root.appendChild(list.node);
        list = null;
      }
    };
    const flushQuote = () => {
      if (!quote.length) return;
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      appendInlineMarkdown(p, quote.join(" "));
      bq.appendChild(p);
      root.appendChild(bq);
      quote = [];
    };
    for (const line of lines) {
      const fenceMatch = line.match(/^```/);
      if (fence) {
        if (fenceMatch) {
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = fence.lines.join("\n");
          pre.appendChild(code);
          root.appendChild(pre);
          fence = null;
        } else {
          fence.lines.push(line);
        }
        continue;
      }
      if (fenceMatch) {
        flushPara();
        flushList();
        flushQuote();
        fence = { lines: [] };
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        flushPara();
        flushList();
        flushQuote();
        continue;
      }
      const quoteMatch = trimmed.match(/^>\s?(.*)$/);
      if (quoteMatch) {
        flushPara();
        flushList();
        quote.push(quoteMatch[1]);
        continue;
      }
      const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        flushPara();
        flushQuote();
        const ordered = /\d+\./.test(listMatch[1]);
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, node: document.createElement(ordered ? "ol" : "ul") };
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, listMatch[2]);
        list.node.appendChild(li);
        continue;
      }
      flushList();
      flushQuote();
      para.push(trimmed);
    }
    if (fence) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = fence.lines.join("\n");
      pre.appendChild(code);
      root.appendChild(pre);
    }
    flushPara();
    flushList();
    flushQuote();
    if (!root.childNodes.length) {
      const p = document.createElement("p");
      p.textContent = "";
      root.appendChild(p);
    }
    return root;
  }

  const isXmlishText = (text) => /^\s*<[A-Za-z][\w-]*(\s|\/?>)/.test(String(text || ""));
  function renderXmlish(text) {
    const root = document.createElement("div");
    root.className = "message-body xml-body";
    const unescape = (s) =>
      s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    const row = (cls, depth) => {
      const div = document.createElement("div");
      div.className = cls;
      div.style.paddingLeft = Math.min(depth, 8) * 18 + "px";
      root.appendChild(div);
      return div;
    };
    const addText = (s, depth) => {
      const t = s.replace(/^[\s\n]+|[\s\n]+$/g, "");
      if (t) appendInlineMarkdown(row("xml-text", depth), unescape(t));
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
  function toolTextCard(text) {
    const pre = document.createElement("pre");
    pre.className = "tool-command";
    pre.textContent = text;
    return pre;
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
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
  function copyButton(label, getText) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = label;
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
    const block = document.createElement("div");
    block.className = "entry tool-entry";
    const who = document.createElement("div");
    who.className = "who";
    const label = document.createElement("span");
    label.className = "tool-label";
    label.textContent = toolLabelText(tool, callPayload, resultPayload);
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = resultEntry
      ? `#${callEntry?.seq ?? "?"}→#${resultEntry.seq} · ${fmtTime(callEntry?.createdAt ?? resultEntry.createdAt)}`
      : `#${callEntry?.seq ?? resultEntry?.seq ?? "?"} · ${fmtTime(callEntry?.createdAt ?? resultEntry?.createdAt)}`;
    const status = document.createElement("div");
    status.className = "meta-row";
    toolStatusMeta(tool, resultPayload, !!resultEntry).forEach((item) => status.appendChild(item));
    if (contextBtn) who.appendChild(contextBtn);
    who.append(label);

    if (timingEl) who.appendChild(timingEl);
    who.append(
      when,
      status,
      copyButton("Copy", () => toolCopyText(callEntry, resultEntry)),
    );
    const body = document.createElement("div");
    body.className = "tool-body";
    const primaryText = toolPrimaryText(callPayload, resultPayload, !!callEntry, !!resultEntry);
    if (primaryText) {
      const truncated = primaryText.length > TOOL_PREVIEW_CHARS;
      const preview = truncated ? primaryText.slice(0, TOOL_PREVIEW_CHARS) + "…" : primaryText;
      const card = toolTextCard(preview);
      const syncExpanded = () => {
        const expanded = block.classList.contains("expanded");
        card.setAttribute("aria-expanded", String(expanded));
        card.title = expanded ? "Click to collapse tool text" : "Click to expand tool text";
        if (truncated) card.textContent = expanded ? primaryText : preview;
      };
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.onclick = () => {
        block.classList.toggle("expanded");
        syncExpanded();
      };
      card.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        block.classList.toggle("expanded");
        syncExpanded();
      };
      syncExpanded();
      body.appendChild(card);
    }

    if (delivery) {
      const dv = document.createElement("div");
      dv.className = "tool-delivery";
      const drow = document.createElement("div");
      drow.className = "who";
      const dlabel = document.createElement("span");
      dlabel.className = "entry-label important";
      dlabel.textContent = deliveryLabel(delivery);
      drow.appendChild(dlabel);
      if (delivery.shadow) {
        const sb = document.createElement("span");
        sb.className = "entry-label";
        sb.title = "Recorded for observability, never sent to the human (shadow-mode rollout)";
        sb.textContent = "not sent";
        drow.appendChild(sb);
      }
      drow.appendChild(badge(deliverySurfaceLabel(delivery), "info"));
      const mirror = slackMirrorRef(delivery);
      if (mirror) {
        const ml = navLink("View in Slack mirror ↗", { view: "slack", container: mirror.container, ts: mirror.ts });
        ml.title = "Jump to this message in the mirrored Slack channel " + mirror.container;
        drow.appendChild(ml);
      }
      const dwhen = document.createElement("span");
      dwhen.className = "when";
      dwhen.textContent = `${delivery.shadow ? "shadow" : "delivered"} · ${fmtTime(delivery.createdAt)}`;
      drow.appendChild(dwhen);
      const pre = document.createElement("pre");
      const from = delivery.destination?.onBehalfOf ? `from ${delivery.destination.onBehalfOf}\n` : "";
      const to = delivery.destination?.target ? `to ${delivery.destination.target}\n` : "";
      const recipientLine = delivery.recipientThreadRef ? `recipient thread ${delivery.recipientThreadRef}\n` : "";
      pre.textContent = `${from}${to}${recipientLine}${delivery.text || ""}`.trim();
      dv.append(drow, pre);
      const files = deliveryFileBadges(delivery.attachments);
      if (files) dv.appendChild(files);
      body.appendChild(dv);
    }
    block.append(who);
    block.appendChild(body);
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

  async function showContextPage(sessionId, turnSeq) {
    return governanceUI.transcript.contextPage(sessionId, turnSeq, transcriptServices());
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
  function slackMentionSpan(text) {
    const s = document.createElement("span");
    s.className = "sm-mention";
    s.textContent = text;
    return s;
  }

  function slackEntityNode(inner, mentions) {
    const u = slackUnescape(inner);
    if (u[0] === "@") {
      const [id, label] = u.slice(1).split("|");
      return slackMentionSpan("@" + (label || (mentions && mentions[id]) || id));
    }
    if (u[0] === "#") {
      const [id, label] = u.slice(1).split("|");
      return slackMentionSpan("#" + (label || id));
    }
    if (u[0] === "!") {
      const [cmd, label] = u.slice(1).split("|");
      return slackMentionSpan("@" + (label || cmd.split("^")[0]));
    }
    const bar = u.indexOf("|");
    const url = bar === -1 ? u : u.slice(0, bar);
    const label = bar === -1 ? url : u.slice(bar + 1);

    if (!/^(https?:|mailto:|tel:)/i.test(url)) return document.createTextNode(label);
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    return a;
  }

  function slackAppendMrkdwn(raw, parent) {
    const text = slackUnescape(raw);
    const re = /\*([^*\n]+)\*|(?<!\w)_([^_\n]+)_(?!\w)|~([^~\n]+)~|(https?:\/\/[^\s<>]+)/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      let el;
      if (m[1] != null) {
        el = document.createElement("strong");
        el.textContent = m[1];
      } else if (m[2] != null) {
        el = document.createElement("em");
        el.textContent = m[2];
      } else if (m[3] != null) {
        el = document.createElement("s");
        el.textContent = m[3];
      } else {
        let url = m[4].replace(/[.,;!?]+$/, "");
        while (url.endsWith(")") && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length)
          url = url.slice(0, -1);
        el = slackEntityNode(url);
        parent.appendChild(el);
        parent.appendChild(document.createTextNode(m[4].slice(url.length)));
        last = re.lastIndex;
        continue;
      }
      parent.appendChild(el);
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function slackParseInline(text, parent, mentions) {
    const re = /`([^`\n]+)`|<([^>\n]+)>|:([a-z0-9_+'-]+):/g;
    let last = 0,
      m;
    while ((m = re.exec(text))) {
      if (m.index > last) slackAppendMrkdwn(text.slice(last, m.index), parent);
      if (m[1] != null) {
        const c = document.createElement("code");
        c.className = "sm-code";
        c.textContent = slackUnescape(m[1]);
        parent.appendChild(c);
      } else if (m[2] != null) parent.appendChild(slackEntityNode(m[2], mentions));
      else {
        const emoji = governanceUI.charForName(m[3]);
        if (emoji) parent.appendChild(document.createTextNode(emoji));
        else slackAppendMrkdwn(m[0], parent);
      }
      last = re.lastIndex;
    }
    if (last < text.length) slackAppendMrkdwn(text.slice(last), parent);
  }

  function slackParseText(raw, mentions) {
    const frag = document.createDocumentFragment();
    if (!raw) return frag;
    raw.split("```").forEach((part, i) => {
      if (i % 2 === 1) {
        const pre = document.createElement("pre"),
          code = document.createElement("code");
        code.textContent = slackUnescape(part.replace(/^\n/, "").replace(/\n$/, ""));
        pre.appendChild(code);
        frag.appendChild(pre);
      } else {
        let quote = null;
        part.split("\n").forEach((line, lineIndex) => {
          const quoted = /^(?:>|&gt;) ?/.test(line);
          if (quoted) {
            if (!quote) {
              quote = document.createElement("blockquote");
              frag.appendChild(quote);
            } else quote.appendChild(document.createTextNode("\n"));
            slackParseInline(line.replace(/^(?:>|&gt;) ?/, ""), quote, mentions);
          } else {
            if (lineIndex && !quote) frag.appendChild(document.createTextNode("\n"));
            quote = null;
            slackParseInline(line, frag, mentions);
          }
        });
      }
    });
    return frag;
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
  async function renderSlackMirror(st) {
    return governanceUI.slackActivity.renderSlackMirror(st);
  }
  function deliverySurfaceLabel(event) {
    const type = event?.destination?.type;
    if (type === "principal") return "Slack DM";
    if (type === "slack") return "Slack";
    if (type === "web") return "Web";
    return type || "Unknown surface";
  }

  function deliveryLabel(event) {
    if (event.shadow) return "Shadow delivery";
    return `${deliverySurfaceLabel(event)} delivery`;
  }

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
  async function showTranscript(sessionId, limit, expand) {
    return governanceUI.transcript.show(sessionId, limit, expand, transcriptServices());
  }

  function estimateTokens(text) {
    const n = (text || "").length;
    return n ? Math.max(1, Math.round(n / 4)) : 0;
  }
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
      const mt = (o.source && o.source.media_type) || "image";
      const data = o.source && typeof o.source.data === "string" ? o.source.data : "";
      return "[image " + mt + (data ? " · " + data : "") + "]";
    }
    if (o.type === "tool_use")
      return "[tool_use " + (o.name || "tool") + (o.id ? " · " + o.id : "") + "]\n" + stringify(o.input ?? {});
    if (o.type === "tool_result")
      return (
        "[tool_result" +
        (o.tool_use_id ? " " + o.tool_use_id : "") +
        (o.is_error ? " · error" : "") +
        "]\n" +
        blockText(o.content)
      );
    if (o.type === "thinking")
      return (
        "[thinking]\n" +
        (typeof o.thinking === "string" ? o.thinking : "") +
        (typeof o.signature === "string" ? "\n[signature " + o.signature + "]" : "")
      );
    if (o.type === "redacted_thinking")
      return "[redacted_thinking" + (typeof o.data === "string" ? " " + o.data : "") + "]";
    if (o.type === "document") return "[document " + (o.title || o.name || "attachment") + "]";
    return stringify(o);
  }
  function messageEntryText(m) {
    const role = m && typeof m === "object" ? m.role || "message" : "message";
    const name = m && typeof m === "object" && m.name ? " (" + m.name + ")" : "";
    const content = m && typeof m === "object" ? blockText(m.content) : blockText(m);
    return "[" + String(role) + name + "]\n" + (content.length ? content : "(no content)");
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
      if (cc) {
        const ttl = cc && typeof cc === "object" && cc.ttl ? " " + cc.ttl : "";
        out += "\n\n────── cache breakpoint (" + ((cc && cc.type) || "ephemeral") + ttl + ") ──────\n";
        cacheSplit = true;
      }
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
  function requestBody(q) {
    return q && q.promptEnvelope != null ? q.promptEnvelope : null;
  }
  function contextSections(request, transport) {
    const req = request && typeof request === "object" ? request : {};
    const messages = Array.isArray(req.messages) ? req.messages : [];
    const params = {};
    for (const [k, v] of Object.entries(req)) {
      if (k !== "system" && k !== "messages" && k !== "tools") params[k] = v;
    }
    const sys = systemToText(req.system);
    const sections = [
      { key: "transport", label: "Transport", note: "model + headers", text: transportText(transport) },
      {
        key: "system",
        label: "System prompt",
        note: sys.cacheSplit ? "verbatim · cache split shown" : "verbatim",
        text: sys.text,
      },
      {
        key: "messages",
        label: "Messages",
        note: messages.length
          ? messages.length + " message" + (messages.length === 1 ? "" : "s")
          : "not re-captured per step; the transcript is the record",
        text: messages.map(messageEntryText).join("\n\n"),
      },
      {
        key: "tools",
        label: "Tool schemas",
        note: Array.isArray(req.tools) ? req.tools.length + " tool" + (req.tools.length === 1 ? "" : "s") : "tools",
        text: req.tools == null ? "" : stringify(req.tools),
      },
      {
        key: "params",
        label: "Request params",
        note: Object.keys(params).length + " field" + (Object.keys(params).length === 1 ? "" : "s"),
        text: Object.keys(params).length ? stringify(params) : "",
      },
    ].filter((s) => s.text);
    return sections.map((s) => ({ ...s, tokens: estimateTokens(s.text), chars: s.text.length }));
  }
  function contextTotal(sections) {
    return sections.reduce((n, s) => n + s.tokens, 0);
  }
  function callCacheUsage(q) {
    const u = q && q.usage;
    if (!u || typeof u !== "object") return null;
    const read = Number(u.cacheRead) || 0,
      write = Number(u.cacheWrite) || 0,
      uncached = Number(u.input) || 0;
    return { cacheRead: read, cacheWrite: write, uncachedInput: uncached };
  }
  function sumCacheUsage(requests) {
    let saw = false,
      cacheRead = 0,
      cacheWrite = 0,
      uncachedInput = 0;
    for (const q of requests || []) {
      const u = callCacheUsage(q);
      if (!u) continue;
      saw = true;
      cacheRead += u.cacheRead;
      cacheWrite += u.cacheWrite;
      uncachedInput += u.uncachedInput;
    }
    return saw ? { cacheRead, cacheWrite, uncachedInput } : null;
  }

  function realInputTokens(q) {
    const u = callCacheUsage(q);
    if (!u) return null;
    const sum = u.cacheRead + u.cacheWrite + u.uncachedInput;
    return sum > 0 ? sum : null;
  }
  function fmtContextSize(q, sections) {
    const real = realInputTokens(q);
    return real != null ? fmtTokens(real) : "~" + fmtTokens(contextTotal(sections));
  }
  function cacheHitRatio(u) {
    if (!u) return null;
    const denom = u.cacheRead + u.cacheWrite + u.uncachedInput;
    return denom > 0 ? u.cacheRead / denom : null;
  }
  function isStablePrefixMiss(u) {
    const ratio = cacheHitRatio(u);
    if (ratio === null) return false;
    return u.cacheWrite >= 1024 && ratio < 0.1;
  }
  function metaChip(text, kind = "") {
    const s = document.createElement("span");
    s.className = "meta-chip" + (kind ? " " + kind : "");
    s.textContent = text;
    return s;
  }
  function cacheMetaItems(u) {
    if (!u) return [];
    const ratio = cacheHitRatio(u);
    const miss = isStablePrefixMiss(u);
    const out = [metaChip("cache " + (ratio === null ? "n/a" : fmtPct(ratio)), miss ? "danger" : "")];
    if (miss) out.push(metaChip("stable-prefix miss", "danger"));
    return out;
  }

  function durSeg(ms, label) {
    const span = document.createElement("span");
    let cls = "";
    if (ms >= 30000) cls = "dur-hot";
    else if (ms >= 5000) cls = "dur-warm";
    if (cls) span.className = cls;
    span.textContent = fmtMs(ms);
    if (!label) return span;
    const wrap = document.createDocumentFragment();
    const lbl = document.createElement("span");
    lbl.className = "seg-label";
    lbl.textContent = label + " ";
    wrap.append(lbl, span);
    return wrap;
  }

  function stepDurEl(segs) {
    const parts = (segs || []).filter(([ms]) => ms != null && ms >= 0);
    if (!parts.length) return null;
    const el = document.createElement("span");
    el.className = "step-dur";
    parts.forEach(([ms, label], i) => {
      if (i) el.appendChild(document.createTextNode(" · "));
      el.appendChild(durSeg(ms, label));
    });
    return el;
  }
  function rawJsonLink(requests, label = "Raw JSON") {
    const a = document.createElement("a");
    a.className = "context-raw";
    let payload;
    if (requests.length === 1) {
      payload = requestBody(requests[0]);
      if (requests[0]?.transport) payload = { request: requestBody(requests[0]), transport: requests[0].transport };
    } else {
      payload = requests.map((q) => ({
        step: q.step,
        model: q.model,
        createdAt: q.createdAt,
        truncated: !!q.truncated,
        ...(q.transport ? { transport: q.transport } : {}),
        request: requestBody(q),
      }));
    }
    a.href = "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;

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
    const a = document.createElement("a");
    a.href = href;
    a.download = f.name || fileName(f.path);
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
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
  route();
  return {
    route,
    show: (v) => (v === "general" ? go({ view: "general", scope, session: null }) : setView(v)),
  };
}
