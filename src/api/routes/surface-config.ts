import { runtimeConfigBody, userRuntimeConfigBody, webuiModelEnabled } from "../runtime-config.ts";
import type { ScopeId } from "../../types.ts";
import { parseScopeId } from "../../types.ts";
import { defaultModel, modelSupported, thinkingLevelsFor, fastModeModelIds } from "../../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalog, selectableModelCatalog } from "../../model/model-catalog.ts";
import { errMessage } from "../../util/errors.ts";
import { InstructionsUpdateDeniedError } from "../app-types.ts";
import { InstructionsTooLargeError } from "../../resolution/config-store.ts";
import { resolveBranding } from "../../resolution/branding.ts";
import { audit, isObj } from "./shared.ts";
import { type ApiCtx, isConfigured, ok, reply, type RouteResult } from "./route.ts";
import { livePersonCapability } from "../artifact-share.ts";
import { tenant } from "../../tenant.ts";
import { bodyField, badRequest } from "./surface-shared.ts";

export async function getSurfaceConfig(ctx: ApiCtx): Promise<RouteResult> {
  await ctx.deps.refreshModels?.();
  const { deps } = ctx;
  if (!deps.config) return reply(404, { error: "not_found" });
  const [webuiModels, baseModel, externalSlackParticipants, branding] = await Promise.all([
    deps.config.settingDurable("webuiModels", tenant().orgScope),
    deps.config.getRuntimeSelectionDurable(tenant().orgScope).then((selection) => selection?.modelId ?? null),
    deps.config.settingDurable("externalSlackParticipants", tenant().orgScope),
    resolveBranding(deps.config, tenant().orgScope, deps.brandingDefault),
  ]);
  const managedKeys = deps.modelCredentials ? await deps.modelCredentials.availability() : null;
  const providerStatus = managedKeys ?? deps.providerKeys;
  const catalog = managedKeys?.openrouter
    ? await selectableModelCatalog(deps.modelCredentialFetch)
    : builtInModelCatalog();
  const allowed = selectableCatalog(catalog).map((model) => model.id);
  const configuredPicker = webuiModels?.filter((id) => modelSupported(id)) ?? [];
  const resolvedBase = modelSupported(baseModel ?? undefined) ? baseModel! : defaultModel(deps.baseModelDefault);
  const resolvedBranding = Object.fromEntries(
    (["orgName", "accent", "mark", "markUrl", "selfLabel"] as const).flatMap((key) =>
      branding[key] ? [[key, branding[key]]] : [],
    ),
  );
  return ok({
    webuiModels: webuiModels != null ? configuredPicker : allowed,
    baseModel: resolvedBase,
    ...(providerStatus && {
      modelProviderConfigured: Boolean(
        providerStatus.anthropic ||
        providerStatus.openai ||
        providerStatus.openrouter ||
        providerStatus.modelIds?.size ||
        deps.companySubscriptionAuth,
      ),
    }),
    externalSlackParticipants,
    ...(Object.keys(resolvedBranding).length ? { branding: resolvedBranding } : {}),
  });
}

async function runtimeTarget(ctx: ApiCtx): Promise<{ actorId: string; scope: ScopeId } | null> {
  const requested = (name: string) => {
    const value = bodyField(ctx, name);
    return typeof value === "string" ? value : ctx.url.searchParams.get(name);
  };
  const actorId = ctx.capability?.actorId ?? requested("principalId");
  const scope = (ctx.capability?.scopeId ?? requested("scopeId")) as ScopeId | null;
  if (!actorId || !scope) return null;
  const parsed = parseScopeId(scope);
  const allowed =
    (parsed.kind === "personal" && parsed.ref === actorId) ||
    (parsed.kind !== "org" && (Boolean(ctx.capability) || (await ctx.app.belongsToScope(actorId, scope))));
  return allowed ? { actorId, scope } : null;
}

