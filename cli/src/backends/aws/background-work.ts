import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awsText, deployLocksTable, deploymentStateKey, withAwsLease } from "../../aws-lease.ts";
import {
  type BackgroundWorkTransport,
  type BackgroundWorkStatus,
  readBackgroundWork,
  readProductionOwner,
  setBackgroundOwner,
  awaitBackgroundWork,
} from "../../background-work.ts";
import { canonicalJson } from "../../canonical-json.ts";
import { type AwsConfig, type QmConfig } from "../../config.ts";
import { CliError, errMessage, ok } from "../../log.ts";
import { isServiceName } from "../../services.ts";
import { isInvalidSecret, envNum } from "../../util.ts";
import { type EcsServiceState, assertAwsCallerAccount, awsJson, awsTopology, chunks, requireAws } from "./clients.ts";
import { isPinnedWorkloadImage, releaseCandidate } from "./images.ts";
import {
  type DeploymentManifest,
  currentDeploymentManifest,
  manifestTransaction,
  recordDeploymentManifest,
} from "./manifest.ts";
import {
  applyServiceTargets,
  assertOwnedServices,
  awaitServiceTargets,
  describedServices,
  nativeBlueGreenStatus,
  serviceSnapshotFromStates,
  throwAfterCompensation,
} from "./rollout.ts";
import { awsCoreRequest, fetchCore } from "./routing.ts";
import { registerTaskDefinition } from "./task-definitions.ts";

interface BackgroundDeploymentPreparation {
  id: string;
  previousManifestId?: string;
  backgroundDeploymentId: string;
  before: { tasks: Record<string, string>; counts: Record<string, number> };
}

const BACKGROUND_PREPARATION_KEY = "deployment/background-preparation";

export function clearBackgroundPreparation(aws: AwsConfig): void {
  awsText(aws, [
    "dynamodb",
    "transact-write-items",
    "--transact-items",
    JSON.stringify([
      {
        Delete: {
          TableName: deployLocksTable(aws),
          Key: { lockKey: { S: deploymentStateKey(aws, BACKGROUND_PREPARATION_KEY) } },
        },
      },
    ]),
  ]);
}

function assertBackgroundPreparationResolved(
  aws: AwsConfig,
  current: DeploymentManifest | undefined,
  before: BackgroundDeploymentPreparation["before"],
): boolean {
  const response = awsJson<{ Item?: Record<string, { S?: string }> }>(aws, [
    "dynamodb",
    "get-item",
    "--table-name",
    deployLocksTable(aws),
    "--key",
    JSON.stringify({ lockKey: { S: deploymentStateKey(aws, BACKGROUND_PREPARATION_KEY) } }),
    "--consistent-read",
  ]);
  if (!response.Item) return false;
  let preparation: BackgroundDeploymentPreparation;
  try {
    preparation = JSON.parse(response.Item.preparation?.S ?? "");
    if (
      !preparation ||
      typeof preparation.id !== "string" ||
      typeof preparation.backgroundDeploymentId !== "string" ||
      !preparation.before?.tasks ||
      !preparation.before.counts
    )
      throw new Error("invalid preparation");
  } catch {
    throw new CliError("pending background deployment preparation is invalid; refusing a new cohort");
  }
  const committed =
    current?.id === preparation.id &&
    current.backgroundDeploymentId === preparation.backgroundDeploymentId &&
    canonicalJson(before) === canonicalJson({ tasks: current.tasks, counts: current.counts });
  const restored =
    current?.id === preparation.previousManifestId && canonicalJson(before) === canonicalJson(preparation.before);
  if (!committed && !restored)
    throw new CliError(
      `background deployment ${preparation.id} remains unresolved; reconcile its recorded tasks before retrying instead of allocating another cohort`,
    );
  return true;
}

export function reconcileBackgroundPreparation(
  aws: AwsConfig,
  current: DeploymentManifest | undefined,
  before: BackgroundDeploymentPreparation["before"],
): void {
  if (assertBackgroundPreparationResolved(aws, current, before)) clearBackgroundPreparation(aws);
}

export function prepareBackgroundDeployment(aws: AwsConfig, preparation: BackgroundDeploymentPreparation): void {
  awsText(aws, [
    "dynamodb",
    "transact-write-items",
    "--transact-items",
    JSON.stringify([
      {
        Put: {
          TableName: deployLocksTable(aws),
          Item: {
            lockKey: { S: deploymentStateKey(aws, BACKGROUND_PREPARATION_KEY) },
            preparation: { S: JSON.stringify(preparation) },
          },
          ConditionExpression: "attribute_not_exists(lockKey)",
        },
      },
    ]),
  ]);
}

