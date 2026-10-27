import { createHash } from "node:crypto";
import { acquireAwsLease as acquireLease, releaseAwsLease as releaseLease } from "../../aws-lease.ts";
import { type QmConfig } from "../../config.ts";
import { header, note, CliError, dim, ok, errMessage } from "../../log.ts";
import { type LogOpts, serviceHost } from "../../services.ts";
import { runInherit, streamLabeled } from "../../util.ts";
import { assertNotBackgroundOwner } from "./background-work.ts";
import { assertAwsCallerAccount, awsArgs, awsTopology } from "./clients.ts";
import {
  type DeploymentManifest,
  currentDeploymentManifest,
  deploymentManifest,
  deploymentManifestForTarget,
  firstRolledBackDbRestore,
  getDeploymentLayerArtifact,
  manifestTransaction,
  syncAwsLayerAfterRoll,
} from "./manifest.ts";
import {
  type ServiceSnapshot,
  applyServiceTargets,
  assertOwnedServices,
  awaitServiceTargets,
  describedServices,
  serviceSnapshot,
  throwAfterCompensation,
} from "./rollout.ts";
import { awsDeploymentLayerTransport } from "./routing.ts";

export async function awsStatus(config: QmConfig, configDir = process.cwd()): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  const result = await describedServices(config, workloads);
  header(`qm status — ${config.orgId} (aws)`);
  for (const workload of workloads) {
    const service = result.get(workload)!;
    note(`${service.serviceName}: ${service.runningCount}/${service.desiredCount} running · ${service.taskDefinition}`);
  }
  if (config.services.includes("slack")) note("slack: virtual service running in the core task");
}

export async function awsLogs(
  config: QmConfig,
  service: string | undefined,
  opts: LogOpts,
  configDir = process.cwd(),
): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  if (opts.tail !== undefined)
    note(`(--tail is a docker-only line count; aws logs tail has none, so it's ignored on the aws target)`);
  const logArgs = (name: string): string[] => {
    const spec = aws.services[name];
    if (!spec) throw new CliError(`unknown AWS workload ${name}`);
    return awsArgs(aws, [
      "logs",
      "tail",
      spec.logGroup ?? `/ecs/${spec.ecsService}`,
      ...(opts.follow ? ["--follow"] : []),
    ]);
  };
  if (service) {
    const resolved = serviceHost(service);
    if (resolved !== service) note(`${service} runs in ${resolved}; showing ${resolved} logs`);
    runInherit(process.env.AWS_BIN ?? "aws", logArgs(resolved));
    return;
  }
  return streamLabeled(
    workloads.map((name) => ({ label: name, command: process.env.AWS_BIN ?? "aws", args: logArgs(name) })),
    (label, line) => note(`${dim(label)} | ${line}`),
  );
}

export async function awsDown(config: QmConfig, configDir = process.cwd()): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  assertOwnedServices(config, await describedServices(config, workloads), workloads);
  const lease = await acquireLease(aws);
  try {
    const before = await serviceSnapshot(config, workloads);
    await applyServiceTargets(config, before.tasks, Object.fromEntries(workloads.map((workload) => [workload, 0])));
  } finally {
    await releaseLease(aws, lease);
  }
  ok(
    "AWS services set to zero desired tasks; in-flight turns resume on the next deployment. Infrastructure and data were retained.",
  );
}

