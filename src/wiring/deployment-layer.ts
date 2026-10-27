import { loadDeploymentLayer, emptyDeploymentLayer } from "../deployment/load-layer.ts";
import { resolve } from "node:path";
import { scopeId } from "../types.ts";
import { createPostgresAuditLog } from "../admin/postgres-audit-log.ts";
import {
  createDeploymentLayerStore,
  type StoredDeploymentLayer,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
} from "../deployment/deployment-layer-store.ts";
import { installSeedSkills } from "../skills/seed.ts";
import { createSweeper as createUntrackedSweeper } from "../util/sweeper.ts";
import type { Config } from "../config.ts";
import type { Stores } from "./stores.ts";

export function buildDeploymentLayer(
  w: Pick<Stores, "artifactMap" | "skills" | "skillBundles" | "advisoryLock"> & { config: Config; databaseUrl: string },
) {
  const { config, databaseUrl, artifactMap, skills, skillBundles, advisoryLock } = w;

  const deploymentLayer = config.deploymentLayerDir
    ? loadDeploymentLayer(config.deploymentLayerDir)
    : emptyDeploymentLayer();
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const brokeredTools = deploymentLayer.brokeredTools;
  const orgScope = scopeId("org", config.orgId);
  const auditLog = createPostgresAuditLog(databaseUrl);
  const deploymentLayerStore = createDeploymentLayerStore({
    backing: artifactMap<StoredDeploymentLayer>("deployment_layer"),
    runtime: deploymentLayer,
    skills,
    skillBundles,
    scopeId: orgScope,
    advisoryLock,
    auditPersisted: (record) =>
      auditLog.recordOnce!(`deployment-layer:${orgScope}:${record.version}`, {
        at: record.updatedAt,
        principalId: record.updatedBy,
        action: "deployment_layer.updated",
        resource: record.contentHash,
        scopeLabel: orgScope,
      }),
    ...(config.seedSkills && layerSkillsDir
      ? {
          seedFallback: () =>
            installSeedSkills(skills, {
              dir: layerSkillsDir,
              scopeId: orgScope,
              createdBy: LAYER_CREATED_BY,
              reviewer: LAYER_REVIEWER,
            }),
        }
      : {}),
  });
  const deploymentLayerRefresh = createUntrackedSweeper(() => deploymentLayerStore.hydrate(), 30_000, {
    label: "deployment layer refresh",
  });
  const installCatalogs = async (): Promise<void> => {
    await installSeedSkills(skills, { dir: resolve("./skills-seed"), scopeId: orgScope, respectArchived: true });
    for (const dir of config.pluginSkillDirs) {
      if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
      await installSeedSkills(skills, {
        dir,
        scopeId: orgScope,
        createdBy: "system:plugin-skills",
        reviewer: "system:plugin-skills-reviewer",
        respectArchived: true,
      });
    }
  };
  return { deploymentLayerStore, installCatalogs, deploymentLayer, auditLog, brokeredTools, deploymentLayerRefresh };
}

export type DeploymentLayer = ReturnType<typeof buildDeploymentLayer>;
