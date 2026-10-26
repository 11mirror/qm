import { refusal, sendJson } from "../../http.ts";
import { orgAdmin } from "./common.ts";
import type { ApiCtx } from "../route.ts";
import { errMessage } from "../../../util/errors.ts";
import { validateSlackInstallation } from "../../../surfaces/slack-installation.ts";
import { slackBotManifestCreationUrl } from "../../../surfaces/slack-manifest.ts";
import { resolveBranding } from "../../../resolution/branding.ts";
import emojiData from "emoji-datasource/emoji.json" with { type: "json" };

type StandardEmojiEntry = [name: string, char: string, category: string];
let standardEmojiCache: StandardEmojiEntry[] | undefined;
const standardEmoji = (): StandardEmojiEntry[] =>
  (standardEmojiCache ??= [...emojiData]
    .filter((e) => e.category !== "Component" && e.unified)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((e) => [e.short_name, String.fromCodePoint(...e.unified.split("-").map((h) => parseInt(h, 16))), e.category]));

export async function getSlackInstallation(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { scope } = authz;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  authz.audit("slack-installation.read", "slack-installation");
  const branding = await resolveBranding(ctx.deps.config, scope, ctx.deps.brandingDefault);
  const createUrl = slackBotManifestCreationUrl(branding.selfLabel);
  const status = await ctx.deps.slackInstallation.status();
  const fromEnvironment = () =>
    sendJson(ctx.res, 200, { configured: true, managed: false, source: "environment", createUrl });
  if (ctx.deps.managedSlack) {
    if (!status.managed && ctx.deps.slackEnvironmentState === "configured") return fromEnvironment();
    const installation = await ctx.deps.slackInstallation.get();
    let setup;
    let setupUnavailable = false;
    try {
      const progress = await ctx.deps.managedSlack.setupStatus();
      const origin = ctx.deps.portalUrl ?? ctx.deps.publicUrl;
      if (progress?.companyOwned && origin) {
        setup = {
          ...progress,
          tokenUrl: "https://api.slack.com/apps",
          submitUrl: new URL("/settings/slack-settings?slack=setup", origin).href,
          installUrl: new URL("/settings/slack-settings?slack=install", origin).href,
          statusUrl: new URL("/api/admin/slack-installation", origin).href,
        };
      }
    } catch {
      setupUnavailable = true;
    }
    return sendJson(ctx.res, 200, {
      ...status,
      setup,
      setupUnavailable,
      source: installation?.appToken ? "admin" : "service",
      installAvailable: true,
      createUrl,
    });
  }
  if (status.managed) return sendJson(ctx.res, 200, { ...status, source: "admin", createUrl });
  if (ctx.deps.slackEnvironmentState === "configured") return fromEnvironment();
  return sendJson(ctx.res, 200, {
    configured: false,
    managed: false,
    source: ctx.deps.slackEnvironmentState === "partial" ? "invalid_environment" : "none",
    createUrl,
  });
}

export async function putSlackInstallation(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { actor } = authz;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  const body = ctx.body as { botToken?: unknown; appToken?: unknown };
  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
  try {
    const workspace = await validateSlackInstallation(
      botToken,
      appToken,
      ctx.deps.slackInstallationFetch,
      ctx.deps.slackInstallationSocketAppId,
    );
    const status = await ctx.deps.slackInstallation.set({ botToken, appToken, ...workspace, updatedBy: actor.id });
    authz.audit("slack-installation.update", "slack-installation");
    return sendJson(ctx.res, 200, { ...status, source: "admin" });
  } catch (error) {
    throw refusal(400, "invalid_slack_installation", error);
  }
}

export async function deleteSlackInstallation(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { actor } = authz;
  if (!ctx.deps.slackInstallation) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.slackInstallation.delete(actor.id);
  authz.audit("slack-installation.delete", "slack-installation");
  return sendJson(ctx.res, 200, { configured: false, managed: true, source: "admin" });
}

export async function getSlackEmojiList(ctx: ApiCtx): Promise<void> {
  const authz = await orgAdmin(ctx);
  if (!authz) return;
  const { scope } = authz;
  const managed = await ctx.deps.slackInstallation?.get();
  const botToken = managed?.botToken ?? ctx.deps.slackEnvBotToken ?? "";
  if (!botToken) {
    const cached = await ctx.deps.config?.getSlackEmojiCatalogDurable(scope);
    if (cached && Object.keys(cached.emoji).length)
      return sendJson(ctx.res, 200, { emoji: cached.emoji, standard: standardEmoji() });
    return sendJson(ctx.res, 404, { error: "not_configured" });
  }
  const doFetch = ctx.deps.slackInstallationFetch ?? fetch;
  try {
    const res = await doFetch("https://slack.com/api/emoji.list", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/x-www-form-urlencoded" },
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; emoji?: Record<string, string> };
    if (!data.ok) return sendJson(ctx.res, 502, { error: "slack_error", message: data.error ?? "unknown" });
    const emoji: Record<string, string> = {};
    for (const [name, url] of Object.entries(data.emoji ?? {})) {
      if (typeof url === "string" && url.startsWith("alias:")) continue;
      emoji[name] = url;
    }
    return sendJson(ctx.res, 200, { emoji, standard: standardEmoji() });
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "slack_unreachable", message: errMessage(error) });
  }
}

export async function startSlackInstallation(ctx: ApiCtx): Promise<void> {
  if (!(await orgAdmin(ctx))) return;
  if (!ctx.deps.managedSlack) return sendJson(ctx.res, 404, { error: "not_configured" });
  try {
    const step = (ctx.body as { step?: unknown } | undefined)?.step ?? "install";
    if (step !== "setup" && step !== "install") return sendJson(ctx.res, 400, { error: "invalid_step" });
    const result = await ctx.deps.managedSlack.start(step);
    return sendJson(ctx.res, 200, result);
  } catch {
    return sendJson(ctx.res, 502, { error: "slack_installation_unavailable" });
  }
}

export async function managedSlackRequest(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.managedSlack) return sendJson(ctx.res, 404, { error: "not_configured" });
  await ctx.deps.managedSlack.handle(ctx.req, ctx.res, ctx.body);
}
