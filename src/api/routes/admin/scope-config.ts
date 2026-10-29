import { parseScopeId } from "../../../types.ts";
import { encodeRef, serviceCredRef } from "../../../acl/resource-ref.ts";
import { computeRetention } from "../../../admin/retention.ts";
import {
  FAST_MODE_MODEL_IDS,
  modelCatalogFor,
  embeddingModelCatalog,
  defaultModel,
  modelServiceable,
  resolveModel,
} from "../../../model/pi-models.ts";
import {
  builtInModelCatalog,
  cachedModelCatalog,
  selectableCatalog,
  selectableModelCatalog,
  type ModelCatalogEntry,
} from "../../../model/model-catalog.ts";
import { activePrincipal, adminActorFrom, authorizeAdmin } from "../shared.ts";
import {
  ADMIN_RESOURCES,
  ADMIN_RESOURCE_BY_ID,
  adminResourceManifest,
  defaultAutoFlaggerConfig,
} from "../admin-resources.ts";
import { type ApiCtx, isConfigured, ok, reply, type RouteResult } from "../route.ts";
import type { ConfiguredDeps } from "../../deps.ts";
import {
  composePolicy,
  defaultOrgPolicy,
  evaluateCommand,
  parseCommandPolicy,
} from "../../../policy/command-policy.ts";
import { isHostDenied } from "../../../resolution/egress-policy.ts";
import { adminAt, auditAs, badRequest, discoverScopes, modelKeys, orgAdmin } from "./common.ts";
import { scopeActivity } from "./scope-activity.ts";
import { tenant } from "../../../tenant.ts";

export async function putScopeConfig(ctx: ApiCtx): Promise<RouteResult> {
  if (!isConfigured(ctx)) return reply(404, { error: "not_found" });
  const { deps, params, body } = ctx;
  const targetScope = params.scope!;
  const resource = params.resource!;
  const authz = await adminAt(ctx, targetScope);
  const withScopeMutationLock = async <T>(fn: () => Promise<T>): Promise<T> =>
    deps.advisoryLock ? deps.advisoryLock.withLock(`admin-governance:${targetScope}`, fn) : fn();

  if (resource === "command-policy-simulate") {
    const command = (body as { command?: unknown }).command;
    if (typeof command !== "string" || !command.trim()) throw badRequest("command is required");
    const supplied = (body as { policy?: unknown }).policy;
    const parsed = supplied === undefined ? null : parseCommandPolicy(supplied);
    if (parsed && "error" in parsed) throw badRequest(parsed.error);
    const targetKind = parseScopeId(targetScope).kind;
    const target =
      parsed?.policy ??
      deps.config.setting("commandPolicy", targetScope) ??
      (targetKind === "org" ? defaultOrgPolicy() : { mode: "denylist" as const, rules: [] });
    const orgPolicy = deps.config.setting("commandPolicy", tenant().orgScope) ?? defaultOrgPolicy();
    const effective = targetKind === "org" ? target : composePolicy(orgPolicy, target);
    const result = evaluateCommand(command, effective);
    const effectiveRuleIndex = result.approvalKey
      ? effective.rules.findIndex((rule) => rule.pattern === result.approvalKey)
      : -1;
    const orgRuleCount = targetKind === "org" ? 0 : orgPolicy.rules.length;
    let ruleSource: "organization" | "scope" | null = null;
    if (effectiveRuleIndex >= 0) ruleSource = effectiveRuleIndex < orgRuleCount ? "organization" : "scope";
    const ruleIndex = effectiveRuleIndex < 0 ? null : effectiveRuleIndex - (ruleSource === "scope" ? orgRuleCount : 0);
    authz.audit("command-policy.simulate", "command-policy");
    return ok({
      ok: true,
      decision: result.decision,
      reason: result.reason ?? null,
      matched: result.matched ?? null,
      ruleSource,
      ruleIndex,
      deploymentRulesEvaluated: false,
    });
  }

  const desc = ADMIN_RESOURCE_BY_ID.get(resource);
  if (!desc) return reply(404, { error: "not_found", message: `unknown admin resource: ${resource}` });
  if (desc.refreshesModels) await deps.refreshModels?.();
  return withScopeMutationLock(async () => {
    try {
      const result = await desc.apply(ctx, authz.actor, targetScope);
      if ("error" in result)
        return reply(result.status ?? 400, { error: result.code ?? "bad_request", message: result.error });
    } catch (err) {
      await deps.config.refreshScope(targetScope);
      throw err;
    }
    authz.audit(`${resource}.update`, resource);
    return ok({ ok: true, scopeId: targetScope, resource });
  });
}

