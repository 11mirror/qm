import { escapeHtml } from "./http.ts";

export const CARD_SCENE_PATH = "/auth/assets/becalmed-off-halfway-rock.webp";

const CARD_STYLE = `<style>
  :root{
    color-scheme:light;
    --paper:#f7f6f2; --ink:#1b3043; --muted:#6b706f; --line:#d6d9d9; --warn:#9d3927; --warn-bg:#f6e7e3;
    --brand-font:"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color:var(--ink); background:var(--paper); -webkit-font-smoothing:antialiased;
  }
  *{ box-sizing:border-box; }
  body{ margin:0; }
  main{ position:relative; min-height:100vh; isolation:isolate; padding:155px 24px 220px; }
  .harbour{ position:absolute; inset:0; z-index:-1; margin:0; overflow:hidden; background:#d8d0bd; }
  .harbour > img{ position:absolute; width:100%; height:100%; object-fit:cover; object-position:center 62%; }
  .masthead{ position:relative; padding:62px 52px 26px; }
  .wordmark{ font-family:var(--brand-font); font-size:40px; letter-spacing:-2px; line-height:1; }
  figcaption{ position:absolute; bottom:19px; right:28px; display:flex; gap:12px; font-size:9px; letter-spacing:.035em;
    color:#fffaf0; text-shadow:0 1px 5px #211c14; }
  figcaption span{ opacity:.85; }
  .card{ width:min(100%, 420px); margin-inline:auto; padding:28px; border:1px solid #fffaf080; border-radius:12px;
    background:rgb(247 246 242 / 88%); box-shadow:0 4px 24px rgb(37 38 31 / 5%); backdrop-filter:blur(12px);
    -webkit-backdrop-filter:blur(12px); }
  .icon{ display:flex; margin-bottom:12px; }
  .icon svg{ width:22px; height:22px; stroke:var(--ink); fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .icon.warn svg{ stroke:var(--warn); }
  h1{ font-size:15px; font-weight:600; margin:0 0 7px; }
  .msg{ font-size:12px; line-height:1.6; color:var(--muted); margin:0 0 16px; }
  .reason{ margin:0 0 16px; font-size:12px; line-height:1.5; color:var(--ink); background:var(--warn-bg);
    border:1px solid #e8cfc8; border-radius:7px; padding:10px 12px; word-break:break-word; }
  .reason strong{ display:block; color:var(--warn); font-size:11px; font-weight:600; margin-bottom:3px; }
  #invite-status, #admin-email{ font-size:12px; color:var(--ink); margin:0 0 16px; }
  #invite-status:empty, #admin-email:empty{ display:none; }
  .actions{ display:grid; gap:10px; }
  .actions form{ display:grid; margin:0; }
  .btn{ display:flex; justify-content:space-between; align-items:center; width:100%; border-radius:7px; padding:12px 14px;
    font:inherit; font-size:12px; text-decoration:none; cursor:pointer; }
  .btn.primary{ border:none; background:var(--ink); color:#fff; }
  .btn.primary::after{ content:"→"; font-size:19px; line-height:16px; }
  .btn.primary:hover{ background:#29445b; }
  .btn.ghost{ border:1px solid var(--line); background:#fdfdfb; color:var(--ink); }
  .btn.ghost:hover{ background:#fff; }
  .btn:focus-visible{ outline:2px solid #8394a0; outline-offset:3px; }
  .btn:disabled{ opacity:.65; cursor:wait; }
  .help{ color:#78807f; font-size:10px; line-height:1.5; margin:13px 0 0; text-align:center; }
  @media (max-width:600px){
    main{ padding-top:130px; }
    .masthead{ padding-inline:28px; }
    .card{ padding:24px; }
    figcaption{ left:20px; right:auto; font-size:8px; }
  }
</style>`;

export const ALERT_ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/></svg>`;
export const LOCK_ICON = `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;

export function cardPage(o: {
  title: string;
  heading: string;
  msg: string;
  icon: string;
  warn?: boolean;
  extra?: string;
  actions: string;
  help: string;
  brand?: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)} · ${escapeHtml(o.brand || "QM")}</title>
${CARD_STYLE}
</head>
<body>
  <main>
    <figure class="harbour">
      <img src="${CARD_SCENE_PATH}" alt="Sailing ships resting on still, sunlit water in Becalmed off Halfway Rock by Fitz Henry Lane.">
      <header class="masthead"><span class="wordmark">${escapeHtml(o.brand || "QM")}</span></header>
      <figcaption>Becalmed off Halfway Rock<span>Fitz Henry Lane, 1860</span></figcaption>
    </figure>
    <section class="card" aria-labelledby="t">
      <div class="icon${o.warn ? " warn" : ""}" aria-hidden="true">
        ${o.icon}
      </div>
      <h1 id="t">${escapeHtml(o.heading)}</h1>
      ${o.msg ? `<p class="msg">${escapeHtml(o.msg)}</p>` : ""}
      ${o.extra ?? ""}
      <div class="actions">
        ${o.actions}
      </div>
      ${o.help ? `<p class="help">${escapeHtml(o.help)}</p>` : ""}
    </section>
  </main>
</body>
</html>`;
}
