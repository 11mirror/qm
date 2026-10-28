import { EXTERNAL_APP_SHARING_OFF } from "../feature-flags.ts";
import { notifyDeploymentShared } from "./share-notice.ts";
import type { Outbound } from "../surfaces/outbound.ts";
import { EMBED_ANCESTORS_HINT, parseEmbedAncestors } from "./embed-ancestors.ts";
import { deploymentShareScope } from "./email-access.ts";
import { randomUUID } from "node:crypto";
import type { Permission, ScopeId } from "../types.ts";
import { parseScopeId, scopeId } from "../types.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import {
  currentVersionOf,
  deployCurrentGitRef,
  type DeployStore,
  type Deployment,
  type DeployEndpoint,
} from "./deploy-store.ts";
import type { DeployProfile, DeployProvider } from "./deploy-provider.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { createDeployCore, type DeployCore } from "./deploy-service-core.ts";
import {
  DeployAccessError,
  PUBLIC_LINKS_UNAVAILABLE,
  assertAppSize,
  fileSizes,
  renewDue,
  requiredEntrypoint,
  snapshotFiles,
  validateDisplayName,
  validateName,
} from "./deploy-service-support.ts";

export interface DeployFile {
  path: string;
  data: string | Uint8Array;
}

export interface RedeployInput {
  entrypoint: string;
  files: DeployFile[];
  homeFiles?: DeployFile[];
  env?: Record<string, string>;
  stampEnv?: Record<string, string>;
  alwaysOn?: boolean;
}

export interface DeployInput extends RedeployInput {
  ownerScopeId: ScopeId;
  createdBy: string;
  createdInScope?: ScopeId;
  name?: string;
}

export type Reach =
  { status: "ok"; id: string; endpoint: DeployEndpoint } | { status: "denied" } | { status: "not_found" };

export interface DeployOrUpdateInput {
  ownerScopeId: ScopeId;
  createdBy: string;
  name?: string;
  entrypoint?: string;
  files?: DeployFile[];
  homeFiles?: DeployFile[];
  env?: Record<string, string>;
  stampEnv?: Record<string, string>;
  renameFrom?: string;
  rollbackTo?: number;
  createdInScope?: ScopeId;
  alwaysOn?: boolean;
  embedAncestors?: string[];
}

export interface ReachOptions {
  bypassAcl?: boolean;
}

export interface DeployService {
  readonly providerProfile: DeployProfile;
  deploy(input: DeployInput): Promise<Deployment>;
  redeploy(id: string, input: RedeployInput): Promise<Deployment>;
  getDeployment(idOrName: string): Promise<Deployment | null>;
  listDeployments(): Promise<Deployment[]>;
  rollbackDeployment(id: string, version: number, options?: { alwaysOn?: boolean }): Promise<void>;
  archiveDeployment(id: string): Promise<void>;
  restoreDeployment(id: string, actorId?: string): Promise<Deployment>;
  renameDeployment(id: string, name: string): Promise<Deployment>;
  setDeploymentDisplayName(id: string, displayName: string): Promise<Deployment>;
  setDeploymentAlwaysOn(id: string, alwaysOn: boolean): Promise<Deployment>;
  setDeploymentEmbedAncestors(id: string, embedAncestors: string[]): Promise<Deployment>;
  setDeploymentPublic(idOrName: string, isPublic: boolean, actor: { createdBy: string }): Promise<Deployment>;

  maintainDeployments(): Promise<number>;
  reachDeployment(idOrName: string, principalId: string, opts?: ReachOptions): Promise<Reach>;
  deploymentLogs(idOrName: string, opts: { tailLines: number }): Promise<string | null>;
  gitRepoPath(idOrName: string): Promise<string | null>;
  pushGit<T>(id: string, runReceivePack: () => Promise<{ result: T; ok: boolean }>): Promise<T>;
  deployOrUpdate(input: DeployOrUpdateInput): Promise<Deployment>;
  deploymentGrantees(idOrName: string): Promise<DeploymentGrantee[]>;
  canManageDeployment(idOrName: string, callerId: string, actingScopeId?: ScopeId): Promise<boolean>;
  shareDeployment(
    idOrName: string,
    grantee: ScopeId,
    permission: Permission | null,
    actor: { createdBy: string },
  ): Promise<DeploymentGrantee[]>;
  assertShareAllowed(ownerScopeId: ScopeId, grantee: ScopeId, permission: Permission | null): Promise<void>;
  transferDeploymentOwner(
    idOrName: string,
    toScope: ScopeId,
    actor: { callerId: string; actingScopeId?: ScopeId },
  ): Promise<Deployment>;
}

