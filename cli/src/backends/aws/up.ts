import { BatchDeleteImageCommand } from "@aws-sdk/client-ecr";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAwsLease as acquireLease, awsErrorCode, releaseAwsLease as releaseLease } from "../../aws-lease.ts";
import { canonicalJson } from "../../canonical-json.ts";
import { type QmConfig, IMAGE_TAG } from "../../config.ts";
import { deploymentLayerBody, currentDeploymentLayerState } from "../../deployment-layer.ts";
import { CliError, header, step, note, ok, warn, errMessage } from "../../log.ts";
import { serviceHost, isServiceName } from "../../services.ts";
import { resolveBuildRepoRoot, settleAll } from "../../util.ts";
import {
  assertNotBackgroundOwner,
  clearBackgroundPreparation,
  prepareBackgroundDeployment,
  reconcileBackgroundPreparation,
} from "./background-work.ts";
import { type AwsUpOpts, assertAwsCallerAccount, awsTopology, ecr, rdsInstanceIdentifier } from "./clients.ts";
import {
  type AwsReleaseCandidate,
  type DeploymentImageProvenance,
  assertAwsDeployImage,
  dockerLogin,
  ecrHost,
  plannedWorkloadImage,
  promoteStagedImage,
  publishWorkloadImage,
  releaseCandidate,
  workloadImageProvenance,
} from "./images.ts";
import {
  type DeploymentManifest,
  assertPredeployDbRestorePoint,
  confirmDbRestorePointCovered,
  currentDeploymentManifest,
  getDeploymentLayerArtifact,
  manifestTransaction,
  putDeploymentLayerArtifact,
  recordDeploymentManifest,
  syncAwsLayerAfterRoll,
} from "./manifest.ts";
import {
  type ServiceSnapshot,
  adoptMissingWorkloads,
  applyServiceTargets,
  assertOwnedServices,
  awaitServiceTargets,
  deploymentProgress,
  describedServices,
  runAwsCandidateMigration,
  serviceSnapshot,
  throwAfterCompensation,
  trustedDeploymentBaseline,
  workloadDesiredCount,
} from "./rollout.ts";
import { assertAwsPublicFrontDoor, assertAwsPublicNetwork, awsDeploymentLayerTransport } from "./routing.ts";
import {
  assertAwsPublicApiUrl,
  registerTaskDefinition,
  renderTaskDefinition,
  reportTaskChanges,
  secretArns,
  workloadArchitecture,
} from "./task-definitions.ts";