export async function getAdminResources(ctx: ApiCtx): Promise<RouteResult> {
  const authz = await orgAdmin(ctx);
  await ctx.deps.refreshModels?.();
  authz.audit("resources.read", "resources");
  return ok({ resources: adminResourceManifest() });
}

export async function whoami(ctx: ApiCtx): Promise<RouteResult> {
  const { deps } = ctx;
  if (!deps.admin) return reply(404, { error: "not_found" });
  const actor = adminActorFrom(ctx);
  if (!actor || !(await activePrincipal(deps, actor.id))) return ok({ isAdmin: false, permissions: [] });
  const status = await deps.admin.adminStatusOf(actor);
  const permissions = status.isAdmin ? ["admin"] : [];
  auditAs(deps, actor.id, "admin.whoami", "whoami", status.scopeId ?? actor.id);
  return ok({ ...status, permissions });
}

export async function listAdminScopes(ctx: ApiCtx): Promise<RouteResult> {
  const { app, deps } = ctx;
  const authz = await orgAdmin(ctx, "scopes");
  const [crons, deployments, skills, environmentRows] = await Promise.all([
    app.listCrons(),
    app.listDeployments(),
    app.listSkills(),
    app.listEnvironments(),
  ]);
  const environments = environmentRows.map(({ environment, attachments }) => ({
    id: environment.id,
    name: environment.name,
    ownerActorId: environment.ownerActorId,
    attachedScopes: attachments.map((attachment) => attachment.scopeId).sort(),
  }));
  const environmentById = new Map(environments.map((environment) => [environment.id, environment]));
  const attachmentByScope = new Map(
    environments.flatMap((environment) =>
      environment.attachedScopes.map((attachedScope) => [attachedScope, environment] as const),
    ),
  );
  const cronOwners = crons.map((c) => c.ownerScopeId);
  const deploymentOwners = deployments.map((d) => d.ownerScopeId);
  const skillOwners = skills.map((s) => s.scopeId);
  const labels = await discoverScopes(app, deps, [
    ...cronOwners,
    ...deploymentOwners,
    ...skillOwners,
    ...environments.map((environment) => environment.id),
    ...environments.flatMap((environment) => environment.attachedScopes),
  ]);
  const activity = scopeActivity(deps.sessions);
  const tally = (ids: string[]) => ids.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map<string, number>());
  const [cronN, deployN, skillN] = [tally(cronOwners), tally(deploymentOwners), tally(skillOwners)];
  const scopes = [...labels].map(([id, label]) => {
    const counts = activity?.byScope.get(id);
    const ownEnvironment = environmentById.get(id);
    const attached = attachmentByScope.get(id);
    return {
      scopeId: id,
      ...(label ? { label } : {}),
      ...(ownEnvironment?.name ? { environmentName: ownEnvironment.name } : {}),
      ...(attached ? { environmentAttachment: { environmentId: attached.id, environmentName: attached.name } } : {}),
      ...(activity
        ? {
            sessions: counts?.conversations ?? 0,
            backgroundSessions: (counts?.crons ?? 0) + (counts?.background ?? 0),
            lastActivity: counts?.lastActivity ?? 0,
          }
        : {}),
      crons: cronN.get(id) ?? 0,
      deployments: deployN.get(id) ?? 0,
      skills: skillN.get(id) ?? 0,
    };
  });
  scopes.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.scopeId.localeCompare(b.scopeId));
  return ok({
    scopeId: authz.scope,
    scopes,
    environments,
    ...(activity ? { activityAsOf: activity.asOf } : {}),
  });
}

