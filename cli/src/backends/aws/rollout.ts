import {
  DescribeServicesCommand,
  RunTaskCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTasksCommand,
  type NetworkConfiguration,
  StopTaskCommand,
  ListServiceDeploymentsCommand,
  DescribeServiceRevisionsCommand,
  type ServiceDeploymentBrief,
  DescribeTaskDefinitionCommand,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync, existsSync, statSync, accessSync, constants, linkSync } from "node:fs";
import { isAbsolute, dirname } from "node:path";
import { withAwsLease } from "../../aws-lease.ts";
import { type QmConfig, type AwsConfig } from "../../config.ts";
import { CliError, note, header, step, ok, warn, errMessage } from "../../log.ts";
import { envNum, sleep } from "../../util.ts";
import {
  type AwsUpOpts,
  ECS_SERVICE_BATCH_SIZE,
  type EcsServiceState,
  assertAwsCallerAccount,
  awsTopology,
  chunks,
  ecs,
  requireAws,
  runningTaskArns,
} from "./clients.ts";
import { isPinnedWorkloadImage, releaseCandidate } from "./images.ts";
import { type DeploymentManifest, assertPredeployDbRestorePoint, currentDeploymentManifest } from "./manifest.ts";
import { registerTaskDefinition, renderTaskDefinition, secretArns } from "./task-definitions.ts";

export async function awsMigrateCandidate(config: QmConfig, configDir: string, candidatePath: string): Promise<void> {
  const { aws, workloads } = awsTopology(config, configDir);
  if (!workloads.includes("core")) throw new CliError("AWS migrations require the core workload");
  const candidate = releaseCandidate(config, candidatePath);
  const coreImage = candidate.images.core;
  if (!coreImage) throw new CliError(`AWS release candidate ${candidatePath} does not contain core`);
  await assertAwsCallerAccount(aws);
  await withAwsLease(aws, async () => {
    if (aws.predeployDbSnapshot === false)
      note("pre-migration database restore point: disabled (aws.predeployDbSnapshot)");
    else await assertPredeployDbRestorePoint(config);
    await runAwsCandidateMigration(config, coreImage, candidate.label);
  });
}

export async function runAwsCandidateMigration(
  config: QmConfig,
  coreImage: string,
  label: string,
  existingTaskDefinition?: string,
): Promise<void> {
  const aws = requireAws(config);
  const spec = aws.services.core;
  if (!spec) throw new CliError("AWS migrations require the core workload");
  const service = await ecs(aws).send(
    new DescribeServicesCommand({ cluster: aws.cluster, services: [spec.ecsService] }),
  );
  if (service.failures?.length || service.services?.[0]?.status !== "ACTIVE") {
    throw new CliError(`AWS core service ${spec.ecsService} is not active`);
  }
  const live = service.services[0]!;
  const network = live.networkConfiguration?.awsvpcConfiguration;
  if (
    live.launchType !== "FARGATE" ||
    !network?.subnets?.length ||
    !network.securityGroups?.length ||
    (network.assignPublicIp !== "ENABLED" && network.assignPublicIp !== "DISABLED")
  ) {
    throw new CliError(`AWS core service ${spec.ecsService} does not expose a reusable Fargate network configuration`);
  }
  let taskDefinition: string | undefined;
  try {
    if (existingTaskDefinition) {
      taskDefinition = existingTaskDefinition;
    } else {
      const definition = renderTaskDefinition(config, "core", coreImage, await secretArns(config));
      const container = definition.containerDefinitions.find((candidate) => candidate.name === "core");
      if (!container) throw new CliError("AWS migration task definition has no core container");
      delete container.healthCheck;
      taskDefinition = await registerTaskDefinition(config, definition);
    }
    header(`qm migrate — ${config.orgId} (AWS candidate ${label})`);
    const started = await ecs(aws).send(
      new RunTaskCommand({
        cluster: aws.cluster,
        taskDefinition,
        launchType: "FARGATE",
        platformVersion: live.platformVersion,
        networkConfiguration: { awsvpcConfiguration: network },
        overrides: { containerOverrides: [{ name: "core", command: ["node", "src/migrate-main.ts"] }] },
        startedBy: "qm-migration",
      }),
    );
    const taskArn = started.tasks?.[0]?.taskArn;
    if (!taskArn || started.failures?.length) {
      const failures = started.failures
        ?.map((failure) => `${failure.arn ?? "unknown"}: ${failure.reason ?? failure.detail ?? "unknown"}`)
        .join(", ");
      throw new CliError(`AWS could not start the migration task${failures ? ` (${failures})` : ""}`);
    }
    step(`migration task: ${taskArn}`);
    await awaitEcsTaskExit(aws, taskArn, "migration", {
      deadlineMs: envNum("QM_AWS_MIGRATION_DEADLINE_MS", envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 30 * 60_000)),
      stopOnTimeout: true,
    });
    ok(`candidate ${label} migrations applied`);
  } finally {
    if (taskDefinition && !existingTaskDefinition) {
      try {
        await ecs(aws).send(new DeregisterTaskDefinitionCommand({ taskDefinition }));
      } catch (error) {
        warn(`could not deregister migration task definition ${taskDefinition}: ${errMessage(error)}`);
      }
    }
  }
}

