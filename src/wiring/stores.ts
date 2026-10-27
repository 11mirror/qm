import type { Head } from "./late.ts";
import { createPostgresMapFactory, type DurableMap } from "../persistence/durable-map.ts";
import { registerAbsurdSchema } from "../turns/absurd-schema.ts";
import { type AdvisoryLock, createPostgresAdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPrincipalLinkService, type PrincipalLink } from "../identity/principal-links.ts";
import { installPrincipalLinks } from "../directory/person.ts";
import { createIdentityService, type DeactivationRecord } from "../identity/identity-service.ts";
import type { ExternalMember } from "../identity/external-members.ts";
import { type LeaderLease, createPostgresLeaderLease } from "../persistence/leader-lease.ts";
import { createConfigStore } from "../resolution/config-store.ts";
import { type SkillStore, createSkillStore, type Skill } from "../skills/skill-store.ts";
import { createSkillPackStore, type SkillPack } from "../skills/skill-pack-store.ts";
import { createSkillBundleStore, type SkillBundle } from "../skills/skill-bundle-store.ts";
import { createFeatureFlagStore } from "../feature-flags.ts";
import { createPostgresTeamStore } from "../teams/teams.ts";
import { scopeId } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { createPostgresSessionStore } from "../sessions/postgres-session-store.ts";
import { createAdminGrantStore } from "../admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "../admin/postgres-admin-grant-store.ts";
import { parseAdminGrants, createAdminService } from "../admin/admin-service.ts";
import { createPostgresDirectoryStore } from "../directory/postgres-directory-store.ts";
import { createPostgresEnvironmentStore } from "../environments/environment-store.ts";
import { createProjectStore, type Project } from "../projects/project-store.ts";
import {
  createCanReadScope,
  createCanWriteScope,
  createCanManageScope,
  createManagesArtifactHome,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  type CanManageScope,
} from "../resolution/scope-membership.ts";
import { createPostgresDecisionStore } from "../decisions/store.ts";
import { createConnectorStatusCache, type ConnectorStatusRecord } from "../credentials/connector-status.ts";
import { createSlackInstallationStore } from "../surfaces/slack-installation.ts";

export function buildStores(w: Head) {
  const { databaseUrl, config, connectorSecretKey } = w;

  const pgArtifactMap = createPostgresMapFactory(databaseUrl);
  registerAbsurdSchema(databaseUrl);
  const artifactMap = <T>(table: string, indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> =>
    pgArtifactMap.map<T>(table, indexedFields);
  const advisoryLock: AdvisoryLock = createPostgresAdvisoryLock(pgArtifactMap.pool);
  const principalLinks = createPrincipalLinkService(artifactMap<PrincipalLink>("principal_links"), advisoryLock);
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService(artifactMap<DeactivationRecord>("deactivated_principals"), {
    directorySyncProtected: config.emailAuthPrincipals,
    externalMembers: artifactMap<ExternalMember>("external_members"),
    principalLinks,
  });
  const leaderLease: LeaderLease = createPostgresLeaderLease(pgArtifactMap.pool);
  const configStore = createConfigStore(config.orgId, { databaseUrl, connectorSecretKey });
  const skills: SkillStore = createSkillStore({
    backing: artifactMap<Skill>("skills"),
    advisoryLock,
  });
  const skillPacks = createSkillPackStore({ backing: artifactMap<SkillPack>("skill_packs") });
  const skillBundles = createSkillBundleStore({ backing: artifactMap<SkillBundle>("skill_bundles") });
  const featureFlags = createFeatureFlagStore(databaseUrl);
  const teams = createPostgresTeamStore(databaseUrl, featureFlags, scopeId("org", config.orgId));
  const sessions: SessionStore = createPostgresSessionStore(databaseUrl);
  const adminGrantStore = createAdminGrantStore(createPostgresAdminGrantStore(databaseUrl), {
    seed: parseAdminGrants(config.adminGrants, config.orgId) ?? [],
  });
  const admin = createAdminService(adminGrantStore, { trustedOidcAdminIssuer: config.trustedOidcAdminIssuer });
  const directory = createPostgresDirectoryStore(databaseUrl);
  const environments = createPostgresEnvironmentStore(databaseUrl);
  const projects = createProjectStore(artifactMap<Project>("projects"), {
    isActiveMember: (principalId) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  });
  const canReadScope = createCanReadScope({ managedGroups: projects, directory, identity, teams, sessions });
  const canWriteScope = createCanWriteScope({ managedGroups: projects, directory, identity, teams });
  const canManageScope = createCanManageScope({ managedGroups: projects, directory, identity, sessions });
  const managesArtifactHome = createManagesArtifactHome(
    { managedGroups: projects, directory, identity, teams },
    canManageScope,
  );
  const currentScopeMembers = createCurrentScopeMembers({ managedGroups: projects, directory, identity });
  const isCurrentSharedScopeMember = createIsCurrentSharedScopeMember({ managedGroups: projects, directory, identity });
  const canUseSandboxScope: CanManageScope = async (actorId, scopeId) =>
    identity.isInternal(identity.classify(actorId)) &&
    ((await admin.adminStatusOf(identity.classify(actorId))).isAdmin || (await canWriteScope(actorId, scopeId)));
  const decisions = createPostgresDecisionStore(databaseUrl);
  const connectorStatusCache = createConnectorStatusCache(artifactMap<ConnectorStatusRecord>("connector_status"));
  const slackInstallation = createSlackInstallationStore(
    config.orgId,
    artifactMap("slack_installation"),
    connectorSecretKey,
  );
  return {
    artifactMap,
    managesArtifactHome,
    skills,
    skillBundles,
    advisoryLock,
    identity,
    configStore,
    pgArtifactMap,
    canUseSandboxScope,
    decisions,
    featureFlags,
    sessions,
    canReadScope,
    canWriteScope,
    directory,
    projects,
    currentScopeMembers,
    admin,
    teams,
    connectorStatusCache,
    isCurrentSharedScopeMember,
    environments,
    leaderLease,
    skillPacks,
    slackInstallation,
    principalLinks,
  };
}

export type StoresModule = ReturnType<typeof buildStores>;