interface ScopeEnvironmentMetadata {
  environment?: { id: string; name: string; ownerActorId: string | null };
  environmentAttachment?: { environmentId: string; environmentName: string | null };
}

async function scopeEnvironmentMetadata(deps: ApiCtx["deps"], targetScope: string): Promise<ScopeEnvironmentMetadata> {
  const store = deps.environments;
  if (!store) return {};
  const [environment, attachment] = await Promise.all([store.get(targetScope), store.getAttachment(targetScope)]);
  const metadata: ScopeEnvironmentMetadata = {};
  if (environment?.name) {
    const { id, name, ownerActorId } = environment;
    metadata.environment = { id, name, ownerActorId };
  }
  if (attachment) {
    const environmentName = (await store.get(attachment.environmentId))?.name ?? null;
    metadata.environmentAttachment = { environmentId: attachment.environmentId, environmentName };
  }
  return metadata;
}

const SETTINGS_RESOURCES = {
  governance: [
    "baseModel",
    "runtime",
    "autoFlagger",
    "approvalGrantModes",
    "commandPolicy",
    "ambientPolicy",
    "egress",
    "orgAmbient",
  ],
  customize: ["instructions", "branding", "featureFlags", "decisions"],
  "slack-settings": ["externalSlackParticipants", "channelHeaderPinDefault", "ackEmoji"],
  models: [
    "baseModel",
    "runtime",
    "cronRuntime",
    "subagentRuntime",
    "webuiModels",
    "interactiveFastMode",
    "individualModelAuth",
    "memoryEmbeddingModel",
    "browseMaxSteps",
  ],
  credentials: [],
  connectors: ["connectors"],
  onboarding: ["baseModel", "runtime"],
} satisfies Record<string, string[]>;

type SettingsView = keyof typeof SETTINGS_RESOURCES;

async function scopeServiceCredentials(deps: ApiCtx["deps"], targetScope: string) {
  const [credentials, grants] = await Promise.all([
    deps.serviceCreds?.listServiceCredentials(targetScope) ?? [],
    deps.acl?.list() ?? [],
  ]);
  const grantees = new Map<string, string[]>();
  for (const grant of grants) {
    if (grant.ownerScopeId !== targetScope) continue;
    const scopes = grantees.get(grant.ref) ?? [];
    scopes.push(grant.granteeScopeId);
    grantees.set(grant.ref, scopes);
  }
  return credentials.map((credential) => ({
    ...credential,
    grantees: grantees.get(encodeRef(serviceCredRef(credential.slug))) ?? [],
  }));
}

export async function getCredentialUsageSummary(ctx: ApiCtx): Promise<RouteResult> {
  const targetScope = ctx.params.scope!;
  if (!targetScope || targetScope.includes("/")) return reply(404, { error: "not_found" });
  await authorizeAdmin(ctx, targetScope);
  const credentials = (await ctx.deps.serviceCreds?.listServiceCredentials(targetScope)) ?? [];
  if (!ctx.deps.credentialUsage) return reply(503, { error: "usage_unavailable" });
  const summaries = await ctx.deps.credentialUsage.summary(credentials.map((credential) => credential.slug));
  return ok({ summaries });
}

