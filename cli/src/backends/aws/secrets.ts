import { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { withAwsLease, awsErrorCode } from "../../aws-lease.ts";
import { type QmConfig } from "../../config.ts";
import { CliError, step, note, errMessage, ok } from "../../log.ts";
import { validatedSecrets, computedSecrets } from "../../secrets.ts";
import { hostsWebEdge, runsSeparateWebEdge } from "../../services.ts";
import { readEnvFile, deploymentSecretValue, promptHidden, isInvalidSecret } from "../../util.ts";
import { assertAwsCallerAccount, awsTopology, describeTaskDefinition, ecs, secretsManager } from "./clients.ts";
import { isPinnedWorkloadImage } from "./images.ts";
import { currentDeploymentManifest, recordDeploymentManifest } from "./manifest.ts";
import {
  applyServiceTargets,
  assertOwnedServices,
  awaitServiceTargets,
  describedServices,
  serviceSnapshotFromStates,
  throwAfterCompensation,
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

export async function awsSecretsPush(config: QmConfig, configDir: string, envFile?: string): Promise<void> {
  validatedSecrets(config);
  const { aws, workloads } = awsTopology(config, configDir);
  await assertAwsCallerAccount(aws);
  const values = envValues(configDir, envFile);
  const staged: Array<{ name: string; id: string; value: string }> = [];
  {
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
    await withAwsLease(aws, async () => {
      const baseline = await currentDeploymentManifest(aws);
      if (baseline?.backgroundDeploymentId && !aws.backgroundWorkControl)
        throw new CliError("controlled secret activation cannot fall back to a legacy task definition");
      const states = await describedServices(config, workloads);
      assertOwnedServices(config, states, workloads);
      const before = baseline ? serviceSnapshotFromStates(states, workloads) : undefined;
      if (baseline) {
        const drifted = workloads.filter(
          (workload) => !baseline.tasks[workload] || before!.tasks[workload] !== baseline.tasks[workload],
        );
        if (drifted.length)
          throw new CliError(
            `cannot rotate secrets while workloads differ from the current deployment manifest: ${drifted.join(", ")}`,
          );
      } else {
        const active = workloads.filter((workload) => {
          const state = states.get(workload)!;
          return state.desiredCount !== 0 || state.runningCount !== 0;
        });
        if (active.length) {
          throw new CliError(
            `cannot defer secret activation without a current deployment manifest while workloads are active: ${active.join(", ")}`,
          );
        }
      }
      const uploaded = Object.fromEntries(staged.map((secret) => [secret.name, secret.id]));
      const affected = workloads.filter((workload) =>
        workloadSecrets(config, workload, uploaded).some((secret) => uploaded[secret.name]),
      );
      if (baseline && before) {
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
      }
      if (baseline?.backgroundDeploymentId) {
        for (const secret of staged.filter((item) =>
          ["DEPLOYMENT_CONTROL_SECRET", "CORE_SIGNING_SECRET"].includes(item.name),
        )) {
          const { SecretString } = await secretsManager(aws).send(new GetSecretValueCommand({ SecretId: secret.id }));
          const existing = (SecretString ?? "").trim();
          if (existing !== secret.value)
            throw new CliError(
              `${secret.name} cannot be rotated while controlled task cohorts are deployed; coordinated control credential rotation is required`,
            );
        }
      }
      for (const secret of staged) {
        try {
          await secretsManager(aws).send(
            new PutSecretValueCommand({ SecretId: secret.id, SecretString: secret.value }),
          );
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
      const arns = await secretArns(config);
      const targets = { ...before.tasks };
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
        const dir = mkdtempSync(join(tmpdir(), "qm-task-"));
        try {
          const file = join(dir, `${workload}.json`);
          writeFileSync(file, JSON.stringify(desired));
          targets[workload] = await registerTaskDefinition(config, file);
          changed[workload] = targets[workload]!;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      let changedApplied = false;
      let rotated = false;
      try {
        if (Object.keys(changed).length) {
          await applyServiceTargets(
            config,
            changed,
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.counts[workload]!])),
          );
          changedApplied = true;
        }
        const unchanged = affected.filter((workload) => !changed[workload]);
        const forcedDeployments: Record<string, string> = {};
        for (const workload of unchanged) {
          const { service } = await ecs(aws).send(
            new UpdateServiceCommand({
              cluster: aws.cluster,
              service: aws.services[workload]!.ecsService,
              forceNewDeployment: true,
            }),
          );
          const primary = (service?.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
          if (primary.length !== 1 || !primary[0]?.id)
            throw new CliError(`AWS did not identify the replacement deployment for ${workload}`);
          forcedDeployments[workload] = primary[0].id;
        }
        if (unchanged.length) {
          await awaitServiceTargets(
            config,
            Object.fromEntries(
              unchanged.map((workload) => [
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
        rotated = true;
        if (Object.keys(changed).length) {
          await recordDeploymentManifest(aws, targets, {
            ...(baseline.counts ? { counts: baseline.counts } : {}),
            imageLabel: baseline.imageLabel ?? aws.imageLabel,
            ...(baseline.layer ? { layer: baseline.layer } : {}),
            ...(baseline.imageProvenance ? { imageProvenance: baseline.imageProvenance } : {}),
          });
        }
      } catch (error) {
        if (rotated || !changedApplied) throw error;
        const compensationFailures: string[] = [];
        try {
          await applyServiceTargets(
            config,
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.tasks[workload]!])),
            Object.fromEntries(Object.keys(changed).map((workload) => [workload, before.counts[workload]!])),
          );
        } catch (restoreError) {
          compensationFailures.push(`restoring pre-rotation task definitions: ${errMessage(restoreError)}`);
        }
        throwAfterCompensation(error, compensationFailures);
      }
      for (const workload of affected) step(`${workload}: restarted with rotated secrets`);
    });
  }
  ok("operator secrets uploaded to AWS Secrets Manager");
}
