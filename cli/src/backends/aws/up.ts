import { BatchDeleteImageCommand } from "@aws-sdk/client-ecr";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { acquireAwsLease as acquireLease, awsErrorCode, releaseAwsLease as releaseLease } from "../../aws-lease.ts";
import { canonicalJson } from "../../canonical-json.ts";
import { type AwsConfig, type QmConfig } from "../../config.ts";
import { IMAGE_TAG } from "../../config-aws.ts";
import { type ResolvedPlugin } from "../../plugins.ts";
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
import {
  type AwsUpOpts,
  assertAwsCallerAccount,
  awsTopology,
  ecr,
  rdsInstanceIdentifier,
  requireAws,
} from "./clients.ts";
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

type Plugins = ReadonlyMap<string, ResolvedPlugin>;

function validateUpOptions(config: QmConfig, services: string[], opts: AwsUpOpts) {
  const aws = requireAws(config);
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
  return { buildConcurrency, restart };
}

async function buildUpCandidate(
  config: QmConfig,
  services: string[],
  plugins: Plugins,
  opts: AwsUpOpts,
  buildConcurrency: number,
): Promise<void> {
  const aws = requireAws(config);
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
}

interface UpRun {
  config: QmConfig;
  aws: AwsConfig;
  opts: AwsUpOpts;
  configDir: string;
  services: string[];
  allServices: string[];
  plugins: Plugins;
  candidate: AwsReleaseCandidate | undefined;
  arns: Record<string, string>;
  restart: ReadonlySet<string>;
  label: string;
  releaseId: string;
  staged: Set<string>;
  promoted: Set<string>;
  before?: ServiceSnapshot;
  current?: DeploymentManifest;
  recorded?: DeploymentManifest;
  applied: boolean;
  releaseSucceeded: boolean;
  previousLayerBody?: string;
  previousLayerBootstrapped: boolean;
  desiredLayerBody?: string;
  desiredLayer?: DeploymentManifest["layer"];
  layerChanged: boolean;
  layerAttempted: boolean;
  dbRestorePoint?: string;
  migratedCandidate: boolean;
}

const STAGING_LABEL = "qm-staging";

function layerSync(run: UpRun) {
  return {
    config: run.config,
    transport: awsDeploymentLayerTransport,
    configDir: run.configDir,
    ...(run.opts.envFile ? { envFile: run.opts.envFile } : {}),
  };
}

function selectsCoreLayer(opts: AwsUpOpts): boolean {
  return !!opts.sandboxDir && existsSync(opts.sandboxDir) && (!opts.only || opts.only.includes("core"));
}

async function planUp(run: UpRun): Promise<void> {
  const { config, aws, opts, services, allServices, plugins, candidate } = run;
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
  await reportTaskChanges(config, services, images, run.arns, run.restart, backgroundDeploymentId);
  for (const service of services) {
    step(`${service}: desired count ${before.counts[service] ?? 0} → ${workloadDesiredCount(config, service)}`);
  }
  if (selectsCoreLayer(opts)) {
    const hash = createHash("sha256").update(deploymentLayerBody(opts.sandboxDir!)).digest("hex");
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
    `Plan only. Re-run \`qm up${opts.candidate ? ` --candidate ${opts.candidate}` : ""}${run.restart.size ? ` --restart ${[...run.restart].join(",")}` : ""} --yes\` to deploy.`,
  );
}

