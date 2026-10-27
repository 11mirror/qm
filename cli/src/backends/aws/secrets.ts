import { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { withAwsLease, awsErrorCode } from "../../aws-lease.ts";
import { type AwsConfig, type QmConfig } from "../../config.ts";
import { CliError, step, note, errMessage, ok } from "../../log.ts";
import { validatedSecrets, computedSecrets } from "../../secrets.ts";
import { hostsWebEdge, runsSeparateWebEdge } from "../../services.ts";
import { readEnvFile, deploymentSecretValue, promptHidden, isInvalidSecret } from "../../util.ts";
import {
  assertAwsCallerAccount,
  awsTopology,
  describeTaskDefinition,
  ecs,
  secretsManager,
  type EcsServiceState,
} from "./clients.ts";
import { isPinnedWorkloadImage } from "./images.ts";
import { currentDeploymentManifest, recordDeploymentManifest, type DeploymentManifest } from "./manifest.ts";
import {
  applyServiceTargets,
  assertOwnedServices,
  awaitServiceTargets,
  describedServices,
  serviceSnapshotFromStates,
  throwAfterCompensation,
  type ServiceSnapshot,
} from "./rollout.ts";
import {
  registerTaskDefinition,
  renderTaskDefinition,
  secretArns,
  taskDefinitionChanges,
  workloadArchitecture,
  workloadSecrets,
} from "./task-definitions.ts";

function envValues(configDir: string, path: string | undefined): Map<string, string> {
  const file = resolve(path ?? join(configDir, ".env"));
  if (!existsSync(file)) {
    if (path) throw new CliError(`secret source not found: ${file}`);
    return new Map();
  }
  return readEnvFile(file);
}

interface StagedSecret {
  name: string;
  id: string;
  value: string;
}

async function stageOperatorSecrets(config: QmConfig, aws: AwsConfig, values: Map<string, string>) {
  const staged: StagedSecret[] = [];
  for (const secret of computedSecrets(config).filter((item) => item.managedBy === "operator")) {
    const supplied = deploymentSecretValue(secret.name, values.get(secret.name));
    if (!secret.required && !supplied) {
      step(`${secret.name}: optional, not supplied`);
      continue;
    }
    const value = supplied ?? (await promptHidden(secret.name));
    if (isInvalidSecret(secret.name, value)) {
      throw new CliError(
        `${secret.name} must have a non-empty, non-placeholder value; signing keys must be at least 32 characters`,
      );
    }
    staged.push({ name: secret.name, id: `${aws.secretsPrefix}${secret.name}`, value });
  }
  return staged;
}

function rotationBaseline(
  workloads: string[],
  states: ReadonlyMap<string, EcsServiceState>,
  baseline: DeploymentManifest | undefined,
): ServiceSnapshot | undefined {
  if (!baseline) {
    const active = workloads.filter((workload) => {
      const state = states.get(workload)!;
      return state.desiredCount !== 0 || state.runningCount !== 0;
    });
    if (active.length) {
      throw new CliError(
        `cannot defer secret activation without a current deployment manifest while workloads are active: ${active.join(", ")}`,
      );
    }
    return undefined;
  }
  const before = serviceSnapshotFromStates(states, workloads);
  const drifted = workloads.filter(
    (workload) => !baseline.tasks[workload] || before.tasks[workload] !== baseline.tasks[workload],
  );
  if (drifted.length)
    throw new CliError(
      `cannot rotate secrets while workloads differ from the current deployment manifest: ${drifted.join(", ")}`,
    );
  return before;
}

async function assertRotatable(
  config: QmConfig,
  aws: AwsConfig,
  affected: string[],
  before: ServiceSnapshot,
  baseline: DeploymentManifest,
  staged: StagedSecret[],
): Promise<void> {
  for (const workload of affected) {
    if (aws.backgroundWorkControl && workload === "core") continue;
    const live = await describeTaskDefinition(aws, before.tasks[workload]!);
    const architecture = live?.runtimePlatform?.cpuArchitecture ?? "X86_64";
    const expected = workloadArchitecture(config, workload) === "arm64" ? "ARM64" : "X86_64";
    if (architecture !== expected)
      throw new CliError(
        `cannot rotate secrets while ${workload} uses ${architecture} but its configuration selects ${expected}; set aws.services.${workload}.architecture to match the deployed image or rebuild it with qm up --build-from`,
      );
  }
  if (!baseline.backgroundDeploymentId) return;
  for (const secret of staged.filter((item) =>
    ["DEPLOYMENT_CONTROL_SECRET", "CORE_SIGNING_SECRET"].includes(item.name),
  )) {
    const { SecretString } = await secretsManager(aws).send(new GetSecretValueCommand({ SecretId: secret.id }));
    if ((SecretString ?? "").trim() !== secret.value)
      throw new CliError(
        `${secret.name} cannot be rotated while controlled task cohorts are deployed; coordinated control credential rotation is required`,
      );
  }
}

async function uploadSecrets(aws: AwsConfig, staged: StagedSecret[]): Promise<void> {
  for (const secret of staged) {
    try {
      await secretsManager(aws).send(new PutSecretValueCommand({ SecretId: secret.id, SecretString: secret.value }));
    } catch (error) {
      if (awsErrorCode(error) === "ResourceNotFoundException") {
        throw new CliError(
          `AWS secret container ${secret.id} is missing; apply the rendered Terraform before pushing secrets`,
        );
      }
      throw error;
    }
    step(`${secret.name}: uploaded`);
  }
}

async function registerRotatedTasks(
  config: QmConfig,
  aws: AwsConfig,
  affected: string[],
  before: ServiceSnapshot,
  baseline: DeploymentManifest,
): Promise<Record<string, string>> {
  const arns = await secretArns(config);
  const changed: Record<string, string> = {};
  for (const workload of affected) {
    const live = await describeTaskDefinition(aws, before.tasks[workload]!);
    const container = (live?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.name === workload,
    );
    if (
      !container ||
      typeof container.image !== "string" ||
      !isPinnedWorkloadImage(config, workload, container.image)
    ) {
      throw new CliError(`cannot rotate secrets while ${workload} lacks a trusted digest-pinned image`);
    }
    const desired = renderTaskDefinition(config, workload, container.image, arns, baseline.backgroundDeploymentId);
    if (!taskDefinitionChanges(desired, (live as Record<string, unknown> | undefined) ?? null).length) continue;
    changed[workload] = await registerTaskDefinition(config, desired);
  }
  return changed;
}

async function forceRedeploy(config: QmConfig, aws: AwsConfig, workloads: string[], before: ServiceSnapshot) {
  const forcedDeployments: Record<string, string> = {};
  for (const workload of workloads) {
    const service = aws.services[workload]!.ecsService;
    const updated = await ecs(aws).send(
      new UpdateServiceCommand({ cluster: aws.cluster, service, forceNewDeployment: true }),
    );
    const primary = (updated.service?.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
    if (primary.length !== 1 || !primary[0]?.id)
      throw new CliError(`AWS did not identify the replacement deployment for ${workload}`);
    forcedDeployments[workload] = primary[0].id;
  }
  if (!workloads.length) return;
  await awaitServiceTargets(
    config,
    Object.fromEntries(
      workloads.map((workload) => [
        workload,
        {
          taskDefinition: before.tasks[workload]!,
          desiredCount: before.counts[workload]!,
          deploymentId: forcedDeployments[workload]!,
        },
      ]),
    ),
  );
}

async function activateRotatedSecrets(
  config: QmConfig,
  aws: AwsConfig,
  affected: string[],
  before: ServiceSnapshot,
  baseline: DeploymentManifest,
): Promise<void> {
  const changed = await registerRotatedTasks(config, aws, affected, before, baseline);
  const counts = (workloads: string[]) =>
    Object.fromEntries(workloads.map((workload) => [workload, before.counts[workload]!]));
  let changedApplied = false;
  let rotated = false;
  try {
    if (Object.keys(changed).length) {
      await applyServiceTargets(config, changed, counts(Object.keys(changed)));
      changedApplied = true;
    }
    await forceRedeploy(
      config,
      aws,
      affected.filter((workload) => !changed[workload]),
      before,
    );
    rotated = true;
    if (Object.keys(changed).length) {
      await recordDeploymentManifest(
        aws,
        { ...before.tasks, ...changed },
        {
          ...(baseline.counts ? { counts: baseline.counts } : {}),
          imageLabel: baseline.imageLabel ?? aws.imageLabel,
          ...(baseline.layer ? { layer: baseline.layer } : {}),
          ...(baseline.imageProvenance ? { imageProvenance: baseline.imageProvenance } : {}),
        },
      );
    }
  } catch (error) {
    if (rotated || !changedApplied) throw error;
    const compensationFailures: string[] = [];
    try {
      const restore = Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.tasks[workload]!]));
      await applyServiceTargets(config, restore, counts(Object.keys(changed)));
    } catch (restoreError) {
      compensationFailures.push(`restoring pre-rotation task definitions: ${errMessage(restoreError)}`);
    }
    throwAfterCompensation(error, compensationFailures);
  }
  for (const workload of affected) step(`${workload}: restarted with rotated secrets`);
}