export async function awsLiveSession(config: QmConfig, core: EcsServiceState): Promise<void> {
  const aws = requireAws(config);
  if (!core.taskDefinition) throw new Error("core service has no live task definition");
  if (!core.networkConfiguration?.awsvpcConfiguration) throw new Error("core service has no VPC network configuration");
  const taskArns = await runningTaskArns(aws, aws.services.core!.ecsService);
  if (!taskArns.length) throw new Error("core service has no running tasks for the private canary");
  let address: string | undefined;
  for (let offset = 0; offset < taskArns.length && !address; offset += 100) {
    const { tasks = [] } = await ecs(aws).send(
      new DescribeTasksCommand({ cluster: aws.cluster, tasks: taskArns.slice(offset, offset + 100) }),
    );
    address = tasks
      .filter(
        (task) =>
          task.taskDefinitionArn === core.taskDefinition &&
          task.lastStatus === "RUNNING" &&
          task.healthStatus !== "UNHEALTHY",
      )
      .flatMap((task) => task.containers?.filter((container) => container.name === "core") ?? [])
      .flatMap((container) => container.networkInterfaces ?? [])
      .find((network) => network.privateIpv4Address)?.privateIpv4Address;
  }
  if (!address) throw new Error("core service has no current running task with a private IPv4 address");
  const started = await ecs(aws).send(
    new RunTaskCommand({
      cluster: aws.cluster,
      taskDefinition: core.taskDefinition,
      launchType: "FARGATE",
      networkConfiguration: core.networkConfiguration as NetworkConfiguration,
      overrides: {
        containerOverrides: [
          {
            name: "core",
            command: ["node", "src/deployment/postdeploy-smoke.ts", "session", `http://${address}:8080`],
          },
        ],
      },
      count: 1,
    }),
  );
  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const failure = started.failures?.[0];
    throw new Error(
      `could not start canary task: ${failure?.reason ?? failure?.detail ?? failure?.arn ?? "no task returned"}`,
    );
  }
  await awaitEcsTaskExit(aws, taskArn, "canary");
}

async function awaitEcsTaskExit(
  aws: AwsConfig,
  taskArn: string,
  kind: string,
  options: { deadlineMs?: number; stopOnTimeout?: boolean } = {},
): Promise<void> {
  const pollMs = envNum("QM_AWS_ROLLOUT_POLL_MS", 5_000);
  const deadline = Date.now() + (options.deadlineMs ?? envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 30 * 60_000));
  for (;;) {
    const described = await ecs(aws).send(new DescribeTasksCommand({ cluster: aws.cluster, tasks: [taskArn] }));
    const task = described.tasks?.[0];
    const failures = (described.failures ?? []).map((failure) => failure.reason ?? "unknown");
    if (failures.some((reason) => reason !== "MISSING")) {
      throw new CliError(`AWS ${kind} task ${taskArn} failed (${failures.join(", ")})`);
    }
    if (task?.lastStatus === "STOPPED") {
      const core = task.containers?.find((container) => container.name === "core");
      if (core?.exitCode === 0) return;
      throw new CliError(
        `AWS ${kind} task ${taskArn} exited ${core?.exitCode ?? "without a code"}: ${[core?.reason, task.stoppedReason].filter(Boolean).join("; ") || "unknown reason"}`,
      );
    }
    if (Date.now() > deadline) {
      if (options.stopOnTimeout && task) {
        try {
          await ecs(aws).send(
            new StopTaskCommand({
              cluster: aws.cluster,
              task: taskArn,
              reason: `qm deploy stopped waiting for the ${kind} task`,
            }),
          );
        } catch (stopError) {
          warn(`could not stop ${kind} task ${taskArn}: ${errMessage(stopError)}`);
        }
        throw new CliError(
          `AWS ${kind} task did not finish before the deadline and was stopped. A migration task usually waits on the ` +
            "qm:schema-migrations advisory lock; check pg_locks for another session holding it (for example an " +
            "operator index build) before redeploying.",
        );
      }
      throw new CliError(
        task
          ? `timed out waiting for the AWS ${kind} task; ${taskArn} is still ${task.lastStatus ?? "unknown"} and was left running`
          : `timed out waiting for the AWS ${kind} task; ECS still does not list ${taskArn}`,
      );
    }
    await sleep(pollMs);
  }
}