export async function getRuntimeConfig(ctx: ApiCtx): Promise<RouteResult> {
  const account = ctx.url.searchParams.get("account");
  if (account !== null && account !== "company") return reply(400, { error: "invalid_account" });
  if (!isConfigured(ctx)) return reply(404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return reply(403, { error: "forbidden" });
  await ctx.deps.refreshModels?.();
  return ok(
    account === "company"
      ? await runtimeConfigBody(ctx, target.scope)
      : await userRuntimeConfigBody(ctx, target.scope, target.actorId),
  );
}

export async function putRuntimeConfig(ctx: ApiCtx): Promise<RouteResult> {
  if (!isConfigured(ctx) || !isObj(ctx.body)) return reply(400, { error: "bad_request" });
  const target = await runtimeTarget(ctx);
  if (!target) return reply(403, { error: "forbidden" });
  await ctx.deps.refreshModels?.();
  const config = ctx.deps.config;
  if (ctx.body.inherit === true) await config.setRuntimeSelection(target.scope, null);
  else if (ctx.body.keep === true) {
    if (await config.getRuntimeSelectionDurable(target.scope)) await config.acknowledgeRuntimeSelection(target.scope);
  } else {
    const modelId = ctx.body.modelId;
    if (typeof modelId !== "string" || !modelSupported(modelId)) return reply(400, { error: "model_not_supported" });
    if (!(await webuiModelEnabled(ctx, modelId))) return reply(400, { error: "model_not_enabled" });
    const effortLevel = ctx.body.effortLevel ?? "auto";
    if (typeof effortLevel !== "string" || !thinkingLevelsFor(modelId).includes(effortLevel))
      return reply(400, { error: "effort_not_supported" });
    const fastMode = ctx.body.fastMode ?? false;
    if (typeof fastMode !== "boolean") return reply(400, { error: "fast_mode_invalid" });
    const choice = { modelId, effortLevel, fastMode: fastMode && fastModeModelIds().includes(modelId) };
    if ((await config.getModelAccountDurable(target.actorId)) !== "company") {
      const available = await userRuntimeConfigBody(ctx, target.scope, target.actorId);
      if (!available.models.includes(modelId)) return reply(400, { error: "account_runtime_unavailable" });
    }
    await config.setRuntimeSelection(target.scope, choice);
  }
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "runtime-config.update",
    resource: "runtime-config",
    scopeLabel: target.scope,
  });
  return ok(await userRuntimeConfigBody(ctx, target.scope, target.actorId));
}

export async function getChannelHeaderPin(ctx: ApiCtx): Promise<RouteResult> {
  if (!ctx.deps.config) return reply(404, { error: "not_found" });
  const target = await runtimeTarget(ctx);
  if (!target) return reply(403, { error: "forbidden" });
  const [on, configured, def] = await Promise.all([
    ctx.deps.config.settingDurable("channelHeaderPin", target.scope),
    ctx.deps.config.settingOwnDurable("channelHeaderPin", target.scope),
    ctx.deps.config.settingDurable("channelHeaderPin"),
  ]);
  return ok({ scopeId: target.scope, on, configured, default: def });
}

export async function putChannelHeaderPin(ctx: ApiCtx): Promise<RouteResult> {
  if (!isConfigured(ctx) || !isObj(ctx.body)) return reply(400, { error: "bad_request" });
  if (ctx.capability && !livePersonCapability(ctx.capability)) return reply(403, { error: "live_actor_required" });
  const target = await runtimeTarget(ctx);
  if (!target) return reply(403, { error: "forbidden" });
  if (typeof ctx.body.on !== "boolean" && ctx.body.on !== null)
    return reply(400, {
      error: "bad_request",
      message: "expected { on: boolean | null } (null reverts to the org default)",
    });
  await ctx.deps.config.setSetting("channelHeaderPin", ctx.body.on, target.scope);
  audit(ctx.deps, {
    principalId: target.actorId,
    action: "channel-header-pin.update",
    resource: "channel-header-pin",
    scopeLabel: target.scope,
  });
  return ok({
    scopeId: target.scope,
    on: ctx.body.on ?? (await ctx.deps.config.settingDurable("channelHeaderPin")),
    configured: ctx.body.on,
  });
}

export function getInstructions(ctx: ApiCtx): RouteResult {
  const { app, url, capability } = ctx;
  const scopeIdVal = capability?.scopeId ?? url.searchParams.get("scopeId");
  if (!scopeIdVal) return reply(400, { error: "bad_request", message: "scopeId required" });
  return ok(app.getInstructions(scopeIdVal));
}

export async function postInstructions(ctx: ApiCtx): Promise<RouteResult> {
  const { app, body, capability } = ctx;
  const b = body as { scopeId?: unknown; content?: unknown; actorId?: unknown };
  const scopeIdVal = capability ? capability.scopeId : b.scopeId;
  const actorId = capability ? capability.actorId : b.actorId;
  const content = b.content;
  if (typeof content !== "string" || typeof scopeIdVal !== "string" || typeof actorId !== "string")
    throw badRequest(capability ? "content (string) required" : "scopeId, content, actorId required");
  const allowSharedScope =
    Boolean(capability) ||
    (parseScopeId(scopeIdVal).kind !== "personal" && (await app.managesScope(actorId, scopeIdVal as ScopeId)));
  try {
    const version = await app.updateInstructions(
      scopeIdVal,
      content,
      actorId,
      allowSharedScope ? { allowSharedScope: true } : undefined,
    );
    return ok({ ok: true, version });
  } catch (e) {
    if (e instanceof InstructionsUpdateDeniedError)
      return reply(403, { error: "instructions_update_denied", message: e.message });
    if (e instanceof InstructionsTooLargeError) return reply(413, { error: "payload_too_large", message: e.message });
    return reply(500, { error: "instructions_update_failed", message: errMessage(e) });
  }
}