export async function awsUp(config: QmConfig, _configDir: string, opts: AwsUpOpts = {}): Promise<void> {
  const reportProgress = deploymentProgress(config, opts);
  const topology = awsTopology(config, _configDir);
  const { aws } = topology;
  if (new URL(config.publicUrl).protocol !== "https:") {
    throw new CliError(
      "AWS deploy requires an HTTPS publicUrl; configure an ACM certificate, update publicUrl, and rerender/apply Terraform before running `qm up`",
    );
  }
  const plugins = new Map(topology.plugins.map((plugin) => [plugin.name, plugin]));
  const services = opts.only ? [...new Set(opts.only.map(serviceHost))] : topology.workloads;
  const buildConcurrency = opts.buildConcurrency ?? 1;
  if (!Number.isSafeInteger(buildConcurrency) || buildConcurrency < 1)
    throw new CliError("--build-concurrency requires a positive integer");
  if (opts.buildConcurrency !== undefined && !opts.buildOnly)
    throw new CliError("--build-concurrency requires --build-only");
  if (
    buildConcurrency > 1 &&
    new Set(services.map((service) => aws.services[service]?.ecrRepository)).size !== services.length
  )
    throw new CliError("--build-concurrency requires distinct ECR repositories for selected workloads");
  const restart = new Set((opts.restart ?? []).map(serviceHost));
  if (restart.size && opts.buildOnly) throw new CliError("--restart cannot be used with --build-only");
  for (const service of restart) {
    if (!services.includes(service)) throw new CliError(`--restart workload ${service} is not selected for deployment`);
  }
  for (const service of services) workloadArchitecture(config, service);
  if (opts.buildOnly && opts.candidate) throw new CliError("--build-only and --candidate are mutually exclusive");
  if (opts.candidate && opts.buildFrom) throw new CliError("--candidate and --build-from are mutually exclusive");
  if (opts.inactive && (opts.dryRun || !opts.candidate)) {
    throw new CliError("--inactive is only valid for an exact candidate deployment");
  }
  if (opts.buildOnly && !opts.imageLabel) throw new CliError("--build-only requires --image-label <label>");
  if (opts.buildOnly && !opts.candidateOut) throw new CliError("--build-only requires --candidate-out <path>");
  if (opts.imageLabel && !IMAGE_TAG.test(opts.imageLabel)) {
    throw new CliError("--image-label must be a valid ECR tag");
  }
  if (opts.buildFrom) resolveBuildRepoRoot(opts.buildFromPath, services.filter(isServiceName));
  if (opts.buildOnly) {
    await assertAwsCallerAccount(aws);
    header(`qm ${opts.dryRun ? "plan" : "build"} — ${config.orgId} (aws candidate ${opts.imageLabel})`);
    if (opts.dryRun) {
      for (const service of services) step(`${service}: build immutable candidate image`);
      note(`Plan only. Candidate manifest would be written to ${opts.candidateOut}.`);
      return;
    }
    await dockerLogin(aws);
    const images: Record<string, string> = {};
    const imageProvenance: Record<string, DeploymentImageProvenance> = {};
    for (const service of services) {
      imageProvenance[service] = workloadImageProvenance(config, service, plugins.get(service), opts);
    }
    const controller = new AbortController();
    const cancelBuilds = () => controller.abort();
    process.on("SIGINT", cancelBuilds);
    process.on("SIGTERM", cancelBuilds);
    try {
      for (let offset = 0; offset < services.length; offset += buildConcurrency) {
        await settleAll(
          services.slice(offset, offset + buildConcurrency).map(async (service) => {
            images[service] = await publishWorkloadImage(
              config,
              service,
              plugins.get(service),
              opts.imageLabel!,
              opts,
              controller.signal,
            );
          }),
        );
      }
    } finally {
      process.off("SIGINT", cancelBuilds);
      process.off("SIGTERM", cancelBuilds);
    }
    const release: AwsReleaseCandidate = {
      contract: 1,
      accountId: aws.accountId,
      region: aws.region,
      label: opts.imageLabel!,
      images,
      imageProvenance,
      architectures: Object.fromEntries(services.map((service) => [service, workloadArchitecture(config, service)])),
    };
    writeFileSync(opts.candidateOut!, `${JSON.stringify(release, null, 2)}\n`, { mode: 0o600 });
    ok(`AWS release candidate written to ${opts.candidateOut}`);
    return;
  }
  const candidate = opts.candidate ? releaseCandidate(config, opts.candidate) : undefined;
  for (const service of services) {
    if (candidate && (!candidate.images[service] || !candidate.imageProvenance[service])) {
      throw new CliError(`AWS release candidate ${opts.candidate} does not contain ${service}`);
    }
  }
  if (opts.imageLabel && opts.imageLabel !== aws.imageLabel) {
    throw new CliError(
      `--image-label ${opts.imageLabel} differs from durable aws.imageLabel ${aws.imageLabel}; update and commit the deployment directory first`,
    );
  }
  const label = aws.imageLabel;
  if (!label) throw new CliError("aws.imageLabel is required");
  if (!opts.dryRun && !opts.yes) throw new CliError("AWS deploy requires --yes after reviewing `qm plan`");
  await assertAwsCallerAccount(aws);
  await assertAwsPublicFrontDoor(config);
  if (!opts.dryRun && !opts.inactive) await assertAwsPublicNetwork(config);
  await assertAwsPublicApiUrl(config);
  await assertAwsDeployImage(config);
  header(`qm ${opts.dryRun ? "plan" : "up"} — ${config.orgId} (aws)`);
  const allServices = topology.workloads;
  assertOwnedServices(config, await describedServices(config, allServices), allServices);
  const arns = await secretArns(config);
  if (opts.dryRun) {
    step(
      aws.predeployDbSnapshot === false
        ? "pre-deploy database restore point: disabled (aws.predeployDbSnapshot)"
        : `pre-deploy database restore point: verify ${rdsInstanceIdentifier(aws)} point-in-time recovery is current before the first mutation`,
    );
    const before = await serviceSnapshot(config, allServices);
    const selected = new Set(services);
    if (allServices.some((service) => !selected.has(service))) {
      const baseline = await trustedDeploymentBaseline(
        config,
        before,
        allServices.filter((name) => !selected.has(name)),
      );
      adoptMissingWorkloads(baseline, before, services);
    }
    const images: Record<string, string> = {};
    for (const service of services) {
      if (candidate) {
        images[service] = candidate.images[service]!;
        step(`${service}: immutable candidate ${candidate.label}`);
        continue;
      }
      const spec = aws.services[service]!;
      const sourceBuild = (opts.buildFrom && isServiceName(service)) || plugins.get(service)?.kind === "source";
      if (sourceBuild) {
        images[service] = `${ecrHost(aws)}/${spec.ecrRepository}@sha256:${"0".repeat(64)}`;
        step(`${service}: source build planned; image digest is unresolved until build`);
        continue;
      }
      images[service] = plannedWorkloadImage(config, service, plugins.get(service));
    }
    const backgroundDeploymentId = aws.backgroundWorkControl
      ? ((await currentDeploymentManifest(aws))?.backgroundDeploymentId ??
        `${aws.services.core!.ecsService}:00000000-0000-0000-0000-000000000000`)
      : undefined;
    await reportTaskChanges(config, services, images, arns, restart, backgroundDeploymentId);
    for (const service of services) {
      step(`${service}: desired count ${before.counts[service] ?? 0} → ${workloadDesiredCount(config, service)}`);
    }
    if (opts.sandboxDir && existsSync(opts.sandboxDir) && (!opts.only || opts.only.includes("core"))) {
      const hash = createHash("sha256").update(deploymentLayerBody(opts.sandboxDir)).digest("hex");
      try {
        const current = await currentDeploymentManifest(aws);
        step(`deployment layer: ${current?.layer?.sha256 === hash ? "unchanged" : "changed"} (${hash.slice(0, 12)})`);
      } catch {
        step(`deployment layer: desired ${hash.slice(0, 12)} (live state unavailable)`);
      }
    } else {
      step("deployment layer: preserved (no sandbox directory selected for core)");
    }
    note(
      `Plan only. Re-run \`qm up${opts.candidate ? ` --candidate ${opts.candidate}` : ""}${restart.size ? ` --restart ${[...restart].join(",")}` : ""} --yes\` to deploy.`,
    );
    return;
  }
  const lease = await acquireLease(aws);
  const releaseId = randomUUID();
  const stagingLabel = "qm-staging";
  const staged = new Set<string>();
  const promotedServices = new Set<string>();
  let before: ServiceSnapshot | undefined;
  let applied = false;
  let current: DeploymentManifest | undefined;
  let recorded: DeploymentManifest | undefined;
  let releaseSucceeded = false;
  let previousLayerBody: string | undefined;
  let previousLayerBootstrapped = false;
  let desiredLayerBody: string | undefined;
  let desiredLayer: DeploymentManifest["layer"];
  let layerChanged = false;
  let layerAttempted = false;
  let dbRestorePoint: string | undefined;
  let migratedCandidate = false;
  try {
    await assertAwsDeployImage(config);
    before = await serviceSnapshot(config, allServices);
    current = await currentDeploymentManifest(aws);
    if (current?.backgroundDeploymentId && !aws.backgroundWorkControl)
      throw new CliError("cannot disable background ownership control while a controlled deployment is recorded");
    if (aws.backgroundWorkControl) {
      if (!current?.backgroundDeploymentId && !services.includes("core"))
        throw new CliError("enabling background ownership requires deploying core to allocate its identity");
      reconcileBackgroundPreparation(aws, current, before);
      if (services.includes("core")) await assertNotBackgroundOwner(config, current);
    }
    const selected = new Set(services);
    if (allServices.some((service) => !selected.has(service))) {
      current = await trustedDeploymentBaseline(
        config,
        before,
        allServices.filter((name) => !selected.has(name)),
      );
      if (adoptMissingWorkloads(current, before, services)) await manifestTransaction(aws, current, current.id);
    }
    if (aws.predeployDbSnapshot === false)
      note("pre-deploy database restore point: disabled (aws.predeployDbSnapshot)");
    else dbRestorePoint = await assertPredeployDbRestorePoint(config);
    if (current?.layer) {
      desiredLayer = current.layer;
    } else {
      if (current || before.counts.core !== 0) {
        const previousState = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        previousLayerBody = previousState.body;
        previousLayerBootstrapped = previousState.bootstrapped;
      } else {
        previousLayerBody = JSON.stringify({ contract: 1, tools: [], skills: [] });
        previousLayerBootstrapped = true;
      }
      if (!previousLayerBootstrapped) {
        desiredLayer = await putDeploymentLayerArtifact(config, previousLayerBody);
        if (current) {
          current.layer = desiredLayer;
          await manifestTransaction(aws, current, current.id);
        }
      }
    }
    if (opts.sandboxDir && existsSync(opts.sandboxDir) && (!opts.only || opts.only.includes("core"))) {
      previousLayerBody ??= await getDeploymentLayerArtifact(config, desiredLayer);
      desiredLayerBody = deploymentLayerBody(opts.sandboxDir);
      desiredLayer = await putDeploymentLayerArtifact(config, desiredLayerBody);
      layerChanged = desiredLayer.sha256 !== current?.layer?.sha256;
      if (!layerChanged && before.counts.core !== 0) {
        const state = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        if (
          state.status === "applied" &&
          state.contentHash === desiredLayer.sha256 &&
          state.runtimeContentHash === desiredLayer.sha256
        ) {
          desiredLayerBody = undefined;
        }
      }
    }
    if (!candidate) await dockerLogin(aws);
    const images: Record<string, string> = {};
    const selectedImageProvenance: Record<string, DeploymentImageProvenance> = {};
    for (const service of services) {
      if (candidate) {
        selectedImageProvenance[service] = candidate.imageProvenance[service]!;
        images[service] = candidate.images[service]!;
      } else {
        staged.add(service);
        selectedImageProvenance[service] = workloadImageProvenance(config, service, plugins.get(service), opts);
        images[service] = await publishWorkloadImage(config, service, plugins.get(service), stagingLabel, opts);
      }
    }
    let backgroundDeploymentId = current?.backgroundDeploymentId;
    if (aws.backgroundWorkControl && !backgroundDeploymentId)
      backgroundDeploymentId = `${aws.services.core!.ecsService}:${releaseId}`;
    const desired = await reportTaskChanges(config, services, images, arns, restart, backgroundDeploymentId);
    const changedCore = desired.find((item) => item.service === "core" && item.changed);
    if (aws.backgroundWorkControl && changedCore) {
      backgroundDeploymentId = `${aws.services.core!.ecsService}:${releaseId}`;
      changedCore.task = renderTaskDefinition(config, "core", images.core!, arns, backgroundDeploymentId);
      prepareBackgroundDeployment(aws, {
        id: releaseId,
        previousManifestId: current?.id,
        backgroundDeploymentId,
        before,
      });
    }
    const targets: Record<string, string> = {};
    for (const item of desired) {
      if (!item.changed) {
        targets[item.service] = before.tasks[item.service]!;
        continue;
      }
      const file = join(mkdtempSync(join(tmpdir(), "qm-task-")), `${item.service}.json`);
      writeFileSync(file, JSON.stringify(item.task));
      const taskDefinition = await registerTaskDefinition(config, file);
      targets[item.service] = taskDefinition;
    }
    if (candidate?.images.core && services.includes("core")) {
      await runAwsCandidateMigration(config, candidate.images.core, candidate.label, targets.core!);
      migratedCandidate = true;
    }
    const rolloutTargets = Object.fromEntries(
      services
        .filter(
          (service) =>
            desired.find((item) => item.service === service)!.changed ||
            before!.counts[service] !== workloadDesiredCount(config, service),
        )
        .map((service) => [service, targets[service]!]),
    );
    if (Object.keys(rolloutTargets).length) {
      await applyServiceTargets(
        config,
        rolloutTargets,
        Object.fromEntries(
          Object.keys(rolloutTargets).map((service) => [service, workloadDesiredCount(config, service)]),
        ),
        { onSubmitted: reportProgress ? () => reportProgress(targets) : undefined },
      );
      applied = true;
    } else {
      reportProgress?.(targets);
    }
    await awaitServiceTargets(
      config,
      Object.fromEntries(
        services.map((service) => [
          service,
          { taskDefinition: targets[service]!, desiredCount: workloadDesiredCount(config, service) },
        ]),
      ),
    );
    if (desiredLayerBody) {
      layerAttempted = true;
      await syncAwsLayerAfterRoll(
        {
          config,
          transport: awsDeploymentLayerTransport,
          configDir: _configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        },
        desiredLayerBody,
        desiredLayer!,
      );
    }
    const releaseTasks = { ...before.tasks, ...targets };
    const releaseCounts = Object.fromEntries(
      allServices.map((service) => [service, workloadDesiredCount(config, service)]),
    );
    const releaseImageProvenance = { ...current?.imageProvenance, ...selectedImageProvenance };
    const sameTasks = current && allServices.every((service) => current!.tasks[service] === releaseTasks[service]);
    const sameCounts = current && canonicalJson(current.counts ?? {}) === canonicalJson(releaseCounts);
    const sameImageProvenance =
      current && canonicalJson(current.imageProvenance ?? {}) === canonicalJson(releaseImageProvenance);
    releaseSucceeded = true;
    if (
      !current ||
      !sameTasks ||
      !sameCounts ||
      !sameImageProvenance ||
      current.imageLabel !== label ||
      layerChanged ||
      migratedCandidate
    ) {
      recorded = await recordDeploymentManifest(aws, releaseTasks, {
        id: releaseId,
        ...(backgroundDeploymentId ? { backgroundDeploymentId } : {}),
        counts: releaseCounts,
        imageLabel: label,
        ...(dbRestorePoint ? { dbRestorePoint } : {}),
        ...(desiredLayer ? { layer: desiredLayer } : {}),
        imageProvenance: releaseImageProvenance,
      });
    }
    if (aws.backgroundWorkControl && changedCore) clearBackgroundPreparation(aws);
    if (recorded && dbRestorePoint) await confirmDbRestorePointCovered(config, dbRestorePoint);
    for (const service of candidate ? [] : services) {
      try {
        await promoteStagedImage(config, service, images[service]!, label);
        promotedServices.add(service);
      } catch (error) {
        warn(
          `AWS deployment succeeded, but could not promote ${service}:${label}: ${errMessage(error)}; preserving staging tag ${stagingLabel} so the deployed digest remains pullable; rerun \`qm up --yes\` to retry promotion`,
        );
      }
    }
  } catch (error) {
    if (releaseSucceeded) throw error;
    const compensationFailures: string[] = [];
    if (layerAttempted && previousLayerBody && !previousLayerBootstrapped) {
      try {
        await syncAwsLayerAfterRoll(
          {
            config,
            transport: awsDeploymentLayerTransport,
            configDir: _configDir,
            ...(opts.envFile ? { envFile: opts.envFile } : {}),
          },
          previousLayerBody,
          createHash("sha256").update(previousLayerBody).digest("hex"),
        );
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-deploy deployment layer: ${errMessage(restoreError)}`);
      }
    } else if (layerAttempted && previousLayerBootstrapped) {
      warn(
        `the pre-deploy layer snapshot was synthesized (the core had no durable layer record) — leaving the core's layer as the failed sync left it rather than durably installing the empty bundle`,
      );
    }
    if (applied && before) {
      try {
        await applyServiceTargets(config, before.tasks, before.counts);
      } catch (restoreError) {
        compensationFailures.push(`restoring the pre-deploy manifest: ${errMessage(restoreError)}`);
      }
    }
    throwAfterCompensation(error, compensationFailures);
  } finally {
    for (const service of staged) {
      if (releaseSucceeded && !promotedServices.has(service)) continue;
      try {
        await ecr(aws).send(
          new BatchDeleteImageCommand({
            repositoryName: aws.services[service]!.ecrRepository,
            imageIds: [{ imageTag: stagingLabel }],
          }),
        );
      } catch (error) {
        if (awsErrorCode(error) !== "ImageNotFoundException")
          warn(`could not clean staging image ${service}:${stagingLabel}: ${errMessage(error)}`);
      }
    }
    await releaseLease(aws, lease);
  }
  ok(`AWS services stable on ${label} (deployment ${recorded?.id ?? current?.id})`);
}