export function taskDefinitionForBackgroundWork(
  task: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  const containers = structuredClone(task.containerDefinitions) as Array<Record<string, unknown>> | undefined;
  const core = containers?.find((container) => container.name === "core");
  if (!core) throw new CliError("core task definition has no core container");
  const secrets = core.secrets as Array<{ name: string }> | undefined;
  if (secrets?.some((entry) => entry.name === "BACKGROUND_WORK_ENABLED")) {
    throw new CliError("BACKGROUND_WORK_ENABLED cannot be changed while supplied as a secret");
  }
  const environment = (core.environment ?? []) as Array<{ name: string; value: string }>;
  core.environment = [
    ...environment.filter((entry) => entry.name !== "BACKGROUND_WORK_ENABLED"),
    { name: "BACKGROUND_WORK_ENABLED", value: enabled ? "1" : "0" },
  ];
  const fields = [
    "family",
    "taskRoleArn",
    "executionRoleArn",
    "networkMode",
    "volumes",
    "placementConstraints",
    "requiresCompatibilities",
    "cpu",
    "memory",
    "pidMode",
    "ipcMode",
    "proxyConfiguration",
    "inferenceAccelerators",
    "ephemeralStorage",
    "runtimePlatform",
    "enableFaultInjection",
  ];
  return {
    ...Object.fromEntries(fields.flatMap((field) => (task[field] == null ? [] : [[field, task[field]]]))),
    containerDefinitions: containers,
  };
}

export function awsBackgroundWorkTransport(
  config: QmConfig,
  path = "/v1/background-work",
  timeoutMs = 30_000,
  maxResponseBytes?: number,
  productionRoute = false,
): BackgroundWorkTransport {
  const aws = requireAws(config);
  const secret = (name: string): string =>
    awsText(aws, [
      "secretsmanager",
      "get-secret-value",
      "--secret-id",
      `${aws.secretsPrefix}${name}`,
      "--query",
      "SecretString",
    ]);
  const signing = secret("CORE_SIGNING_SECRET");
  const control = secret("DEPLOYMENT_CONTROL_SECRET");
  if (isInvalidSecret("CORE_SIGNING_SECRET", signing) || control.trim().length < 32 || control === signing)
    throw new CliError("deployment control requires a distinct secret of at least 32 characters");
  const url = new URL(productionRoute ? (config.apiUrl ?? config.publicUrl) : config.publicUrl);
  if (productionRoute && (url.protocol !== "https:" || url.username || url.password))
    throw new CliError("the production background ownership route must be HTTPS without credentials");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return (method, body = "") => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", signing)
      .update(`v0:${timestamp}:${method}\n${url.pathname}\n${body}`)
      .digest("hex");
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(timestamp),
        "x-signature": `v0=${signature}`,
        authorization: `Bearer ${control}`,
      },
      ...(method === "POST" ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    };
    return productionRoute
      ? fetchCore(url, init, maxResponseBytes ?? 65_536)
      : awsCoreRequest(config, url, init, maxResponseBytes);
  };
}

interface AwsBackgroundCohort {
  deploymentId: string;
  taskArns: string[];
  manifest: DeploymentManifest;
}