async function prepareUpBaseline(run: UpRun): Promise<ServiceSnapshot> {
  const { config, aws, services, allServices } = run;
  await assertAwsDeployImage(config);
  const before = (run.before = await serviceSnapshot(config, allServices));
  run.current = await currentDeploymentManifest(aws);
  if (run.current?.backgroundDeploymentId && !aws.backgroundWorkControl)
    throw new CliError("cannot disable background ownership control while a controlled deployment is recorded");
  if (aws.backgroundWorkControl) {
    if (!run.current?.backgroundDeploymentId && !services.includes("core"))
      throw new CliError("enabling background ownership requires deploying core to allocate its identity");
    reconcileBackgroundPreparation(aws, run.current, before);
    if (services.includes("core")) await assertNotBackgroundOwner(config, run.current);
  }
  const selected = new Set(services);
  if (allServices.some((service) => !selected.has(service))) {
    const current = await trustedDeploymentBaseline(
      config,
      before,
      allServices.filter((name) => !selected.has(name)),
    );
    run.current = current;
    if (adoptMissingWorkloads(current, before, services)) await manifestTransaction(aws, current, current.id);
  }
  if (aws.predeployDbSnapshot === false) note("pre-deploy database restore point: disabled (aws.predeployDbSnapshot)");
  else run.dbRestorePoint = await assertPredeployDbRestorePoint(config);
  return before;
}

async function prepareUpLayer(run: UpRun, before: ServiceSnapshot): Promise<void> {
  const { config, aws, opts, current } = run;
  if (current?.layer) {
    run.desiredLayer = current.layer;
  } else {
    if (current || before.counts.core !== 0) {
      const previousState = await currentDeploymentLayerState(layerSync(run));
      run.previousLayerBody = previousState.body;
      run.previousLayerBootstrapped = previousState.bootstrapped;
    } else {
      run.previousLayerBody = JSON.stringify({ contract: 1, tools: [], skills: [] });
      run.previousLayerBootstrapped = true;
    }
    if (!run.previousLayerBootstrapped) {
      run.desiredLayer = await putDeploymentLayerArtifact(config, run.previousLayerBody);
      if (current) {
        current.layer = run.desiredLayer;
        await manifestTransaction(aws, current, current.id);
      }
    }
  }
  if (!selectsCoreLayer(opts)) return;
  run.previousLayerBody ??= await getDeploymentLayerArtifact(config, run.desiredLayer);
  run.desiredLayerBody = deploymentLayerBody(opts.sandboxDir!);
  const desiredLayer = (run.desiredLayer = await putDeploymentLayerArtifact(config, run.desiredLayerBody));
  run.layerChanged = desiredLayer.sha256 !== current?.layer?.sha256;
  if (!run.layerChanged && before.counts.core !== 0) {
    const state = await currentDeploymentLayerState(layerSync(run));
    if (
      state.status === "applied" &&
      state.contentHash === desiredLayer.sha256 &&
      state.runtimeContentHash === desiredLayer.sha256
    ) {
      run.desiredLayerBody = undefined;
    }
  }
}

async function publishUpImages(run: UpRun) {
  const { config, aws, opts, candidate } = run;
  if (!candidate) await dockerLogin(aws);
  const images: Record<string, string> = {};
  const provenance: Record<string, DeploymentImageProvenance> = {};
  for (const service of run.services) {
    if (candidate) {
      provenance[service] = candidate.imageProvenance[service]!;
      images[service] = candidate.images[service]!;
    } else {
      run.staged.add(service);
      provenance[service] = workloadImageProvenance(config, service, run.plugins.get(service), opts);
      images[service] = await publishWorkloadImage(config, service, run.plugins.get(service), STAGING_LABEL, opts);
    }
  }
  return { images, provenance };
}