async function scopeEgress(deps: ConfiguredDeps, targetScope: string) {
  const scopeProfile = (await deps.sandbox?.profileFor?.(targetScope)) ?? deps.sandbox?.profile;
  const declaredEgress =
    scopeProfile?.egressEnforcement ?? deps.egressDeclaredEnforcement ?? deps.egressEnforcement ?? "none";
  const controlPlaneConfigured = deps.egressControlPlaneConfigured ?? deps.egressEnforcement === declaredEgress;
  const effectiveEgressFidelity = controlPlaneConfigured ? declaredEgress : "none";
  let egressReason = "ready";
  if (declaredEgress !== "domain") egressReason = "backend_unsupported";
  else if (effectiveEgressFidelity !== "domain") egressReason = "control_plane_unconfigured";
  const orgEgress = deps.config.setting("egress", tenant().orgScope);
  const targetEgress = deps.config.setting("egress", targetScope);
  const effectiveEgressPolicy = {
    deniedHosts: [...new Set([...(orgEgress?.deniedHosts ?? []), ...(targetEgress?.deniedHosts ?? [])])],
    allowedHosts: [] as string[],
  };
  effectiveEgressPolicy.allowedHosts = [
    ...new Set([...(orgEgress?.allowedHosts ?? []), ...(targetEgress?.allowedHosts ?? [])]),
  ].filter((host) => !isHostDenied(host, effectiveEgressPolicy.deniedHosts));
  return {
    egressEnforcement: {
      backend: scopeProfile?.backend ?? deps.sandboxBackend ?? "unknown",
      declaredFidelity: declaredEgress,
      effectiveFidelity: effectiveEgressFidelity,
      fidelity: effectiveEgressFidelity,
      active: effectiveEgressFidelity === "domain",
      reason: egressReason,
    },
    egressEffective: effectiveEgressPolicy,
  };
}

async function scopeModelOptions(deps: ApiCtx["deps"], values: Record<string, unknown>, nonblocking: boolean) {
  const managedKeys = await modelKeys(deps);
  const cached =
    deps.modelCredentials && managedKeys.openrouter && nonblocking
      ? cachedModelCatalog(deps.modelCredentialFetch)
      : undefined;
  const catalog =
    cached?.models ??
    (deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(deps.modelCredentialFetch)
      : builtInModelCatalog());
  const runtime = values.runtime as { modelId?: unknown } | null | undefined;
  let currentId = defaultModel(deps.baseModelDefault);
  if (typeof values.baseModel === "string") currentId = values.baseModel;
  if (typeof runtime?.modelId === "string") currentId = runtime.modelId;
  const resolvedCurrent = resolveModel(currentId);
  const preserveCurrent = typeof runtime?.modelId === "string" || (nonblocking && !resolvedCurrent);
  const currentModel: ModelCatalogEntry = {
    id: currentId,
    name: resolvedCurrent?.name ?? currentId + " (configured)",
    provider: resolvedCurrent?.provider ?? "",
  };
  const purposeRuntimes = [values.cronRuntime, values.subagentRuntime].filter(
    (value): value is { modelId: string } => !!value && typeof (value as { modelId?: unknown }).modelId === "string",
  );
  const models = selectableCatalog(catalog);
  if (preserveCurrent && !models.some((model) => model.id === currentModel.id)) models.push(currentModel);
  for (const runtime of purposeRuntimes) {
    if (!models.some((model) => model.id === runtime.modelId))
      models.push({
        id: runtime.modelId,
        name: resolveModel(runtime.modelId)?.name ?? `${runtime.modelId} (configured)`,
        provider: resolveModel(runtime.modelId)?.provider ?? "",
      });
  }
  const baseModelOptions = models.filter(
    (model) =>
      modelServiceable(model.id, managedKeys) ||
      (preserveCurrent && currentModel.id === model.id) ||
      purposeRuntimes.some((runtime) => runtime.modelId === model.id),
  );
  return {
    ...(cached?.refreshing ? { modelCatalogRefreshing: true } : {}),
    baseModelDefault: defaultModel(deps.baseModelDefault),
    baseModelOptions,
    modelCatalog: modelCatalogFor(baseModelOptions.map((model) => model.id)),
    fastModeModelIds: FAST_MODE_MODEL_IDS,
    autoFlaggerDefault: defaultAutoFlaggerConfig(deps),
    memoryEmbeddingOptions: embeddingModelCatalog(),
  };
}