export interface DeploymentGrantee {
  scope: ScopeId;
  permission: Permission;
}

export interface DeployServiceDeps {
  outbound?: Outbound;
  deployAppsDomain?: string;
  publicLinksAvailable?: boolean;
  publicWebUrl?: string;
  deployStore: DeployStore;
  provider: DeployProvider;
  deployDir: string;
  auditLog: AuditLog;
  appPublished?: (principal: string, deploymentId: string, version: number) => Promise<void>;
  acl: AclStore;
  advisoryLock: AdvisoryLock;
  canReadScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  canWriteScope?: (principalId: string, scopeId: ScopeId) => Promise<boolean>;
  canManageEmail?: (email: string) => Promise<boolean>;
  externalSharingAllowed?: (ownerScopeId: ScopeId) => Promise<boolean>;
  managesArtifactHome?: (homeScopeId: ScopeId, createdBy: string, principalId: string) => Promise<boolean>;
  deploymentEnv?: (deployment: Deployment) => Promise<Record<string, string>>;
}

function deployPublishMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { withDeployLock, applyVersion, markVersionRunning, deploymentRef } = core;
  return {
    async deploy(input) {
      if (input.name !== undefined) {
        validateName(input.name);
        if (await deps.deployStore.getByName(input.name)) throw new Error(`deployment name taken: ${input.name}`);
      }
      assertAppSize(fileSizes(input.files), deps.provider.profile.maxAppBytes);
      const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
      const homeDir = input.homeFiles?.length ? await snapshotFiles(deps.deployDir, input.homeFiles) : undefined;
      const env = input.stampEnv ? { ...input.env, ...input.stampEnv } : input.env;
      const id = randomUUID();
      if (input.createdInScope && parseScopeId(input.createdInScope).kind === "channel") {
        await deps.acl.grant({
          ownerScopeId: input.ownerScopeId,
          ref: deploymentRef(id),
          granteeScopeId: input.createdInScope,
          permission: "read",
          grantedBy: input.createdBy,
        });
      }
      const d = await deps.deployStore.create({
        id,
        ownerScopeId: input.ownerScopeId,
        createdBy: input.createdBy,
        entrypoint: input.entrypoint,
        snapshotDir,
        files: input.files,
        ...(homeDir ? { homeDir } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
        ...(env ? { env } : {}),
        ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
      });
      const endpoint = await applyVersion(d.id, d.versions[0]!);
      await markVersionRunning(d.id, d.versions[0]!.version, endpoint);
      void deps
        .appPublished?.(input.createdBy, d.id, d.versions[0]!.version)
        .catch(swallowAs("deploy: app published hook", undefined));
      deps.auditLog.record({
        at: Date.now(),
        principalId: input.createdBy,
        action: "deploy",
        resource: d.id,
        scopeLabel: input.ownerScopeId,
      });
      return (await deps.deployStore.get(d.id))!;
    },

    async redeploy(id, input) {
      return withDeployLock(id, async () => {
        const before = await deps.deployStore.get(id);
        if (!before) throw new Error(`unknown deployment: ${id}`);
        const current = currentVersionOf(before);
        assertAppSize(fileSizes(input.files), deps.provider.profile.maxAppBytes);
        const snapshotDir = await snapshotFiles(deps.deployDir, input.files);
        let homeDir = input.homeFiles === undefined ? current?.homeDir : undefined;
        if (input.homeFiles?.length) homeDir = await snapshotFiles(deps.deployDir, input.homeFiles);
        const inherited = input.env ?? current?.env;
        const env = input.stampEnv ? { ...inherited, ...input.stampEnv } : inherited;
        const v = await deps.deployStore.addVersion(id, {
          entrypoint: input.entrypoint,
          snapshotDir,
          files: input.files,
          ...(homeDir ? { homeDir } : {}),
          ...(env ? { env } : {}),
        });
        const endpoint = await applyVersion(id, v, input.alwaysOn);
        await markVersionRunning(id, v.version, endpoint);
        void deps
          .appPublished?.(before.createdBy, id, v.version)
          .catch(swallowAs("deploy: app published hook", undefined));
        deps.auditLog.record({
          at: Date.now(),
          principalId: before.createdBy,
          action: "deploy_version",
          resource: `${id}@v${v.version}`,
          scopeLabel: before.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },
  } satisfies Partial<DeployService>;
}

function deployLifecycleMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { withDeployLock, applyVersion, markVersionRunning } = core;
  return {
    async getDeployment(idOrName) {
      return (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
    },

    listDeployments() {
      return deps.deployStore.list();
    },

    async rollbackDeployment(id, version, options) {
      return withDeployLock(id, async () => {
        await deps.deployStore.setCurrentVersion(id, version);
        const v = await deps.deployStore.versionOf(id, version);
        const d = await deps.deployStore.get(id);
        if (!d || !v) return;
        const endpoint = await applyVersion(id, v, options?.alwaysOn);
        await markVersionRunning(id, v.version, endpoint);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rollback",
          resource: `${id}@v${version}`,
          scopeLabel: d.ownerScopeId,
        });
      });
    },

    async archiveDeployment(id) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) return;
        await deps.provider.destroy(d);
        await deps.deployStore.setStatus(id, "archived");
        await deps.deployStore.setEndpoint(id, null);
      });
    },

    async restoreDeployment(id, actorId) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        if (d.status === "running") return d;
        if (d.status !== "archived") throw new Error(`deployment is not archived: ${id}`);
        const version = currentVersionOf(d);
        if (!version) throw new Error(`no such version ${d.currentVersion}`);
        try {
          const endpoint = await applyVersion(id, version);
          await markVersionRunning(id, version.version, endpoint);
        } catch (error) {
          await deps.provider
            .destroy(d)
            .catch((cleanupError) => swallow("deploy restore runtime cleanup", cleanupError));
          await deps.deployStore
            .setStatus(id, "archived")
            .catch((cleanupError) => swallow("deploy restore status cleanup", cleanupError));
          await deps.deployStore
            .setEndpoint(id, null)
            .catch((cleanupError) => swallow("deploy restore endpoint cleanup", cleanupError));
          throw error;
        }
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId ?? d.createdBy,
          action: "deploy_restore",
          resource: `${id}@v${version.version}`,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },
  } satisfies Partial<DeployService>;
}

function deploySettingsMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { externalSharingAllowed, withDeployLock, deploymentRef } = core;
  return {
    async renameDeployment(id, name) {
      return withDeployLock(id, async () => {
        validateName(name);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        const clash = await deps.deployStore.getByName(name);
        if (clash && clash.id !== id) throw new Error(`deployment name taken: ${name}`);
        await deps.deployStore.setName(id, name);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_rename",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setDeploymentDisplayName(id, displayName) {
      return withDeployLock(id, async () => {
        if (displayName) validateDisplayName(displayName);
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        await deps.deployStore.setDisplayName(id, displayName || undefined);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_display_name",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setDeploymentAlwaysOn(id, alwaysOn) {
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        await deps.deployStore.setAlwaysOn(id, alwaysOn);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_always_on",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setDeploymentEmbedAncestors(id, embedAncestors) {
      const ancestors = parseEmbedAncestors(embedAncestors);
      if (!ancestors) throw new Error(`embedAncestors must be an ${EMBED_ANCESTORS_HINT}`);
      return withDeployLock(id, async () => {
        const d = await deps.deployStore.get(id);
        if (!d) throw new Error(`unknown deployment: ${id}`);
        await deps.deployStore.setEmbedAncestors(id, ancestors);
        deps.auditLog.record({
          at: Date.now(),
          principalId: d.createdBy,
          action: "deploy_embed_ancestors",
          resource: id,
          scopeLabel: d.ownerScopeId,
        });
        return (await deps.deployStore.get(id))!;
      });
    },

    async setDeploymentPublic(idOrName, isPublic, actor) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      if (d.ownerScopeId !== scopeId("personal", actor.createdBy)) {
        throw new DeployAccessError("forbidden", `only the owner can change who can reach "${d.name ?? d.id}"`);
      }
      if (isPublic && !(await externalSharingAllowed(d.ownerScopeId)))
        throw new DeployAccessError("external_sharing_disabled", EXTERNAL_APP_SHARING_OFF);
      if (isPublic && deps.publicLinksAvailable === false)
        throw new DeployAccessError("public_links_unavailable", PUBLIC_LINKS_UNAVAILABLE);
      await deps.deployStore.setPublic(d.id, isPublic);
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.createdBy,
        action: isPublic ? "deploy_public_enable" : "deploy_public_disable",
        resource: deploymentRef(d.id),
        scopeLabel: d.ownerScopeId,
      });
      return (await deps.deployStore.get(d.id))!;
    },
  } satisfies Partial<DeployService>;
}

function deployRuntimeMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { withDeployLock, applyVersion, markVersionRunning, liveEndpoint, rotateDeployment, reachAllowed } = core;
  return {
    async maintainDeployments() {
      let maintained = 0;
      for (const d of await deps.deployStore.list()) {
        if (d.status !== "running") continue;
        try {
          const cur = await deps.deployStore.get(d.id);
          if (!cur || cur.status !== "running") continue;
          if (renewDue(cur)) {
            await rotateDeployment(cur.id);
            maintained++;
          } else if (cur.alwaysOn && (await liveEndpoint(cur))) {
            maintained++;
          }
        } catch (e) {
          reportFailure("deploy: maintenance", e, d.name ?? d.id);
        }
      }
      return maintained;
    },

    async reachDeployment(idOrName, principalId, opts = {}): Promise<Reach> {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running" || d.endpoint == null) return { status: "not_found" };
      if (!opts.bypassAcl && !(await reachAllowed(d, principalId))) return { status: "denied" };
      const endpoint = await liveEndpoint(d);
      if (!endpoint) return { status: "not_found" };
      await deps.deployStore.touch(d.id, Date.now()).catch((e) => swallow("deploy reach touch", e));
      return { status: "ok", id: d.id, endpoint };
    },

    async deploymentLogs(idOrName, opts): Promise<string | null> {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d || d.status !== "running") return null;
      return deps.provider.logs(d, opts);
    },

    async gitRepoPath(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      return d ? await deps.deployStore.repoUrl(d.id) : null;
    },

    async pushGit(id, runReceivePack) {
      return withDeployLock(id, async () => {
        const { result, ok } = await runReceivePack();
        if (!ok) return result;
        let ownerScopeId = "unknown";
        try {
          const before = await deps.deployStore.get(id);
          if (!before) return result;
          ownerScopeId = before.ownerScopeId;
          const pushed = await deps.deployStore.refOf(id, deployCurrentGitRef);
          if (!pushed) return result;
          const tree = await deps.deployStore.commitTreeOf(id, pushed);
          assertAppSize(
            tree.map((f) => f.size),
            deps.provider.profile.maxAppBytes,
          );
          const v = await deps.deployStore.addVersionFromCommit(id, pushed);
          if (!v) return result;
          const endpoint = await applyVersion(id, v);
          await markVersionRunning(id, v.version, endpoint);
          void deps
            .appPublished?.(before.createdBy, id, v.version)
            .catch(swallowAs("deploy: app published hook", undefined));
          deps.auditLog.record({
            at: Date.now(),
            principalId: before.createdBy,
            action: "deploy_git_push",
            resource: `${id}@v${v.version}`,
            scopeLabel: before.ownerScopeId,
          });
        } catch (e) {
          reportFailure("deploy: register pushed version", e, `deployment=${id}`);
          deps.auditLog.record({
            at: Date.now(),
            principalId: "system",
            action: "deploy_git_push_failed",
            resource: id,
            scopeLabel: ownerScopeId,
            status: "error",
          });
        }
        return result;
      });
    },
  } satisfies Partial<DeployService>;
}

function deployOrUpdateMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { canManage } = core;
  return {
    async deployOrUpdate(input) {
      const { ownerScopeId, createdBy } = input;
      if (input.embedAncestors !== undefined && !parseEmbedAncestors(input.embedAncestors))
        throw new Error(`embedAncestors must be an ${EMBED_ANCESTORS_HINT}`);

      if (input.renameFrom !== undefined) {
        if (input.name === undefined) throw new Error("rename requires a target name");
        validateName(input.name);
        const existing = await deps.deployStore.getByName(input.renameFrom);
        if (!existing) throw new Error(`no deployment named: ${input.renameFrom}`);
        if (!(await canManage(existing, ownerScopeId, createdBy, input.createdInScope)))
          throw new Error(`not authorized to manage deployment: ${input.renameFrom}`);
        const clash = await deps.deployStore.getByName(input.name);
        if (clash && clash.id !== existing.id) throw new Error(`deployment name taken: ${input.name}`);
        await deps.deployStore.setName(existing.id, input.name);
        deps.auditLog.record({
          at: Date.now(),
          principalId: createdBy,
          action: "deploy_rename",
          resource: existing.id,
          scopeLabel: existing.ownerScopeId,
        });
        if (input.files?.length) {
          const entrypoint = requiredEntrypoint(input.entrypoint, existing);
          await this.redeploy(existing.id, {
            entrypoint,
            files: input.files,
            ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
            ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
            ...(input.env ? { env: input.env } : {}),
            ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
          });
        } else if (input.alwaysOn !== undefined) await this.setDeploymentAlwaysOn(existing.id, input.alwaysOn);
        if (input.embedAncestors !== undefined)
          await this.setDeploymentEmbedAncestors(existing.id, input.embedAncestors);
        return (await deps.deployStore.get(existing.id))!;
      }

      if (input.rollbackTo !== undefined) {
        if (input.name === undefined) throw new Error("rollback requires the deployment name");
        const existing = await deps.deployStore.getByName(input.name);
        if (!existing) throw new Error(`no deployment named: ${input.name}`);
        if (!(await canManage(existing, ownerScopeId, createdBy, input.createdInScope)))
          throw new Error(`not authorized to manage deployment: ${input.name}`);
        await this.rollbackDeployment(
          existing.id,
          input.rollbackTo,
          input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : undefined,
        );
        if (input.embedAncestors !== undefined)
          await this.setDeploymentEmbedAncestors(existing.id, input.embedAncestors);
        return (await deps.deployStore.get(existing.id))!;
      }

      const files = input.files ?? [];
      const existing = input.name !== undefined ? await deps.deployStore.getByName(input.name) : null;
      if (existing) {
        if (
          existing.ownerScopeId !== ownerScopeId &&
          !(await canManage(existing, ownerScopeId, createdBy, input.createdInScope))
        ) {
          throw new Error(`deployment name taken: ${input.name}`);
        }
        const entrypoint = requiredEntrypoint(input.entrypoint, existing);
        await this.redeploy(existing.id, {
          entrypoint,
          files,
          ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
          ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
        });
        if (input.embedAncestors !== undefined)
          await this.setDeploymentEmbedAncestors(existing.id, input.embedAncestors);
        return (await deps.deployStore.get(existing.id))!;
      }
      const d = await this.deploy({
        ownerScopeId,
        createdBy,
        entrypoint: requiredEntrypoint(input.entrypoint, existing),
        files,
        ...(input.homeFiles ? { homeFiles: input.homeFiles } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.createdInScope !== undefined ? { createdInScope: input.createdInScope } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.stampEnv ? { stampEnv: input.stampEnv } : {}),
        ...(input.alwaysOn !== undefined ? { alwaysOn: input.alwaysOn } : {}),
      });
      if (input.embedAncestors !== undefined) await this.setDeploymentEmbedAncestors(d.id, input.embedAncestors);
      return (await deps.deployStore.get(d.id))!;
    },
  } satisfies Partial<DeployService> & ThisType<DeployService>;
}