async function registerUpTasks(run: UpRun, before: ServiceSnapshot, images: Record<string, string>) {
  const { config, aws, current } = run;
  let backgroundDeploymentId = current?.backgroundDeploymentId;
  if (aws.backgroundWorkControl && !backgroundDeploymentId)
    backgroundDeploymentId = `${aws.services.core!.ecsService}:${run.releaseId}`;
  const desired = await reportTaskChanges(config, run.services, images, run.arns, run.restart, backgroundDeploymentId);
  const changedCore = desired.find((item) => item.service === "core" && item.changed);
  if (aws.backgroundWorkControl && changedCore) {
    backgroundDeploymentId = `${aws.services.core!.ecsService}:${run.releaseId}`;
    changedCore.task = renderTaskDefinition(config, "core", images.core!, run.arns, backgroundDeploymentId);
    prepareBackgroundDeployment(aws, {
      id: run.releaseId,
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
    targets[item.service] = await registerTaskDefinition(config, item.task);
  }
  const changed = new Set(desired.filter((item) => item.changed).map((item) => item.service));
  return { targets, changed, changedCore: !!changedCore, backgroundDeploymentId };
}

async function rollOutUp(
  run: UpRun,
  before: ServiceSnapshot,
  targets: Record<string, string>,
  changed: ReadonlySet<string>,
  reportProgress: ReturnType<typeof deploymentProgress>,
): Promise<void> {
  const { config, services, candidate } = run;
  if (candidate?.images.core && services.includes("core")) {
    await runAwsCandidateMigration(config, candidate.images.core, candidate.label, targets.core!);
    run.migratedCandidate = true;
  }
  const rolloutTargets = Object.fromEntries(
    services
      .filter((service) => changed.has(service) || before.counts[service] !== workloadDesiredCount(config, service))
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
    run.applied = true;
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
  if (run.desiredLayerBody) {
    run.layerAttempted = true;
    await syncAwsLayerAfterRoll(layerSync(run), run.desiredLayerBody, run.desiredLayer!);
  }
}

async function recordUpRelease(
  run: UpRun,
  before: ServiceSnapshot,
  targets: Record<string, string>,
  provenance: Record<string, DeploymentImageProvenance>,
  images: Record<string, string>,
  background: { changedCore: boolean; backgroundDeploymentId: string | undefined },
): Promise<void> {
  const { config, aws, allServices, current, label, dbRestorePoint } = run;
  const releaseTasks = { ...before.tasks, ...targets };
  const releaseCounts = Object.fromEntries(
    allServices.map((service) => [service, workloadDesiredCount(config, service)]),
  );
  const releaseImageProvenance = { ...current?.imageProvenance, ...provenance };
  const sameTasks = current && allServices.every((service) => current.tasks[service] === releaseTasks[service]);
  const sameCounts = current && canonicalJson(current.counts ?? {}) === canonicalJson(releaseCounts);
  const sameImageProvenance =
    current && canonicalJson(current.imageProvenance ?? {}) === canonicalJson(releaseImageProvenance);
  run.releaseSucceeded = true;
  if (
    !current ||
    !sameTasks ||
    !sameCounts ||
    !sameImageProvenance ||
    current.imageLabel !== label ||
    run.layerChanged ||
    run.migratedCandidate
  ) {
    run.recorded = await recordDeploymentManifest(aws, releaseTasks, {
      id: run.releaseId,
      ...(background.backgroundDeploymentId ? { backgroundDeploymentId: background.backgroundDeploymentId } : {}),
      counts: releaseCounts,
      imageLabel: label,
      ...(dbRestorePoint ? { dbRestorePoint } : {}),
      ...(run.desiredLayer ? { layer: run.desiredLayer } : {}),
      imageProvenance: releaseImageProvenance,
    });
  }
  if (aws.backgroundWorkControl && background.changedCore) clearBackgroundPreparation(aws);
  if (run.recorded && dbRestorePoint) await confirmDbRestorePointCovered(config, dbRestorePoint);
  for (const service of run.candidate ? [] : run.services) {
    try {
      await promoteStagedImage(config, service, images[service]!, label);
      run.promoted.add(service);
    } catch (error) {
      warn(
        `AWS deployment succeeded, but could not promote ${service}:${label}: ${errMessage(error)}; preserving staging tag ${STAGING_LABEL} so the deployed digest remains pullable; rerun \`qm up --yes\` to retry promotion`,
      );
    }
  }
}

async function compensateUp(run: UpRun, error: unknown): Promise<never> {
  const compensationFailures: string[] = [];
  const { previousLayerBody } = run;
  if (run.layerAttempted && previousLayerBody && !run.previousLayerBootstrapped) {
    try {
      await syncAwsLayerAfterRoll(
        layerSync(run),
        previousLayerBody,
        createHash("sha256").update(previousLayerBody).digest("hex"),
      );
    } catch (restoreError) {
      compensationFailures.push(`restoring the pre-deploy deployment layer: ${errMessage(restoreError)}`);
    }
  } else if (run.layerAttempted && run.previousLayerBootstrapped) {
    warn(
      `the pre-deploy layer snapshot was synthesized (the core had no durable layer record) — leaving the core's layer as the failed sync left it rather than durably installing the empty bundle`,
    );
  }
  if (run.applied && run.before) {
    try {
      await applyServiceTargets(run.config, run.before.tasks, run.before.counts);
    } catch (restoreError) {
      compensationFailures.push(`restoring the pre-deploy manifest: ${errMessage(restoreError)}`);
    }
  }
  throwAfterCompensation(error, compensationFailures);
}

async function cleanUpStaging(run: UpRun): Promise<void> {
  const { aws } = run;
  for (const service of run.staged) {
    if (run.releaseSucceeded && !run.promoted.has(service)) continue;
    try {
      await ecr(aws).send(
        new BatchDeleteImageCommand({
          repositoryName: aws.services[service]!.ecrRepository,
          imageIds: [{ imageTag: STAGING_LABEL }],
        }),
      );
    } catch (error) {
      if (awsErrorCode(error) !== "ImageNotFoundException")
        warn(`could not clean staging image ${service}:${STAGING_LABEL}: ${errMessage(error)}`);
    }
  }
}

async function deployUp(run: UpRun, reportProgress: ReturnType<typeof deploymentProgress>): Promise<void> {
  const lease = await acquireLease(run.aws);
  try {
    const before = await prepareUpBaseline(run);
    await prepareUpLayer(run, before);
    const { images, provenance } = await publishUpImages(run);
    const { targets, changed, ...background } = await registerUpTasks(run, before, images);
    await rollOutUp(run, before, targets, changed, reportProgress);
    await recordUpRelease(run, before, targets, provenance, images, background);
  } catch (error) {
    if (run.releaseSucceeded) throw error;
    await compensateUp(run, error);
  } finally {
    await cleanUpStaging(run);
    await releaseLease(run.aws, lease);
  }
  ok(`AWS services stable on ${run.label} (deployment ${run.recorded?.id ?? run.current?.id})`);
}

export async function awsUp(config: QmConfig, configDir: string, opts: AwsUpOpts = {}): Promise<void> {
  const reportProgress = deploymentProgress(config, opts);
  const topology = awsTopology(config, configDir);
  const { aws } = topology;
  if (new URL(config.publicUrl).protocol !== "https:") {
    throw new CliError(
      "AWS deploy requires an HTTPS publicUrl; configure an ACM certificate, update publicUrl, and rerender/apply Terraform before running `qm up`",
    );
  }
  const plugins = new Map(topology.plugins.map((plugin) => [plugin.name, plugin]));
  const services = opts.only ? [...new Set(opts.only.map(serviceHost))] : topology.workloads;
  const { buildConcurrency, restart } = validateUpOptions(config, services, opts);
  if (opts.buildOnly) return buildUpCandidate(config, services, plugins, opts, buildConcurrency);
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
  const run: UpRun = {
    config,
    aws,
    opts,
    configDir,
    services,
    allServices,
    plugins,
    candidate,
    arns: await secretArns(config),
    restart,
    label,
    releaseId: randomUUID(),
    staged: new Set(),
    promoted: new Set(),
    applied: false,
    releaseSucceeded: false,
    previousLayerBootstrapped: false,
    layerChanged: false,
    layerAttempted: false,
    migratedCandidate: false,
  };
  if (opts.dryRun) return planUp(run);
  await deployUp(run, reportProgress);
}