export async function awsBackgroundWorkBootState(
  config: QmConfig,
): Promise<{ enabled: boolean; deploymentId?: string } | undefined> {
  const aws = requireAws(config);
  await assertAwsCallerAccount(aws);
  const manifest = await currentDeploymentManifest(aws);
  const taskDefinition = manifest?.tasks.core;
  if (!taskDefinition) return undefined;
  const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
    "ecs",
    "describe-task-definition",
    "--task-definition",
    taskDefinition,
  ]).taskDefinition;
  const containers = task?.containerDefinitions as Array<Record<string, unknown>> | undefined;
  const core = containers?.filter((container) => container.name === "core");
  if (core?.length !== 1) throw new CliError("recorded task definition must contain exactly one core container");
  const secrets = (core[0]!.secrets ?? []) as Array<{ name: string }>;
  if (secrets.some((secret) => secret.name === "BACKGROUND_WORK_ENABLED" || secret.name === "BACKGROUND_DEPLOYMENT_ID"))
    throw new CliError("recorded background boot settings cannot be supplied as secrets");
  const environment = (core[0]!.environment ?? []) as Array<{ name: string; value: string }>;
  const identities = environment.filter((entry) => entry.name === "BACKGROUND_DEPLOYMENT_ID");
  if (
    manifest.backgroundDeploymentId
      ? identities.length !== 1 || identities[0]!.value !== manifest.backgroundDeploymentId
      : identities.length !== 0
  )
    throw new CliError("recorded core task does not match the manifest background deployment identity");
  const flags = environment.filter((entry) => entry.name === "BACKGROUND_WORK_ENABLED");
  if (flags.length !== 1 || !["0", "1"].includes(flags[0]!.value))
    throw new CliError("recorded core task must contain one explicit BACKGROUND_WORK_ENABLED value of 0 or 1");
  return {
    enabled: flags[0]!.value === "1",
    ...(manifest.backgroundDeploymentId ? { deploymentId: manifest.backgroundDeploymentId } : {}),
  };
}

async function awsBackgroundCohort(
  config: QmConfig,
  configDir: string,
  candidatePath?: string,
  waitForReady = true,
): Promise<AwsBackgroundCohort> {
  const { aws, workloads } = awsTopology(config, configDir);
  if (!aws.backgroundWorkControl)
    throw new CliError("background ownership control is not enabled in the AWS configuration");
  const manifest = await currentDeploymentManifest(aws);
  if (!manifest?.backgroundDeploymentId)
    throw new CliError("background ownership requires a manifest-bound deployment identity");
  const candidate = candidatePath ? releaseCandidate(config, candidatePath) : undefined;
  const states = await describedServices(config, workloads);
  assertOwnedServices(config, states, workloads);
  const before = serviceSnapshotFromStates(states, workloads);
  for (const workload of workloads) {
    if (manifest.tasks[workload] !== before.tasks[workload] || manifest.counts?.[workload] !== before.counts[workload])
      throw new CliError(`cannot control background work while ${workload} differs from the deployment manifest`);
    const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
      "ecs",
      "describe-task-definition",
      "--task-definition",
      before.tasks[workload]!,
    ]).taskDefinition;
    const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.name === workload,
    );
    if (typeof container?.image !== "string" || !isPinnedWorkloadImage(config, workload, container.image))
      throw new CliError(`${workload} does not have a trusted digest-pinned image`);
    if (
      candidate &&
      (container.image !== candidate.images[workload] ||
        !candidate.imageProvenance[workload] ||
        canonicalJson(candidate.imageProvenance[workload]) !== canonicalJson(manifest.imageProvenance?.[workload]))
    )
      throw new CliError(`${workload} does not match the expected release candidate`);
    if (workload === "core") {
      const environment = (container.environment ?? []) as Array<{ name: string; value: string }>;
      if (
        environment.find((entry) => entry.name === "BACKGROUND_DEPLOYMENT_ID")?.value !==
        manifest.backgroundDeploymentId
      )
        throw new CliError("core task definition does not match the recorded background deployment identity");
    }
  }
  const count = before.counts.core;
  if (!count) throw new CliError("background ownership requires running core capacity");
  if (waitForReady)
    await awaitServiceTargets(config, {
      core: { taskDefinition: before.tasks.core!, desiredCount: count },
    });
  const taskArns =
    awsJson<{ taskArns?: string[] }>(aws, [
      "ecs",
      "list-tasks",
      "--cluster",
      aws.cluster,
      "--service-name",
      aws.services.core!.ecsService,
      "--desired-status",
      "RUNNING",
    ]).taskArns ?? [];
  const tasks = chunks(taskArns, 100).flatMap((batch) => {
    const response = awsJson<{
      tasks?: Array<{ taskArn?: string; taskDefinitionArn?: string; lastStatus?: string; healthStatus?: string }>;
      failures?: unknown[];
    }>(aws, ["ecs", "describe-tasks", "--cluster", aws.cluster, "--tasks", ...batch]);
    if (response.failures?.length) throw new CliError("cannot prove every running core task identity");
    return response.tasks ?? [];
  });
  const current = tasks.filter(
    (task) =>
      task.taskDefinitionArn === before.tasks.core && task.lastStatus === "RUNNING" && task.healthStatus === "HEALTHY",
  );
  if (
    current.length !== count ||
    current.some((task) => !task.taskArn) ||
    new Set(current.map((task) => task.taskArn)).size !== count
  )
    throw new CliError("core does not have the exact healthy task cohort recorded in its deployment manifest");
  return { deploymentId: manifest.backgroundDeploymentId, taskArns: current.map((task) => task.taskArn!), manifest };
}

