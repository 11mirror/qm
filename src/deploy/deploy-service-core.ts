import { EXTERNAL_APP_SHARING_OFF } from "../feature-flags.ts";
import type { Grant, Permission, ScopeId } from "../types.ts";
import { isManageableCreationScope, parseScopeId } from "../types.ts";
import { deployRef, encodeRef } from "../acl/resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import { currentVersionOf, type Deployment, type DeployEndpoint, type DeploymentVersion } from "./deploy-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import type { DeployServiceDeps } from "./deploy-service.ts";
import { DeployAccessError, endpointsEqual, renewDue, snapshotFiles } from "./deploy-service-support.ts";

export function createDeployCore(deps: DeployServiceDeps) {
  const advisoryLock = deps.advisoryLock;
  const deployQueue = createKeyedQueue();
  const externalSharingAllowed = (ownerScopeId: ScopeId): Promise<boolean> =>
    deps.externalSharingAllowed?.(ownerScopeId) ?? Promise.resolve(false);
  async function assertShareAllowed(ownerScopeId: ScopeId, grantee: ScopeId, permission: Permission | null) {
    const { kind, ref } = parseScopeId(grantee);
    if (permission === null || kind !== "personal" || !ref?.includes("@")) return;
    if ((await deps.canManageEmail?.(ref)) || (await externalSharingAllowed(ownerScopeId))) return;
    throw new DeployAccessError("external_sharing_disabled", EXTERNAL_APP_SHARING_OFF);
  }
  function withDeployLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return deployQueue(id, () => advisoryLock.withLock(`deploy:${id}`, fn));
  }

  const applyVersion = async (id: string, version: DeploymentVersion, alwaysOn?: boolean): Promise<DeployEndpoint> => {
    const stored = (await deps.deployStore.get(id))!;
    const d = alwaysOn === undefined ? stored : { ...stored, alwaysOn };
    const deploymentEnv = await deps.deploymentEnv?.(d);
    if (deploymentEnv && Object.keys(deploymentEnv).length)
      version = { ...version, env: { ...version.env, ...deploymentEnv } };
    let endpoint: DeployEndpoint;
    if (version.commit && deps.provider.profile.appliesGitBundle) {
      endpoint = await deps.provider.apply(
        d,
        version,
        (await deps.deployStore.bundleOf(id, version.version)) ?? undefined,
      );
    } else {
      let materialized = version;
      if (version.commit) {
        const files = await deps.deployStore.filesOf(id, version.version);
        if (files == null) throw new Error(`cannot materialize deployment ${id} version ${version.version}`);
        materialized = { ...version, snapshotDir: await snapshotFiles(deps.deployDir, files) };
      }
      endpoint = await deps.provider.apply(d, materialized);
    }
    if (alwaysOn !== undefined) await deps.deployStore.setAlwaysOn(id, alwaysOn);
    if (endpoint.image && endpoint.image !== version.image) {
      await deps.deployStore.setVersionImage(id, version.version, endpoint.image);
    }
    return endpoint;
  };

  const markVersionRunning = async (id: string, version: number, endpoint: DeployEndpoint): Promise<void> => {
    await deps.deployStore.setEndpoint(id, endpoint);
    await deps.deployStore.setStatus(id, "running");
    await deps.deployStore.setAppliedVersion(id, version);
  };

  const liveEndpoint = async (d: Deployment): Promise<DeployEndpoint | null> => {
    if (d.endpoint == null) return d.endpoint;
    const version = currentVersionOf(d);
    if (!version) return d.endpoint;
    const resolved = await deps.provider.resolveEndpoint(d, version);
    if (resolved) {
      if (!endpointsEqual(resolved, d.endpoint)) await deps.deployStore.setEndpoint(d.id, resolved);
      return resolved;
    }
    return withDeployLock(d.id, async () => {
      const cur = await deps.deployStore.get(d.id);
      if (cur?.status !== "running") return null;
      const v = currentVersionOf(cur) ?? version;
      const again = await deps.provider.resolveEndpoint(cur, v);
      if (again) {
        if (!endpointsEqual(again, cur.endpoint)) await deps.deployStore.setEndpoint(cur.id, again);
        return again;
      }
      const fresh = await applyVersion(cur.id, v);
      await markVersionRunning(cur.id, v.version, fresh);
      return fresh;
    });
  };

  const rotateDeployment = (id: string): Promise<void> =>
    withDeployLock(id, async () => {
      const cur = await deps.deployStore.get(id);
      if (!cur || cur.status !== "running" || !renewDue(cur)) return;
      const v = currentVersionOf(cur);
      if (!v) return;
      const endpoint = await applyVersion(cur.id, v);
      await markVersionRunning(cur.id, v.version, endpoint);
    });

  const deploymentRef = (id: string): string => encodeRef(deployRef(id));
  const grantsOn = (d: Deployment): Promise<Grant[]> => deps.acl.grantsFor(d.ownerScopeId, deploymentRef(d.id));

  async function reachAllowed(d: Deployment, principalId: string): Promise<boolean> {
    if (!principalId) return false;
    const reaches = async (scope: ScopeId): Promise<boolean> => {
      if (deps.canReadScope) return deps.canReadScope(principalId, scope);
      const { kind, ref } = parseScopeId(scope);
      return kind === "org" || (kind === "personal" && samePerson(ref, principalId));
    };
    if (await reaches(d.ownerScopeId)) return true;
    for (const g of await grantsOn(d)) {
      if ((g.permission === "read" || g.permission === "write") && (await reaches(g.granteeScopeId))) return true;
    }
    return false;
  }

  async function canWriteScope(callerId: string, scope: ScopeId, actingScopeId?: ScopeId): Promise<boolean> {
    if (deps.canWriteScope) return deps.canWriteScope(callerId, scope);
    return scope === `personal:${callerId}` || scope === actingScopeId;
  }

  async function managesHome(d: Deployment, callerId: string, actingScopeId?: ScopeId): Promise<boolean> {
    if (d.ownerScopeId === `personal:${callerId}`) return true;
    if (deps.managesArtifactHome && (await deps.managesArtifactHome(d.ownerScopeId, d.createdBy, callerId)))
      return true;
    if (
      isManageableCreationScope(d.createdInScope) &&
      (await canWriteScope(callerId, d.createdInScope!, actingScopeId))
    )
      return true;
    return false;
  }

  async function canManage(
    d: Deployment,
    _ownerScopeId: ScopeId,
    callerId: string,
    actingScopeId?: ScopeId,
  ): Promise<boolean> {
    if (await managesHome(d, callerId, actingScopeId)) return true;
    for (const grant of await grantsOn(d)) {
      if (grant.permission !== "write") continue;
      if (await canWriteScope(callerId, grant.granteeScopeId, actingScopeId)) return true;
    }
    return false;
  }

  return {
    externalSharingAllowed,
    assertShareAllowed,
    withDeployLock,
    applyVersion,
    markVersionRunning,
    liveEndpoint,
    rotateDeployment,
    deploymentRef,
    grantsOn,
    reachAllowed,
    managesHome,
    canManage,
  };
}

export type DeployCore = ReturnType<typeof createDeployCore>;