function deployAccessMethods(deps: DeployServiceDeps, core: DeployCore) {
  const { assertShareAllowed, deploymentRef, grantsOn, managesHome, canManage } = core;
  return {
    async canManageDeployment(idOrName, callerId, actingScopeId) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) return false;
      return canManage(d, scopeId("personal", callerId), callerId, actingScopeId);
    },

    async deploymentGrantees(idOrName) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) return [];
      return (await grantsOn(d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
    },

    async shareDeployment(idOrName, grantee, permission, actor) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      if (d.ownerScopeId !== scopeId("personal", actor.createdBy)) {
        throw new DeployAccessError("forbidden", `only the owner can change who can reach "${d.name ?? d.id}"`);
      }
      grantee = await deploymentShareScope(grantee, permission, deps.canManageEmail);
      await assertShareAllowed(d.ownerScopeId, grantee, permission);
      const ref = deploymentRef(d.id);
      await deps.acl.revoke(d.ownerScopeId, ref, grantee, actor.createdBy);
      if (permission === null) {
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.createdBy,
          action: "deploy_unshare",
          resource: ref,
          scopeLabel: grantee,
        });
      } else {
        await deps.acl.grant({
          ownerScopeId: d.ownerScopeId,
          ref,
          granteeScopeId: grantee,
          permission,
          grantedBy: actor.createdBy,
        });
        deps.auditLog.record({
          at: Date.now(),
          principalId: actor.createdBy,
          action: "deploy_share",
          resource: ref,
          scopeLabel: grantee,
        });
      }
      await notifyDeploymentShared(deps, d, grantee, permission, actor.createdBy);
      return (await grantsOn(d)).map((g) => ({ scope: g.granteeScopeId, permission: g.permission }));
    },

    async transferDeploymentOwner(idOrName, toScope, actor) {
      const d = (await deps.deployStore.get(idOrName)) ?? (await deps.deployStore.getByName(idOrName));
      if (!d) throw new DeployAccessError("not_found", `no such app: ${idOrName}`);
      if (!(await managesHome(d, actor.callerId, actor.actingScopeId))) {
        throw new DeployAccessError("forbidden", `only the owner can transfer "${d.name ?? d.id}"`);
      }
      if (d.ownerScopeId === toScope) return d;
      const ref = deploymentRef(d.id);
      const fromScope = d.ownerScopeId;
      const prior = await grantsOn(d);
      const newOwnerId = parseScopeId(toScope).kind === "personal" ? parseScopeId(toScope).ref! : actor.callerId;
      const oldOwnerId = parseScopeId(fromScope).kind === "personal" ? parseScopeId(fromScope).ref! : actor.callerId;
      for (const g of prior) {
        if (g.granteeScopeId === toScope) continue;
        await deps.acl.grant({ ...g, ownerScopeId: toScope, grantedBy: newOwnerId }, d.createdBy);
      }
      await deps.acl.grant(
        { ownerScopeId: toScope, ref, granteeScopeId: fromScope, permission: "write", grantedBy: newOwnerId },
        d.createdBy,
      );
      await deps.deployStore.setOwnerScope(d.id, toScope);
      for (const g of prior) await deps.acl.revoke(fromScope, ref, g.granteeScopeId, oldOwnerId, d.createdBy);
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.callerId,
        action: "deploy_transfer",
        resource: ref,
        scopeLabel: toScope,
      });
      return (await deps.deployStore.get(d.id))!;
    },
  } satisfies Partial<DeployService>;
}

export function createDeployService(deps: DeployServiceDeps): DeployService {
  const core = createDeployCore(deps);
  return {
    providerProfile: deps.provider.profile,
    assertShareAllowed: core.assertShareAllowed,
    ...deployPublishMethods(deps, core),
    ...deployLifecycleMethods(deps, core),
    ...deploySettingsMethods(deps, core),
    ...deployRuntimeMethods(deps, core),
    ...deployOrUpdateMethods(deps, core),
    ...deployAccessMethods(deps, core),
  };
}
