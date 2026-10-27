import { externalAppSharingAllowed } from "../../feature-flags.ts";
import { reportFailureAs, swallowAs } from "../../util/errors.ts";
import { escapeHtml } from "../../../plugins/chassis/src/http.ts";
import { sendJson } from "../http.ts";
import { scopeId, type Permission } from "../../types.ts";
import type { BaseCtx } from "./route.ts";
import type { Deployment } from "../../deploy/deploy-store.ts";
import { appAnnotationAsset } from "../../deploy/app-annotate.ts";
import { APP_SHELL_PATH_PREFIX, appShellHtml } from "../../deploy/app-shell.ts";
import type { AppViewAuthMode } from "../../deploy/page-views.ts";
import { principalDestination } from "../../reach/reach.ts";
import { FRAME_SESSION_COOKIE, portalSession, portalSessionFrom } from "../../deploy/viewer-session.ts";
import { APP_SLUG, frameAncestorsDirective, proxyReach } from "./deployment-upstream.ts";

export async function proxyDeploymentSubdomain(ctx: BaseCtx): Promise<boolean> {
  const { req, res, app, deps, url, pathname } = ctx;
  const appsDomain = deps.deployAppsDomain;
  const gateSecret = deps.deployGateSecret;
  const fromAppHost = req.headers["x-qm-app-host"] === "1";
  const reply = (status: number, body: Record<string, unknown>): true => {
    sendJson(res, status, body);
    return true;
  };
  if (!appsDomain || !gateSecret)
    return fromAppHost && reply(503, { error: "unavailable", message: "app gateway is not configured" });
  const rawHost = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
  const suffix = `.${appsDomain.toLowerCase()}`;
  if (!rawHost || !rawHost.endsWith(suffix)) return fromAppHost && reply(404, { error: "not_found" });
  const slug = rawHost.slice(0, -suffix.length);
  if (!APP_SLUG.test(slug)) return reply(404, { error: "not_found" });
  const dest = req.headers["sec-fetch-dest"];
  const site = req.headers["sec-fetch-site"];
  if (!["GET", "HEAD", "OPTIONS"].includes(ctx.method)) {
    const origin = req.headers.origin;
    if ((origin !== undefined && origin !== `https://${rawHost}`) || (site !== undefined && site !== "same-origin"))
      return reply(403, { error: "forbidden", message: "cross-origin app request refused" });
  }
  const safePathname =
    pathname.startsWith("/") && !pathname.startsWith("//") && !/[\\\x00-\x1f]/.test(pathname) ? pathname : "/";
  const staleAccess = url.searchParams.has("access");
  url.searchParams.delete("access");
  const staleOwner = url.searchParams.has("owner");
  url.searchParams.delete("owner");
  const signInAttempted = url.searchParams.get("dpl_signin") === "1";
  url.searchParams.delete("dpl_signin");
  const redirect = (location: string): true => {
    res.writeHead(302, { location, "cache-control": "no-store" });
    res.end();
    return true;
  };
  const cleanUrlRedirect = (): true => {
    const qs = url.searchParams.toString();
    return redirect(safePathname + (qs ? `?${qs}` : ""));
  };
  if ((staleAccess || staleOwner) && ctx.method === "GET") return cleanUrlRedirect();
  const deployment = await app.getDeployment(slug).catch(swallowAs("deployments: load deployment", null));
  const externalAllowed = deployment
    ? await externalAppSharingAllowed(deps.featureFlags, deployment.ownerScopeId)
    : false;
  const isPublic = deployment?.public === true && externalAllowed;
  const sessionSecret = deps.deployAppsSessionSecret;
  const loginUrl = deps.deployAppsLoginUrl;
  const wantsHtml = ctx.method === "GET" && String(req.headers.accept ?? "").includes("text/html");
  let session = sessionSecret ? portalSession(req.headers.cookie, sessionSecret) : null;
  const framed = dest === "iframe" || site === "same-origin";
  const embedAncestors = framed ? (deployment?.embedAncestors ?? []) : [];
  if (!session && sessionSecret && embedAncestors.length) {
    session = portalSessionFrom(req.headers.cookie, FRAME_SESSION_COOKIE, sessionSecret);
  }
  const sub = session?.sub;
  if (embedAncestors.length) res.setHeader("content-security-policy", frameAncestorsDirective(embedAncestors));
  if (!isPublic && (!sessionSecret || !loginUrl))
    return reply(503, { error: "unavailable", message: "sign-in is not configured for deployment subdomains" });
  if (!sub && !isPublic) {
    const qs = url.searchParams.toString();
    const returnTo = `https://${rawHost}${safePathname}?${qs ? `${qs}&` : ""}dpl_signin=1`;
    const signIn = `${loginUrl}${deps.deployAppsLoginPath ?? "/auth/login"}?returnTo=${encodeURIComponent(returnTo)}`;
    if (!wantsHtml) return reply(401, { error: "unauthorized", message: "sign-in required", loginUrl: signIn });
    return signInAttempted ? sendGateHtml(res, 401, signInFailedHtml(signIn)) : redirect(signIn);
  }
  const bareApp = url.searchParams.get("__qm_no_shell") === "1";
  url.searchParams.delete("__qm_no_shell");
  const isShellRequest = pathname.startsWith(APP_SHELL_PATH_PREFIX);
  const canManage = sub && !session?.appOnly ? await app.canManageDeployment(slug, sub) : false;
  const authenticatedPermission =
    sub && deployment ? await viewerPermission(ctx, deployment, sub, session?.appOnly === true, externalAllowed) : null;
  const isPageLoad =
    ctx.method === "GET" &&
    wantsHtml &&
    (dest === undefined || dest === "document" || (dest === "iframe" && site !== "same-origin"));
  const recordPageView = (authMode: AppViewAuthMode): void => {
    if (!isPageLoad || !deployment || !deps.appPageViews) return;
    const forwardedIp = fromAppHost ? req.headers["x-qm-client-ip"] : undefined;
    const ip = typeof forwardedIp === "string" && forwardedIp ? forwardedIp : (req.socket.remoteAddress ?? null);
    const userAgent = req.headers["user-agent"];
    void deps.appPageViews
      .record({
        deploymentId: deployment.id,
        version: deployment.appliedVersion ?? deployment.currentVersion ?? null,
        viewer: sub ?? null,
        authMode,
        at: Date.now(),
        path: safePathname,
        ip,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      })
      .catch(reportFailureAs("app page view log", undefined, deployment.id));
  };
  if (ctx.method === "GET" && ((!bareApp && dest === "document") || isShellRequest) && canManage && loginUrl) {
    const annotationsEnabled =
      !!sub && (await deps.featureFlags?.enabled("app_annotations", scopeId("personal", sub))) === true;
    if (signInAttempted) return cleanUrlRedirect();
    if (isShellRequest) {
      if (pathname === "/__claw__/version" && deployment)
        return reply(200, { version: deployment.appliedVersion ?? deployment.currentVersion });
      if (!annotationsEnabled || (pathname !== "/__claw__/annotate.js" && pathname !== "/__claw__/annotate.css"))
        return reply(404, { error: "not_found" });
      return sendAnnotationAsset(res, pathname.endsWith(".js") ? "js" : "css");
    }
    recordPageView("signed_in");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      appShellHtml({
        annotationsEnabled,
        slug,
        name: deployment?.displayName ?? slug,
        portalUrl: loginUrl,
        path: safePathname + url.search,
      }),
    );
    return true;
  }
  const viewer = sub ?? "";
  const reach =
    session?.appOnly && !isPublic && !authenticatedPermission
      ? { status: deployment ? ("denied" as const) : ("not_found" as const) }
      : await app.reachDeployment(
          deployment?.id ?? slug,
          viewer,
          canManage || isPublic || session?.appOnly ? { bypassAcl: true } : undefined,
        );
  if (reach.status === "denied") await auditReachDenied(ctx, viewer, slug, deployment);
  if (reach.status === "denied" && ctx.method === "POST" && pathname === REQUEST_ACCESS_PATH) {
    if (!deployment) return reply(404, { error: "not_found" });
    const delivered = await requestAppAccess(ctx, deployment, viewer, slug, rawHost);
    return delivered
      ? reply(200, { ok: true })
      : reply(502, { error: "delivery_failed", message: "the request could not be delivered — try again later" });
  }
  if (reach.status === "denied" && wantsHtml) return sendGateHtml(res, 403, notSharedHtml(viewer));
  if (reach.status === "ok" && signInAttempted && ctx.method === "GET") return cleanUrlRedirect();
  const signedInViewer = sub && (canManage || authenticatedPermission) ? sub : undefined;
  if (reach.status === "ok") {
    const signedInMode: AppViewAuthMode = signedInViewer ? "signed_in" : "public";
    recordPageView(session?.appOnly ? "app_only" : signedInMode);
  }
  await proxyReach(ctx, reach, pathname, signedInViewer, { frameAncestors: embedAncestors });
  return true;
}