export async function awsBackgroundWorkStatus(
  config: QmConfig,
  configDir: string,
  candidatePath?: string,
): Promise<{
  status: BackgroundWorkStatus;
  deploymentId: string;
  taskArns: string[];
  manifestId: string;
}> {
  await assertAwsCallerAccount(requireAws(config));
  const cohort = await awsBackgroundCohort(config, configDir, candidatePath);
  const status = await readBackgroundWork(awsBackgroundWorkTransport(config), cohort.deploymentId);
  return { status, deploymentId: cohort.deploymentId, taskArns: cohort.taskArns, manifestId: cohort.manifest.id };
}

export interface AwsBackgroundWorkCapacity {
  manifestId: string;
  deploymentId: string;
  ownerDeploymentId: string;
  workloads: Record<string, { taskDefinition: string; deploymentId: string; desiredCount: number; taskArns: string[] }>;
}

async function stableWorkloadCapacity(
  config: QmConfig,
  workload: string,
  state: EcsServiceState,
  taskDefinition: string,
  desiredCount: number | undefined,
): Promise<AwsBackgroundWorkCapacity["workloads"][string]> {
  const aws = requireAws(config);
  const primary = state.deployments?.filter((deployment) => deployment.status === "PRIMARY") ?? [];
  const deployment = primary[0];
  if (
    typeof desiredCount !== "number" ||
    !Number.isSafeInteger(desiredCount) ||
    desiredCount < 0 ||
    state.status !== "ACTIVE" ||
    state.taskDefinition !== taskDefinition ||
    state.desiredCount !== desiredCount ||
    state.runningCount !== desiredCount ||
    state.pendingCount !== 0 ||
    primary.length !== 1 ||
    !deployment?.id ||
    deployment.taskDefinition !== taskDefinition ||
    deployment.runningCount !== desiredCount ||
    state.deployments?.some((item) => item.pendingCount !== 0 || (item !== deployment && item.runningCount !== 0)) ||
    (state.deploymentConfiguration?.strategy === "BLUE_GREEN"
      ? (await nativeBlueGreenStatus(config, workload, taskDefinition)) !== "SUCCESSFUL"
      : deployment.rolloutState !== "COMPLETED")
  )
    throw new CliError(`${workload} has not reached stable deployment capacity`);
  const listed = new Set<string>();
  for (const desiredStatus of ["RUNNING", "STOPPED"]) {
    const response = awsJson<{ taskArns?: string[] }>(aws, [
      "ecs",
      "list-tasks",
      "--cluster",
      aws.cluster,
      "--service-name",
      aws.services[workload]!.ecsService,
      "--desired-status",
      desiredStatus,
    ]);
    if (!Array.isArray(response.taskArns) || response.taskArns.some((arn) => typeof arn !== "string" || !arn))
      throw new CliError(`${workload} task inventory is unavailable`);
    for (const arn of response.taskArns) listed.add(arn);
  }
  const live: string[] = [];
  for (const batch of chunks([...listed], 100)) {
    const response = awsJson<{
      tasks?: Array<{
        taskArn?: string;
        taskDefinitionArn?: string;
        lastStatus?: string;
        desiredStatus?: string;
        healthStatus?: string;
      }>;
      failures?: unknown[];
    }>(aws, ["ecs", "describe-tasks", "--cluster", aws.cluster, "--tasks", ...batch]);
    if (
      response.failures?.length ||
      !Array.isArray(response.tasks) ||
      response.tasks.length !== batch.length ||
      new Set(response.tasks.map((task) => task.taskArn)).size !== batch.length ||
      response.tasks.some((task) => !task.taskArn || !batch.includes(task.taskArn))
    )
      throw new CliError(`${workload} capacity requires complete task inventory`);
    for (const task of response.tasks) {
      if (task.lastStatus === "STOPPED") continue;
      if (
        task.lastStatus !== "RUNNING" ||
        task.desiredStatus !== "RUNNING" ||
        task.taskDefinitionArn !== taskDefinition ||
        (task.healthStatus !== "HEALTHY" && (isServiceName(workload) || task.healthStatus !== "UNKNOWN"))
      )
        throw new CliError(`${workload} still has a pending, unhealthy, or retiring task`);
      live.push(task.taskArn!);
    }
  }
  if (live.length !== desiredCount) throw new CliError(`${workload} does not have its exact stable task cohort`);
  return { taskDefinition, deploymentId: deployment.id, desiredCount, taskArns: live.sort() };
}

