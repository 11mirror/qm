import { parseScopeId, type Grant } from "../../types.ts";
import {
  credentialInjectionError,
  isValidCredentialSlug,
  isValidServiceCredentialEnvKey,
  isValidBrokerHost,
  isValidBrokerMethod,
  isValidBrokerPathPrefix,
  type CredentialInjection,
  type DecryptedServiceCredential,
  type PublicServiceCredential,
  type ServiceCredentialInput,
} from "../../credentials/keychain.ts";
import { encodeRef, serviceCredRef } from "../../acl/resource-ref.ts";
import { reportFailure } from "../../util/errors.ts";
import type { ConfiguredDeps } from "../deps.ts";
import type { ConfiguredCtx } from "./route.ts";
import type { Actor, ApplyResult } from "./admin-resources.ts";
import { auditAs, orgOnly } from "./admin/common.ts";

const trimmedList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : undefined;

type ServiceCredentialBody = {
  slug?: unknown;
  name?: unknown;
  secret?: unknown;
  delivery?: unknown;
  envKey?: unknown;
  host?: unknown;
  injection?: unknown;
  allowedMethods?: unknown;
  allowedPathPrefixes?: unknown;
  deployments?: unknown;
  enabled?: unknown;
  grantees?: unknown;
  delete?: unknown;
  expectedUpdatedAt?: unknown;
};