async function viewerPermission(
  { app, deps }: BaseCtx,
  deployment: Deployment,
  sub: string,
  appOnly: boolean,
  externalAllowed: boolean,
): Promise<Permission | null> {
  if (!appOnly) return app.effectiveDeploymentPermission(deployment, sub);
  await deps.identity?.refresh();
  return externalAllowed &&
    deps.identity?.deactivationSource(sub) !== "manual" &&
    (await app.deploymentGrantees(deployment.id)).some(
      (grant) => grant.scope === scopeId("personal", sub.trim().toLowerCase()) && grant.permission === "read",
    )
    ? "read"
    : null;
}

async function auditReachDenied(
  { deps }: BaseCtx,
  viewer: string,
  slug: string,
  deployment: Deployment | null,
): Promise<void> {
  const ev = {
    at: Date.now(),
    principalId: viewer,
    action: "deployment.reach_denied",
    resource: slug,
    scopeLabel: deployment?.ownerScopeId ?? scopeId("personal", viewer),
    status: "denied",
  };
  const hour = Math.floor(ev.at / 3_600_000);
  if (deps.auditLog?.recordOnce) await deps.auditLog.recordOnce(`reach_denied|${viewer}|${slug}|${hour}`, ev);
  else deps.auditLog?.record(ev);
}