export async function awsSecretsPush(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  validatedSecrets(config);
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  const staged = await stageOperatorSecrets(config, aws, envValues(configDir, envFile));
  await withAwsLease(aws, async () => {
    const baseline = await currentDeploymentManifest(aws);
    if (baseline?.backgroundDeploymentId && !aws.backgroundWorkControl)
      throw new CliError("controlled secret activation cannot fall back to a legacy task definition");
    const states = await describedServices(config, workloads);
    assertOwnedServices(config, states, workloads);
    const before = rotationBaseline(workloads, states, baseline);
    const uploaded = Object.fromEntries(staged.map((secret) => [secret.name, secret.id]));
    const affected = workloads.filter((workload) =>
      workloadSecrets(config, workload, uploaded).some((secret) => uploaded[secret.name]),
    );
    if (baseline && before) await assertRotatable(config, aws, affected, before, baseline, staged);
    await uploadSecrets(aws, staged);
    if (!baseline || !before) {
      if (affected.length) step("secret activation deferred to the first complete AWS deployment");
      return;
    }
    if (aws.backgroundWorkControl && affected.includes("core")) {
      note(
        "core secret activation deferred: pause or hand over background ownership, then run qm up --restart core to allocate a new deployment identity",
      );
      affected.splice(affected.indexOf("core"), 1);
    }
    if (hostsWebEdge(config.services) && runsSeparateWebEdge(Object.keys(baseline.tasks))) {
      step("secret activation deferred until core hosting the web edge is deployed with qm up");
      return;
    }
    await activateRotatedSecrets(config, aws, affected, before, baseline);
  });
  ok("operator secrets uploaded to AWS Secrets Manager");
}