function serviceCredentialMutation(
  deps: ConfiguredDeps,
  actor: Actor,
  scope: string,
  slug: string,
  ref: string,
  existing: PublicServiceCredential | undefined,
  grantsBefore: Grant[],
  secretBefore: DecryptedServiceCredential | null,
) {
  const state: { mutationVersion: number | null; deletedCredential: boolean } = {
    mutationVersion: null,
    deletedCredential: false,
  };
  const desiredGrants = (desired: string[]): Grant[] => {
    const desiredSet = new Set(desired);
    const replacement = grantsBefore.filter((grant) => desiredSet.has(grant.granteeScopeId));
    const currentSet = new Set(replacement.map((grant) => grant.granteeScopeId));
    for (const granteeScopeId of desired) {
      if (!currentSet.has(granteeScopeId))
        replacement.push({ ownerScopeId: scope, ref, granteeScopeId, permission: "read", grantedBy: actor.id });
    }
    return replacement;
  };
  const grantChanges = (replacement: readonly Grant[]): Array<{ action: "share" | "unshare"; grantee: string }> => {
    const changes: Array<{ action: "share" | "unshare"; grantee: string }> = [];
    const before = new Set(grantsBefore.map((grant) => grant.granteeScopeId));
    const after = new Set(replacement.map((grant) => grant.granteeScopeId));
    for (const grantee of before) if (!after.has(grantee)) changes.push({ action: "unshare", grantee });
    for (const grantee of after) if (!before.has(grantee)) changes.push({ action: "share", grantee });
    return changes;
  };
  const restoreInput = (
    credential: PublicServiceCredential,
    secret: DecryptedServiceCredential | null,
  ): ServiceCredentialInput => ({
    slug: credential.slug,
    name: credential.name,
    delivery: credential.delivery,
    ...(credential.envKey ? { envKey: credential.envKey } : {}),
    host: credential.host,
    ...(secret?.secret ? { secret: secret.secret } : {}),
    ...(credential.injection ? { injection: credential.injection } : {}),
    ...(credential.allowedMethods ? { allowedMethods: credential.allowedMethods } : {}),
    ...(credential.allowedPathPrefixes ? { allowedPathPrefixes: credential.allowedPathPrefixes } : {}),
    deployments: credential.deployments,
    enabled: credential.enabled,
    ...(credential.updatedBy ? { updatedBy: credential.updatedBy } : {}),
  });
  const publicShape = (credential: PublicServiceCredential | undefined) =>
    credential &&
    JSON.stringify({
      slug: credential.slug,
      name: credential.name,
      delivery: credential.delivery,
      envKey: credential.envKey ?? null,
      host: credential.host,
      injection: credential.injection ?? null,
      allowedMethods: credential.allowedMethods ?? null,
      allowedPathPrefixes: credential.allowedPathPrefixes ?? null,
      deployments: credential.deployments,
      enabled: credential.enabled,
      hasSecret: credential.hasSecret,
      updatedBy: credential.updatedBy ?? null,
    });
  const grantShape = (grants: readonly Grant[]) =>
    JSON.stringify(
      grants
        .map((grant) => ({
          ownerScopeId: grant.ownerScopeId,
          ref: grant.ref,
          granteeScopeId: grant.granteeScopeId,
          permission: grant.permission,
          grantedBy: grant.grantedBy,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  let grantsWritten = grantsBefore;
  const rollback = async (): Promise<boolean> => {
    try {
      let credentialRestored: boolean;
      if (!existing) {
        credentialRestored =
          state.mutationVersion !== null &&
          (await deps.serviceCreds!.deleteServiceCredentialIfCurrent(scope, slug, state.mutationVersion));
      } else if (state.deletedCredential) {
        credentialRestored =
          (await deps.serviceCreds!.setServiceCredentialIfAbsent(scope, restoreInput(existing, secretBefore))) !== null;
      } else {
        credentialRestored =
          state.mutationVersion !== null &&
          (await deps.serviceCreds!.setServiceCredentialIfCurrent(
            scope,
            restoreInput(existing, secretBefore),
            state.mutationVersion,
          )) !== null;
      }
      if (!credentialRestored) return false;
      const grantsRestored =
        (await deps.acl!.replaceGrantsIfCurrent(scope, ref, grantsWritten, grantsBefore, actor.id)) ||
        grantShape(await deps.acl!.grantsFor(scope, ref)) === grantShape(grantsBefore);
      if (!grantsRestored) return false;
      const restored = (await deps.serviceCreds!.listServiceCredentials(scope)).find(
        (credential) => credential.slug === slug,
      );
      const restoredSecret = restored ? await deps.serviceCreds!.getServiceCredentialSecret(scope, slug) : null;
      const restoredGrants = await deps.acl!.grantsFor(scope, ref);
      return (
        publicShape(restored) === publicShape(existing) &&
        (restoredSecret?.secret ?? null) === (secretBefore?.secret ?? null) &&
        grantShape(restoredGrants) === grantShape(grantsBefore)
      );
    } catch {
      return false;
    }
  };
  const mutationFailed = async (operation: string): Promise<ApplyResult> => {
    const rolledBack = await rollback();
    return {
      error: rolledBack
        ? `Credential ${operation} failed; the previous credential and grants were restored.`
        : `Credential ${operation} failed and rollback could not be verified. Review this credential before retrying.`,
      code: rolledBack ? "credential_mutation_rolled_back" : "credential_mutation_inconsistent",
      status: 500,
    };
  };
  const auditGrantChanges = (changes: Array<{ action: "share" | "unshare"; grantee: string }>) => {
    for (const change of changes) auditAs(deps, actor.id, `service_credential.${change.action}`, ref, change.grantee);
  };
  const writeGrants = async (replacement: Grant[], operation: string): Promise<ApplyResult> => {
    grantsWritten = replacement;
    try {
      if (!(await deps.acl!.replaceGrantsIfCurrent(scope, ref, grantsBefore, replacement, actor.id)))
        return mutationFailed(operation);
      auditGrantChanges(grantChanges(replacement));
      return { ok: true };
    } catch (e) {
      reportFailure(`admin: credential ${operation === "delete" ? "delete" : "update"} after conditional mutation`, e);
      return mutationFailed(operation);
    }
  };
  return { state, desiredGrants, writeGrants };
}

function parseServiceCredentialInput(
  b: ServiceCredentialBody,
  existing: PublicServiceCredential | undefined,
  allCreds: PublicServiceCredential[],
  slug: string,
  scope: string,
  actor: Actor,
) {
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : "";
  const deliveryRaw = b.delivery === undefined ? (existing?.delivery ?? "broker") : b.delivery;
  if (deliveryRaw !== "broker" && deliveryRaw !== "env") return { error: 'delivery must be "broker" or "env"' };
  const delivery: "broker" | "env" = deliveryRaw;
  const envKey = typeof b.envKey === "string" && b.envKey.trim() ? b.envKey.trim() : undefined;
  if (delivery === "env") {
    if (!envKey || !isValidServiceCredentialEnvKey(envKey)) {
      return {
        error: "env delivery requires an UPPER_SNAKE_CASE env var name outside the reserved AGENT_* namespace",
      };
    }
    const clash = allCreds.find((c) => c.slug !== slug && c.delivery === "env" && c.envKey === envKey);
    if (clash) return { error: `env var ${envKey} is already delivered by credential "${clash.slug}"` };
  } else if (envKey) {
    return { error: "an env var name only applies to env delivery" };
  }
  const host = typeof b.host === "string" ? b.host.trim().toLowerCase() : "";
  if (!name) return { error: "service-credentials requires { slug, name }" };
  if (delivery === "broker" && !isValidBrokerHost(host))
    return { error: "broker delivery requires { host } (a bare hostname)" };
  if (delivery === "env" && host) return { error: "a pinned host only applies to broker delivery" };
  if (!existing && (typeof b.secret !== "string" || !b.secret)) return { error: "a new credential requires a secret" };
  const methods = trimmedList(b.allowedMethods)?.map((method) => method.toUpperCase());
  if (methods?.some((method) => !isValidBrokerMethod(method)))
    return { error: "allowed methods must be comma-separated HTTP method names" };
  const paths = trimmedList(b.allowedPathPrefixes);
  if (paths?.some((path) => !isValidBrokerPathPrefix(path)))
    return { error: "each allowed path prefix must be one line starting with /" };
  const desired = Array.isArray(b.grantees) ? [...new Set(b.grantees.map(String))] : undefined;
  const badGrantee = desired?.find((g) => {
    const parsed = parseScopeId(g);
    return (
      !["org", "personal", "team", "channel"].includes(parsed.kind ?? "") ||
      !parsed.ref ||
      parsed.ref.includes(":") ||
      (parsed.kind === "org" && g !== scope)
    );
  });
  if (badGrantee !== undefined)
    return { error: `grantee must be this org or a valid personal:/team:/channel: scope (got ${badGrantee})` };
  if (b.deployments !== undefined && typeof b.deployments !== "boolean")
    return { error: "deployments must be true or false" };
  const injectionError = credentialInjectionError(b.injection);
  if (injectionError) return { error: injectionError };
  const injection = b.injection as CredentialInjection | undefined;
  const effectiveInjection = b.injection === undefined ? existing?.injection : injection;
  const allowedMethods = methods ?? existing?.allowedMethods;
  const allowedPathPrefixes = paths ?? existing?.allowedPathPrefixes;
  const input = {
    slug,
    name,
    delivery,
    ...(delivery === "env" ? { envKey } : {}),
    host: delivery === "env" ? "" : host,
    ...(typeof b.secret === "string" && b.secret ? { secret: b.secret } : {}),
    ...(delivery === "broker" && effectiveInjection && Object.keys(effectiveInjection).length
      ? { injection: effectiveInjection }
      : {}),
    ...(delivery === "broker" && allowedMethods ? { allowedMethods } : {}),
    ...(delivery === "broker" && allowedPathPrefixes ? { allowedPathPrefixes } : {}),
    deployments: typeof b.deployments === "boolean" ? b.deployments : (existing?.deployments ?? true),
    enabled: typeof b.enabled === "boolean" ? b.enabled : (existing?.enabled ?? true),
    updatedBy: actor.id,
  };
  return { input, desired };
}

export async function applyServiceCredentials(ctx: ConfiguredCtx, actor: Actor, scope: string): Promise<ApplyResult> {
  const { deps } = ctx;
  if (!deps.acl) return { error: "ACL store not wired", code: "not_found", status: 404 };
  if (!deps.serviceCreds) return { error: "credential store not wired", code: "not_found", status: 404 };
  const bad = orgOnly(scope, "service credentials are org-scoped");
  if (bad) return bad;
  const b = ctx.body as ServiceCredentialBody;
  const slug = typeof b.slug === "string" ? b.slug : "";
  if (!isValidCredentialSlug(slug)) return { error: "slug must be lowercase kebab-case (a-z, 0-9, -)" };
  const ref = encodeRef(serviceCredRef(slug));
  const allCreds = await deps.serviceCreds.listServiceCredentials(scope);
  const existing = allCreds.find((c) => c.slug === slug);
  if (existing?.source === "deployment")
    return {
      error: `"${slug}" is supplied by this deployment's configuration and can't be edited, deleted or reused here.`,
      code: "deployment_credential",
      status: 409,
    };
  const conflict = () => ({
    error: "Credential changed after this editor was loaded. Reload it before continuing.",
    code: "version_conflict",
    status: 409,
  });
  if ((existing || b.delete === true) && typeof b.expectedUpdatedAt !== "number") {
    return {
      error: "Existing credential edits and deletes require the version you loaded.",
      code: "version_required",
    };
  }
  if (!existing && typeof b.expectedUpdatedAt === "number") return conflict();
  const grantsBefore = await deps.acl.grantsFor(scope, ref);
  const secretBefore = existing ? await deps.serviceCreds.getServiceCredentialSecret(scope, slug) : null;
  const { state, desiredGrants, writeGrants } = serviceCredentialMutation(
    deps,
    actor,
    scope,
    slug,
    ref,
    existing,
    grantsBefore,
    secretBefore,
  );
  if (b.delete === true) {
    if (
      !existing ||
      !(await deps.serviceCreds.deleteServiceCredentialIfCurrent(scope, slug, b.expectedUpdatedAt as number))
    )
      return conflict();
    state.deletedCredential = true;
    return writeGrants([], "delete");
  }
  const parsed = parseServiceCredentialInput(b, existing, allCreds, slug, scope, actor);
  if (parsed.error !== undefined) return parsed;
  const { input, desired } = parsed;
  state.mutationVersion = existing
    ? await deps.serviceCreds.setServiceCredentialIfCurrent(scope, input, b.expectedUpdatedAt as number)
    : await deps.serviceCreds.setServiceCredentialIfAbsent(scope, input);
  if (state.mutationVersion === null) return conflict();
  const keep = existing ? grantsBefore.map((grant) => grant.granteeScopeId) : [scope];
  return writeGrants(desiredGrants(desired ?? keep), existing ? "update" : "create");
}