async function requestAppAccess(
  { app }: BaseCtx,
  d: Deployment,
  viewer: string,
  slug: string,
  rawHost: string,
): Promise<boolean> {
  const [ownerKind, ownerRef] = String(d.ownerScopeId).split(":", 2);
  const ownerId = ownerKind === "personal" && ownerRef ? ownerRef : d.createdBy;
  const label = d.displayName ?? d.name ?? slug;
  const day = Math.floor(Date.now() / 86_400_000);
  try {
    await app.postToSurface({
      destination: {
        ...principalDestination(ownerId, viewer),
        deploymentAccess: { deploymentId: d.id, requesterId: viewer },
      },
      text:
        `${viewer} is asking for access to your app "${label}" (https://${rawHost}/). ` +
        `They signed in but the app isn't shared with them. To grant it, share the deployment with personal:${viewer}.`,
      idempotencyKey: `deploy-access-request:${slug}:${viewer}:${day}`,
    });
    return true;
  } catch {
    return false;
  }
}

function sendAnnotationAsset(res: BaseCtx["res"], kind: "js" | "css"): true {
  res.writeHead(200, {
    "content-type": kind === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(appAnnotationAsset(kind));
  return true;
}

function sendGateHtml(res: BaseCtx["res"], status: number, html: string): true {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(html);
  return true;
}

function gateCardHtml(title: string, paragraphsHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fafafa;
font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.card{max-width:420px;text-align:center;padding:32px 20px}h1{font-size:19px;margin:0 0 10px}
p{color:#a3a3a3;margin:0 0 8px}b{color:#fafafa}a{color:#fafafa}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${paragraphsHtml}</div></body></html>`;
}

const REQUEST_ACCESS_PATH = "/__claw__/request-access";

function notSharedHtml(sub: string): string {
  return gateCardHtml(
    "This app hasn't been shared with you",
    `<p>You're signed in as <b>${escapeHtml(sub)}</b>, but this app's owner hasn't shared it with you.</p>
<p>Ask the owner for access, or for the app's share link.</p>
<p><button id="req" style="margin-top:12px;padding:8px 18px;border-radius:8px;border:1px solid #3f3f3f;
background:#fafafa;color:#0a0a0a;font:inherit;font-weight:600;cursor:pointer">Request access</button></p>
<script>document.getElementById("req").addEventListener("click",async function(){
var b=this;b.disabled=true;b.textContent="Sending\u2026";
try{var r=await fetch(${JSON.stringify(REQUEST_ACCESS_PATH)},{method:"POST"});
b.textContent=r.ok?"Request sent \u2713":"Couldn't send \u2014 try again";b.disabled=r.ok;}
catch(e){b.textContent="Couldn't send \u2014 try again";b.disabled=false;}});</script>`,
  );
}

function signInFailedHtml(signIn: string): string {
  return gateCardHtml(
    "Sign-in didn't reach this app",
    `<p>You signed in, but this app never received your session. This usually means the app gateway is misconfigured — tell whoever runs it.</p>
<p><a href="${escapeHtml(signIn)}">Try signing in again</a></p>`,
  );
}