export async function getScopeConfig(ctx: ApiCtx): Promise<RouteResult> {
  if (!isConfigured(ctx)) return reply(404, { error: "not_found" });
  const { res, deps, params, url } = ctx;
  const targetScope = params.scope!;
  if (!targetScope || targetScope.includes("/")) return reply(404, { error: "not_found" });
  const requestedView = url.searchParams.get("view");
  if (requestedView !== null && !Object.hasOwn(SETTINGS_RESOURCES, requestedView))
    return reply(400, { error: "bad_request", message: "Unknown settings view" });
  const started = performance.now();
  const timings: Record<string, number> = {};
  const read = async <T>(name: string, load: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await load();
    } finally {
      timings[name] = performance.now() - start;
    }
  };
  const actor = await read("authorize", () => authorizeAdmin(ctx, targetScope));
  const view = requestedView as SettingsView | null;
  const includes = (...views: SettingsView[]) => view === null || views.includes(view);
  const needsModels = includes("models", "governance", "onboarding");
  const needsConfig = view !== "credentials" && view !== "connectors";
  await Promise.all([
    needsConfig ? read("config", () => deps.config.refreshScope(targetScope)) : undefined,
    needsModels ? read("models", () => deps.refreshModels?.()) : undefined,
  ]);
  auditAs(deps, actor.id, "config.read", "config", targetScope);
  const selectedKeys: readonly string[] | undefined = view === null ? undefined : SETTINGS_RESOURCES[view];
  const resources = ADMIN_RESOURCES.filter(
    (r) => r.readKey && r.get && (!selectedKeys || selectedKeys.includes(r.readKey)),
  );
  const [entries, environmentMetadata, serviceCredentials, directoryMembers, directoryChannels, egress] =
    await Promise.all([
      Promise.all(
        resources.map(async (r) => [r.readKey!, await read(r.readKey!, () => r.get!(deps, targetScope))] as const),
      ),
      view === "connectors" ? {} : read("environment", () => scopeEnvironmentMetadata(deps, targetScope)),
      includes("credentials") ? read("credentials", () => scopeServiceCredentials(deps, targetScope)) : undefined,
      includes("credentials") && parseScopeId(targetScope).kind === "org"
        ? read("people", () => deps.directory?.list())
        : undefined,
      includes("credentials") && parseScopeId(targetScope).kind === "org"
        ? read("channels", () => deps.directory?.listChannels?.())
        : undefined,
      includes("governance") ? scopeEgress(deps, targetScope) : undefined,
    ]);
  const values = Object.fromEntries(entries);
  const modelOptions = needsModels
    ? await read("modelOptions", () =>
        scopeModelOptions(deps, values, view !== null && url.searchParams.get("catalog") !== "refresh"),
      )
    : undefined;
  res.setHeader(
    "server-timing",
    Object.entries(timings)
      .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`)
      .join(", "),
  );
  const elapsed = performance.now() - started;
  if (view && url.searchParams.get("catalog") !== "refresh" && elapsed > 500)
    console.warn(
      "[admin-settings] load budget exceeded",
      JSON.stringify({ view, durationMs: Math.round(elapsed), timings }),
    );
  return ok({
    scopeId: targetScope,
    ...environmentMetadata,
    ...values,
    ...(includes("customize")
      ? {
          instructionsVersion: deps.config.instructionsVersion(targetScope),
          instructionsHistory: deps.config.instructionsHistory(targetScope),
        }
      : {}),
    ...(includes("credentials")
      ? { serviceCredentials, directoryMembers: directoryMembers ?? [], directoryChannels: directoryChannels ?? [] }
      : {}),
    ...(includes("governance") ? egress : {}),
    ...modelOptions,
  });
}

export async function retention(ctx: ApiCtx): Promise<RouteResult> {
  const { deps, url } = ctx;
  const scope = url.searchParams.get("scope") ?? tenant().orgScope;
  if (parseScopeId(scope).kind !== "org") throw badRequest("retention is org-wide; request an org scope");
  await adminAt(ctx, scope, "retention");
  const sessionCount = (await deps.sessions?.countSessions()) ?? 0;
  const participants = (await deps.sessions?.listParticipants()) ?? [];
  const turns = (await deps.sessions?.attributedTurns()) ?? [];
  const report = computeRetention({ sessionCount, participants, turns, nowMs: Date.now() });
  return ok({ scopeId: scope, ...report });
}