export async function awsRollback(
  config: QmConfig,
  to?: string,
  layerOpts?: { configDir: string; envFile?: string },
): Promise<void> {
  const { aws, workloads: services } = awsTopology(config, layerOpts?.configDir ?? process.cwd());
  await assertAwsCallerAccount(aws);
  const lease = await acquireLease(aws);
  let before: ServiceSnapshot | undefined;
  let applied = false;
  let currentLayerBody: string | undefined;
  let layerAttempted = false;
  let rolledBack = false;
  try {
    before = await serviceSnapshot(config, services);
    const currentManifest = await currentDeploymentManifest(aws);
    let targetManifest: DeploymentManifest | undefined;
    if (!to) {
      if (!currentManifest?.previous) throw new CliError("no previous recorded AWS deployment to roll back to");
      targetManifest = await deploymentManifest(aws, currentManifest.previous);
    } else {
      targetManifest = await deploymentManifestForTarget(aws, to);
    }
    if (currentManifest?.backgroundDeploymentId || targetManifest.backgroundDeploymentId) {
      if (!aws.backgroundWorkControl || !targetManifest.backgroundDeploymentId)
        throw new CliError("controlled rollback requires a protocol-capable target deployment");
      await assertNotBackgroundOwner(config, currentManifest);
    }
    const missing = services.filter((service) => !targetManifest.tasks[service]);
    if (missing.length)
      throw new CliError(`target AWS deployment manifest is missing workloads: ${missing.join(", ")}`);
    let targetLayerBody: string | undefined;
    let layerNeedsSync = false;
    if (layerOpts) {
      targetLayerBody = await getDeploymentLayerArtifact(config, targetManifest.layer);
      if (currentManifest?.layer) currentLayerBody = await getDeploymentLayerArtifact(config, currentManifest.layer);
      else if (currentManifest)
        throw new CliError(`current AWS deployment manifest ${currentManifest.id} has no restorable deployment layer`);
      layerNeedsSync = currentManifest?.layer?.sha256 !== targetManifest.layer!.sha256;
    }
    const targets = Object.fromEntries(services.map((service) => [service, targetManifest!.tasks[service]!]));
    const targetCounts = Object.fromEntries(
      services.map((service) => [service, targetManifest.counts?.[service] ?? before!.counts[service]!]),
    );
    const changedTargets = Object.fromEntries(
      services
        .filter(
          (service) => before!.tasks[service] !== targets[service] || before!.counts[service] !== targetCounts[service],
        )
        .map((service) => [service, targets[service]!]),
    );
    if (Object.keys(changedTargets).length) {
      await applyServiceTargets(
        config,
        changedTargets,
        Object.fromEntries(Object.keys(changedTargets).map((service) => [service, targetCounts[service]!])),
      );
      applied = true;
    }
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        services.map((service) => [
          service,
          { taskDefinition: targets[service]!, desiredCount: targetCounts[service]! },
        ]),
      ),
    );
    if (targetLayerBody && layerOpts && layerNeedsSync) {
      if (targetCounts.core === 0) {
        note(
          "deployment layer sync deferred: core is scaled to zero, so `check --live` will flag the layer until the next `qm up` applies it",
        );
      } else {
        layerAttempted = true;
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: layerOpts.configDir,
            ...(layerOpts.envFile ? { envFile: layerOpts.envFile } : {}),
          },
          targetLayerBody,
          targetManifest.layer!,
        );
      }
    }
    rolledBack = true;
    if (currentManifest?.id !== targetManifest.id) {
      await manifestTransaction(aws, undefined, targetManifest.id);
      const dbRestore = currentManifest && (await firstRolledBackDbRestore(aws, currentManifest, targetManifest.id));
      if (dbRestore) {
        note(
          `rollback restores code and configuration, not data; the database ${dbRestore.kind} taken before the first rolled-back deployment is ${dbRestore.hint}`,
        );
      }
    }
  } catch (error) {
    if (rolledBack) throw error;
    const compensationFailures: string[] = [];
    if (layerAttempted && currentLayerBody && layerOpts) {
      try {
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: layerOpts.configDir,
            ...(layerOpts.envFile ? { envFile: layerOpts.envFile } : {}),
          },
          currentLayerBody,
          createHash("sha256").update(currentLayerBody).digest("hex"),
        );
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-rollback deployment layer: ${errMessage(restoreError)}`);
      }
    }
    if (applied && before) {
      try {
        await applyServiceTargets(config, before.tasks, before.counts);
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-rollback manifest: ${errMessage(restoreError)}`);
      }
    }
    throwAfterCompensation(error, compensationFailures);
  } finally {
    await releaseLease(aws, lease);
  }
  ok(`rolled back ${config.orgId}`);
}