export async function awsBackgroundWorkCapacity(
  config: QmConfig,
  configDir: string,
  candidatePath?: string,
): Promise<AwsBackgroundWorkCapacity> {
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  const cohort = await awsBackgroundCohort(config, configDir, candidatePath, false);
  const transport = awsBackgroundWorkTransport(config);
  const ownership = await readBackgroundWork(transport, cohort.deploymentId);
  if (!ownership.ownerDeploymentId || ownership.ownerDeploymentId === cohort.deploymentId)
    throw new CliError("capacity requires background ownership held by another deployment");
  const states = await describedServices(config, workloads);
  assertOwnedServices(config, states, workloads);
  const snapshot = serviceSnapshotFromStates(states, workloads);
  assertBackgroundPreparationResolved(aws, cohort.manifest, snapshot);
  const proof: AwsBackgroundWorkCapacity = {
    manifestId: cohort.manifest.id,
    deploymentId: cohort.deploymentId,
    ownerDeploymentId: ownership.ownerDeploymentId,
    workloads: {},
  };
  for (const workload of [...workloads].sort()) {
    proof.workloads[workload] = await stableWorkloadCapacity(
      config,
      workload,
      states.get(workload)!,
      cohort.manifest.tasks[workload]!,
      cohort.manifest.counts?.[workload],
    );
  }
  if (canonicalJson(proof.workloads.core?.taskArns) !== canonicalJson([...cohort.taskArns].sort()))
    throw new CliError("core task cohort changed while checking capacity");
  const finalManifest = await currentDeploymentManifest(aws);
  if (canonicalJson(finalManifest) !== canonicalJson(cohort.manifest))
    throw new CliError("deployment manifest changed while checking capacity");
  assertBackgroundPreparationResolved(aws, finalManifest, snapshot);
  const finalOwnership = await readBackgroundWork(transport, cohort.deploymentId);
  if (finalOwnership.ownerDeploymentId !== proof.ownerDeploymentId)
    throw new CliError("background ownership changed while checking capacity");
  return proof;
}

export async function awsStoppedCoreOwner(
  config: QmConfig,
  deploymentId: string,
): Promise<BackgroundWorkStatus | undefined> {
  const state = (await describedServices(config, ["core"])).get("core");
  if (!state || state.desiredCount !== 0) return undefined;
  await stableWorkloadCapacity(config, "core", state, state.taskDefinition ?? "", 0);
  return readProductionOwner(awsBackgroundWorkTransport(config, undefined, undefined, undefined, true), deploymentId);
}

export async function assertNotBackgroundOwner(
  config: QmConfig,
  current: DeploymentManifest | undefined,
): Promise<void> {
  if (!current?.backgroundDeploymentId) return;
  if (await awsStoppedCoreOwner(config, current.backgroundDeploymentId)) return;
  const status = await readBackgroundWork(awsBackgroundWorkTransport(config), current.backgroundDeploymentId);
  if (status.ownerDeploymentId === current.backgroundDeploymentId)
    throw new CliError("hand background ownership to another deployment before replacing the current core tasks");
}