export async function describedServices(config: QmConfig, workloads: string[]): Promise<Map<string, EcsServiceState>> {
  const aws = requireAws(config);
  const byEcsName = new Map(workloads.map((name) => [aws.services[name]!.ecsService, name]));
  const out = new Map<string, EcsServiceState>();
  const failures: string[] = [];
  for (const batch of chunks([...byEcsName.keys()], ECS_SERVICE_BATCH_SIZE)) {
    const response = await ecs(aws).send(
      new DescribeServicesCommand({ cluster: aws.cluster, include: ["TAGS"], services: batch }),
    );
    for (const service of response.services ?? []) {
      const workload = service.serviceName ? byEcsName.get(service.serviceName) : undefined;
      if (workload) out.set(workload, service);
    }
    for (const failure of response.failures ?? []) {
      failures.push(`${failure.arn ?? "unknown service"}: ${failure.reason ?? failure.detail ?? "describe failed"}`);
    }
  }
  for (const workload of workloads) {
    if (!out.has(workload))
      failures.push(`${aws.services[workload]!.ecsService}: missing from DescribeServices response`);
  }
  if (failures.length)
    throw new CliError(`could not describe AWS services:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  return out;
}

export async function nativeBlueGreenStatus(
  config: QmConfig,
  workload: string,
  taskDefinition: string | undefined,
): Promise<string | undefined> {
  if (!taskDefinition) return undefined;
  const aws = requireAws(config);
  const listed = await ecs(aws).send(
    new ListServiceDeploymentsCommand({ cluster: aws.cluster, service: aws.services[workload]!.ecsService }),
  );
  const deployments = listed.serviceDeployments ?? [];
  const revisionArns = deployments.flatMap((deployment) =>
    deployment.targetServiceRevisionArn ? [deployment.targetServiceRevisionArn] : [],
  );
  if (!revisionArns.length) return undefined;
  const described = await ecs(aws).send(new DescribeServiceRevisionsCommand({ serviceRevisionArns: revisionArns }));
  const tasksByRevision = new Map(
    (described.serviceRevisions ?? []).flatMap((revision) =>
      revision.serviceRevisionArn && revision.taskDefinition
        ? [[revision.serviceRevisionArn, revision.taskDefinition] as const]
        : [],
    ),
  );
  const timestamp = (deployment: ServiceDeploymentBrief): number => new Date(deployment.createdAt ?? 0).getTime() || 0;
  return deployments
    .filter(
      (deployment) =>
        deployment.targetServiceRevisionArn &&
        tasksByRevision.get(deployment.targetServiceRevisionArn) === taskDefinition,
    )
    .sort((a, b) => timestamp(b) - timestamp(a))[0]?.status;
}

export function assertOwnedServices(config: QmConfig, states: Map<string, EcsServiceState>, workloads: string[]): void {
  for (const workload of workloads) {
    const service = states.get(workload)!;
    const tags = Object.fromEntries(
      (service.tags ?? []).flatMap((tag) => (tag.key && tag.value ? [[tag.key, tag.value] as const] : [])),
    );
    if (tags["Deployment"] !== config.orgId || tags["ManagedBy"] !== "terraform") {
      throw new CliError(
        `refusing to mutate ${service.serviceName ?? workload}: ownership tags do not match deployment ${config.orgId}`,
      );
    }
  }
}

interface RolloutTarget {
  taskDefinition: string;
  desiredCount: number;
  deploymentId?: string;
}

export async function awaitServiceTargets(
  config: QmConfig,
  expected: Record<string, RolloutTarget>,
  timeoutMs?: number,
): Promise<void> {
  const pollMs = envNum("QM_AWS_ROLLOUT_POLL_MS", 15_000);
  const deadline = Date.now() + (timeoutMs ?? envNum("QM_AWS_ROLLOUT_DEADLINE_MS", 20 * 60_000));
  let failurePolls = new Map<string, number>();
  let describeFailures = 0;
  const failing = new Map<string, { polls: number; baseRunning: number }>();
  for (;;) {
    let states: ReadonlyMap<string, EcsServiceState>;
    let nativeStatuses: ReadonlyMap<string, string | undefined>;
    try {
      states = await describedServices(config, Object.keys(expected));
      const statuses = new Map<string, string | undefined>();
      for (const [workload, want] of Object.entries(expected))
        if (states.get(workload)?.deploymentConfiguration?.strategy === "BLUE_GREEN")
          statuses.set(workload, await nativeBlueGreenStatus(config, workload, want.taskDefinition));
      nativeStatuses = statuses;
      describeFailures = 0;
    } catch (error) {
      describeFailures += 1;
      if (describeFailures > 2 || Date.now() > deadline) throw error;
      note(`could not poll AWS services (${errMessage(error)}); retrying`);
      await sleep(pollMs);
      continue;
    }
    const failures: Array<{ identity: string; message: string }> = [];
    const fail = (workload: string, kind: string, message: string): void =>
      void failures.push({ identity: `${workload}:${kind}`, message });
    const waiting: string[] = [];
    const failingNow = new Set<string>();
    for (const [workload, want] of Object.entries(expected)) {
      const state = states.get(workload)!;
      const primary = (state.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
      const deployment = primary[0];
      const running = deployment?.runningCount ?? 0;
      if (state.status !== "ACTIVE") {
        fail(workload, "service-status", `${workload}: service is ${state.status ?? "missing"}`);
      } else if (
        state.taskDefinition !== want.taskDefinition ||
        primary.length !== 1 ||
        deployment?.taskDefinition !== want.taskDefinition
      ) {
        fail(
          workload,
          "task-definition",
          `${workload}: requested task definition is not the sole PRIMARY deployment (service runs ${state.taskDefinition ?? "no task"} — an ECS circuit-breaker rollback or a concurrent deploy)`,
        );
      } else if (want.deploymentId !== undefined && deployment.id !== want.deploymentId) {
        fail(
          workload,
          "deployment-id",
          `${workload}: PRIMARY deployment is ${deployment.id ?? "unknown"}, expected ${want.deploymentId}`,
        );
      } else if (deployment.rolloutState === "FAILED") {
        fail(
          workload,
          "rollout-failed",
          `${workload}: PRIMARY rollout is FAILED (failedTasks=${deployment.failedTasks ?? 0} — an ECS circuit-breaker abort)`,
        );
      } else if (state.desiredCount !== want.desiredCount) {
        fail(
          workload,
          "desired-count",
          `${workload}: ${state.desiredCount ?? 0} desired, expected ${want.desiredCount}`,
        );
      } else if ((deployment.failedTasks ?? 0) > 0 && running < want.desiredCount) {
        failingNow.add(workload);
        const tracked = failing.get(workload);
        if (!tracked || running > tracked.baseRunning) failing.set(workload, { polls: 1, baseRunning: running });
        else tracked.polls += 1;
        const streak = failing.get(workload)!;
        if (streak.polls >= 4) {
          fail(
            workload,
            "failed-tasks",
            `${workload}: PRIMARY deployment keeps failing tasks with no replacement starting (failedTasks=${deployment.failedTasks}, ${running}/${want.desiredCount} running across ${streak.polls} polls)`,
          );
        } else {
          waiting.push(
            `${workload} (${running}/${want.desiredCount}, ${deployment.failedTasks} failed; awaiting replacement)`,
          );
        }
      } else if (running < want.desiredCount) {
        waiting.push(`${workload} (${running}/${want.desiredCount})`);
      } else if (state.deploymentConfiguration?.strategy === "BLUE_GREEN") {
        const nativeStatus = nativeStatuses.get(workload);
        if (nativeStatus === "SUCCESSFUL") continue;
        if (nativeStatus && nativeStatus !== "PENDING" && nativeStatus !== "IN_PROGRESS") {
          fail(workload, "native-blue-green", `${workload}: native blue/green deployment is ${nativeStatus}`);
        } else {
          waiting.push(`${workload} (blue/green traffic shift or bake is still in progress)`);
        }
      } else if (
        deployment.rolloutState !== "COMPLETED" ||
        (state.deployments ?? []).some((item) => item !== deployment && (item.runningCount ?? 0) > 0)
      ) {
        waiting.push(`${workload} (prior tasks are still stopping)`);
      }
    }
    for (const workload of failing.keys()) {
      if (!failingNow.has(workload)) failing.delete(workload);
    }
    if (failures.length) {
      const next = new Map<string, number>();
      const confirmed: string[] = [];
      for (const failure of failures) {
        const polls = (failurePolls.get(failure.identity) ?? 0) + 1;
        next.set(failure.identity, polls);
        if (polls >= 2) confirmed.push(failure.message);
      }
      failurePolls = next;
      if (confirmed.length || Date.now() > deadline) {
        const fatal = confirmed.length ? confirmed : failures.map((failure) => failure.message);
        throw new CliError(
          `AWS deployment did not reach the requested state:\n${fatal.map((failure) => `  - ${failure}`).join("\n")}`,
        );
      }
      note(`possible rollout failure; confirming: ${failures.map((failure) => failure.message).join("; ")}`);
      await sleep(pollMs);
      continue;
    }
    failurePolls = new Map();
    if (waiting.length === 0) return;
    if (Date.now() > deadline) {
      throw new CliError(`timed out waiting for the AWS rollout: ${waiting.join(", ")}`);
    }
    note(`waiting on ${waiting.join(", ")}`);
    await sleep(pollMs);
  }
}

export function throwAfterCompensation(error: unknown, failures: string[]): never {
  if (failures.length) throw new CliError(`${errMessage(error)}; compensation also failed (${failures.join("; ")})`);
  throw error;
}

export function workloadDesiredCount(config: QmConfig, workload: string): number {
  return requireAws(config).services[workload]?.desiredCount ?? 1;
}

export interface ServiceSnapshot {
  tasks: Record<string, string>;
  counts: Record<string, number>;
}

export async function serviceSnapshot(config: QmConfig, workloads: string[]): Promise<ServiceSnapshot> {
  return serviceSnapshotFromStates(await describedServices(config, workloads), workloads);
}

export function serviceSnapshotFromStates(
  states: ReadonlyMap<string, EcsServiceState>,
  workloads: string[],
): ServiceSnapshot {
  const tasks: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const workload of workloads) {
    const state = states.get(workload)!;
    if (!state.taskDefinition) throw new CliError(`${workload}: ECS service has no task definition`);
    tasks[workload] = state.taskDefinition;
    counts[workload] = state.desiredCount ?? 0;
  }
  return { tasks, counts };
}

export async function trustedDeploymentBaseline(
  config: QmConfig,
  snapshot: ServiceSnapshot,
  workloads: string[],
  action = "deploy --only",
): Promise<DeploymentManifest> {
  const aws = requireAws(config);
  const current = await currentDeploymentManifest(aws);
  if (!current || workloads.some((workload) => !current.tasks[workload])) {
    throw new CliError(
      "the first AWS deployment must include every workload; omit --only until a complete deployment manifest exists",
    );
  }
  for (const workload of workloads) {
    if (
      snapshot.tasks[workload] !== current.tasks[workload] ||
      snapshot.counts[workload] !== workloadDesiredCount(config, workload)
    ) {
      throw new CliError(
        `cannot ${action} while untouched workload ${workload} differs from the current deployment manifest`,
      );
    }
    const { taskDefinition: task } = await ecs(aws).send(
      new DescribeTaskDefinitionCommand({ taskDefinition: current.tasks[workload]! }),
    );
    const container = (task?.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
      (item) => item.name === workload,
    );
    if (
      !container ||
      typeof container.image !== "string" ||
      !isPinnedWorkloadImage(config, workload, container.image)
    ) {
      throw new CliError(`cannot ${action} while untouched workload ${workload} lacks a trusted digest-pinned image`);
    }
  }
  return current;
}

export function adoptMissingWorkloads(
  manifest: DeploymentManifest,
  snapshot: ServiceSnapshot,
  workloads: string[],
): boolean {
  const missing = workloads.filter((workload) => !manifest.tasks[workload]);
  const active = missing.filter((workload) => snapshot.counts[workload] !== 0);
  if (active.length) {
    throw new CliError(
      `selected workload ${active.join(", ")} is missing from the current deployment manifest and must be scaled to zero before adoption`,
    );
  }
  if (!missing.length) return false;
  manifest.counts ??= {};
  for (const workload of missing) {
    manifest.tasks[workload] = snapshot.tasks[workload]!;
    manifest.counts[workload] = snapshot.counts[workload]!;
  }
  return true;
}

function updateService(aws: AwsConfig, workload: string, taskDefinition: string, desiredCount: number) {
  const service = aws.services[workload]!.ecsService;
  return ecs(aws).send(new UpdateServiceCommand({ cluster: aws.cluster, service, taskDefinition, desiredCount }));
}

export async function applyServiceTargets(
  config: QmConfig,
  targets: Record<string, string>,
  desiredCounts?: Record<string, number>,
  options: {
    timeoutMs?: number;
    onSubmitted?: () => void;
  } = {},
): Promise<void> {
  const aws = requireAws(config);
  const workloads = Object.keys(targets);
  const states = await describedServices(config, workloads);
  assertOwnedServices(config, states, workloads);
  const before = serviceSnapshotFromStates(states, workloads);
  const expectedCounts = Object.fromEntries(
    workloads.map((workload) => [workload, desiredCounts?.[workload] ?? before.counts[workload]!]),
  );
  const changed: string[] = [];
  try {
    for (const workload of workloads) {
      changed.push(workload);
      await updateService(aws, workload, targets[workload]!, expectedCounts[workload]!);
    }
    options.onSubmitted?.();
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        workloads.map((workload) => [
          workload,
          {
            taskDefinition: targets[workload]!,
            desiredCount: expectedCounts[workload]!,
          },
        ]),
      ),
      options.timeoutMs,
    );
  } catch (error) {
    const restoreFailures: string[] = [];
    for (const workload of [...changed].reverse()) {
      try {
        await updateService(aws, workload, before.tasks[workload]!, before.counts[workload]!);
      } catch (restoreError) {
        restoreFailures.push(`${workload}: ${errMessage(restoreError)}`);
      }
    }
    if (changed.length && restoreFailures.length === 0) {
      try {
        await awaitServiceTargets(
          config,
          Object.fromEntries(
            changed.map((workload) => [
              workload,
              {
                taskDefinition: before.tasks[workload]!,
                desiredCount: before.counts[workload]!,
              },
            ]),
          ),
          options.timeoutMs,
        );
      } catch (restoreError) {
        restoreFailures.push(errMessage(restoreError));
      }
    }
    const detail = restoreFailures.length
      ? `; restoring the prior service set also failed (${restoreFailures.join("; ")})`
      : "";
    throw new CliError(`${errMessage(error)}${detail}`);
  }
}

export function deploymentProgress(
  config: QmConfig,
  opts: AwsUpOpts,
): ((targets: Record<string, string>) => void) | undefined {
  const file = process.env.QM_DEPLOY_PROGRESS_FILE;
  const token = process.env.QM_DEPLOY_PROGRESS_TOKEN;
  if (file === undefined && token === undefined) return undefined;
  if (!file || !token || !isAbsolute(file) || !opts.candidate || !opts.yes || opts.dryRun || opts.buildOnly) {
    throw new CliError(
      "deployment progress requires an absolute QM_DEPLOY_PROGRESS_FILE, QM_DEPLOY_PROGRESS_TOKEN, and candidate up --yes",
    );
  }
  if (existsSync(file)) throw new CliError("deployment progress file must not already exist");
  if (!statSync(dirname(file)).isDirectory()) throw new CliError("deployment progress parent must be a directory");
  accessSync(dirname(file), constants.W_OK);
  return (targets) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ phase: "monitoring", token, orgId: config.orgId, targets }), {
        flag: "wx",
        mode: 0o600,
      });
      linkSync(temporary, file);
    } catch (error) {
      warn(`could not publish deployment progress: ${errMessage(error)}`);
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch (error) {
        warn(`could not remove deployment progress temporary file: ${errMessage(error)}`);
      }
    }
  };
}