export async function awsSetBackgroundWork(
  config: QmConfig,
  configDir: string,
  enabled: boolean,
  candidatePath?: string,
  expectedOwnership?: Pick<BackgroundWorkStatus, "ownerDeploymentId">,
): Promise<BackgroundWorkStatus | undefined> {
  const { aws, workloads } = awsTopology(config, configDir);
  if (!workloads.includes("core")) throw new CliError("background work requires the core workload");
  const candidate = candidatePath ? releaseCandidate(config, candidatePath) : undefined;
  await assertAwsCallerAccount(aws);
  const confirmed = await withAwsLease(aws, async () => {
    const current = await currentDeploymentManifest(aws);
    if (!current) throw new CliError("background work requires a recorded deployment");
    const states = await describedServices(config, workloads);
    assertOwnedServices(config, states, workloads);
    const before = serviceSnapshotFromStates(states, workloads);
    for (const workload of workloads) {
      if (
        current.tasks[workload] !== before.tasks[workload] ||
        current.counts?.[workload] !== before.counts[workload]
      ) {
        throw new CliError(`cannot change background work while ${workload} differs from the deployment manifest`);
      }
    }
    if (!before.counts.core) throw new CliError("cannot change background work while core is scaled down");
    let coreTask: Record<string, unknown> | undefined;
    for (const workload of candidate ? workloads : ["core"]) {
      const task = awsJson<{ taskDefinition?: Record<string, unknown> }>(aws, [
        "ecs",
        "describe-task-definition",
        "--task-definition",
        before.tasks[workload]!,
      ]).taskDefinition;
      const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
        (item) => item.name === workload,
      );
      if (!task || typeof container?.image !== "string" || !isPinnedWorkloadImage(config, workload, container.image)) {
        throw new CliError(`${workload} does not have a trusted digest-pinned image`);
      }
      if (
        candidate &&
        (container.image !== candidate.images[workload] ||
          !candidate.imageProvenance[workload] ||
          canonicalJson(candidate.imageProvenance[workload]) !== canonicalJson(current.imageProvenance?.[workload]))
      ) {
        throw new CliError(`${workload} does not match the expected release candidate`);
      }
      if (workload === "core") coreTask = task;
    }
    if (aws.backgroundWorkControl) {
      const cohort = await awsBackgroundCohort(config, configDir, candidatePath);
      const transport = awsBackgroundWorkTransport(config);
      const status = await readBackgroundWork(transport, cohort.deploymentId);
      if (expectedOwnership && status.ownerDeploymentId !== expectedOwnership.ownerDeploymentId)
        throw new CliError("background ownership changed since promotion; refusing automatic compensation");
      if (!enabled && status.ownerDeploymentId !== null && status.ownerDeploymentId !== cohort.deploymentId)
        throw new CliError("cannot disable background work on a different deployment's current owner");
      const ownerDeploymentId = enabled ? cohort.deploymentId : null;
      if (status.ownerDeploymentId !== ownerDeploymentId)
        await setBackgroundOwner(transport, cohort.deploymentId, {
          ownerDeploymentId,
          expectedOwnerDeploymentId: status.ownerDeploymentId,
        });
      return awaitBackgroundWork(
        transport,
        cohort.deploymentId,
        { ownerDeploymentId, active: enabled, instances: cohort.taskArns.length },
        { timeoutMs: envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 30 * 60_000), pollMs: 1000 },
      );
    }
    if (expectedOwnership) throw new CliError("ownership preconditions require controlled background work");
    if (current.backgroundDeploymentId)
      throw new CliError("controlled background work cannot fall back to task replacement");
    const desired = taskDefinitionForBackgroundWork(coreTask!, enabled);
    const core = (coreTask!.containerDefinitions as Array<Record<string, unknown>>).find(
      (item) => item.name === "core",
    )!;
    const environment = (core.environment ?? []) as Array<{ name: string; value: string }>;
    const currentFlag = environment.find((entry) => entry.name === "BACKGROUND_WORK_ENABLED")?.value;
    const timeoutMs = envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 30 * 60_000);
    if (currentFlag === (enabled ? "1" : "0")) {
      await awaitServiceTargets(
        config,
        {
          core: { taskDefinition: before.tasks.core!, desiredCount: before.counts.core },
        },
        timeoutMs,
      );
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "qm-background-work-"));
    try {
      const file = join(dir, "core.json");
      writeFileSync(file, JSON.stringify(desired));
      const target = await registerTaskDefinition(config, file);
      await applyServiceTargets(config, { core: target }, { core: before.counts.core }, { timeoutMs });
      try {
        await recordDeploymentManifest(
          aws,
          { ...before.tasks, core: target },
          {
            counts: current.counts,
            imageLabel: current.imageLabel,
            dbRestorePoint: current.dbRestorePoint,
            layer: current.layer,
            imageProvenance: current.imageProvenance,
          },
        );
      } catch (error) {
        const failures: string[] = [];
        try {
          await applyServiceTargets(config, { core: before.tasks.core! }, { core: before.counts.core }, { timeoutMs });
          await manifestTransaction(aws, current, current.id);
        } catch (restoreError) {
          failures.push(`restoring background work: ${errMessage(restoreError)}`);
        }
        throwAfterCompensation(error, failures);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  ok(`background work ${enabled ? "enabled" : "disabled"}`);
  return confirmed;
}
