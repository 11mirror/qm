import {
  GetAuthorizationTokenCommand,
  DescribeImagesCommand,
  BatchGetImageCommand,
  PutImageCommand,
} from "@aws-sdk/client-ecr";
import {
  LambdaMicrovmsClient,
  GetMicrovmImageCommand,
  paginateListMicrovmImageVersions,
} from "@aws-sdk/client-lambda-microvms";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { awsErrorCode } from "../../aws-lease.ts";
import { awsClient } from "../../aws-sdk.ts";
import { type QmConfig, requiresAwsMicrovmImage, type AwsConfig } from "../../config.ts";
import { IMAGE_TAG } from "../../config-aws.ts";
import { CliError, errMessage } from "../../log.ts";
import { manifestRef } from "../../manifest.ts";
import { type ResolvedPlugin } from "../../plugins.ts";
import { type ServiceName, isServiceName } from "../../services.ts";
import { isMissingOrPlaceholder, resolveBuildRepoRoot, capture, runInheritAsync, runInherit } from "../../util.ts";
import { type AwsUpOpts, ecr, requireAws } from "./clients.ts";
import { workloadArchitecture } from "./task-definitions.ts";

function deployImageCoordinates(config: QmConfig): { name: string; version: string } {
  const name = config.env.core?.AWS_DEPLOY_IMAGE?.trim();
  const version = config.env.core?.AWS_DEPLOY_IMAGE_VERSION?.trim();
  if (!name || !version || isMissingOrPlaceholder(name) || isMissingOrPlaceholder(version)) {
    throw new CliError("AWS requires exact env.core.AWS_DEPLOY_IMAGE and AWS_DEPLOY_IMAGE_VERSION coordinates");
  }
  return { name, version };
}

export async function assertAwsDeployImage(config: QmConfig): Promise<void> {
  if (!requiresAwsMicrovmImage(config)) return;
  const aws = requireAws(config);
  const { name, version } = deployImageCoordinates(config);
  const expectedArn = `arn:aws:lambda:${aws.region}:${aws.accountId}:microvm-image:${name}`;
  const microvms = awsClient(LambdaMicrovmsClient, aws.region);
  const { imageArn } = await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: expectedArn }));
  if (imageArn !== expectedArn)
    throw new CliError(`AWS deploy image ${name} resolves to ${imageArn ?? "no ARN"}, expected ${expectedArn}`);
  for await (const page of paginateListMicrovmImageVersions({ client: microvms }, { imageIdentifier: expectedArn })) {
    const pinned = page.items?.find((item) => item.imageVersion === version);
    if (pinned?.state === "SUCCESSFUL" && pinned.status === "ACTIVE") return;
    if (pinned) break;
  }
  throw new CliError(`AWS deploy image ${name} version ${version} is not SUCCESSFUL and ACTIVE`);
}

export function ecrHost(aws: AwsConfig): string {
  return `${aws.accountId}.dkr.ecr.${aws.region}.amazonaws.com`;
}

export function expectedWorkloadImageRepository(config: QmConfig, workload: string): string {
  const aws = requireAws(config);
  const repository = aws.services[workload]?.ecrRepository;
  if (!repository) throw new CliError(`aws.services.${workload} is missing`);
  return `${ecrHost(aws)}/${repository}`;
}

export function isPinnedWorkloadImage(config: QmConfig, workload: string, image: string): boolean {
  const repository = expectedWorkloadImageRepository(config, workload).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${repository}@sha256:[0-9a-f]{64}$`).test(image);
}

export async function dockerLogin(aws: AwsConfig): Promise<void> {
  const { authorizationData } = await ecr(aws).send(new GetAuthorizationTokenCommand({}));
  const token = Buffer.from(authorizationData?.[0]?.authorizationToken ?? "", "base64").toString("utf8");
  const password = token.slice(token.indexOf(":") + 1);
  const result = spawnSync("docker", ["login", "--username", "AWS", "--password-stdin", ecrHost(aws)], {
    input: `${password}\n`,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) throw new CliError("docker login to ECR failed");
}

function sourceImage(config: QmConfig, service: ServiceName): string {
  return config.imageOverrides[service] ?? manifestRef(service);
}

export function workloadSourceImage(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
): string | undefined {
  return (
    plugin?.image ??
    config.plugins.find((entry) => entry.name === workload)?.image ??
    (isServiceName(workload) ? sourceImage(config, workload) : undefined)
  );
}

export function workloadImageProvenance(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
  opts: Pick<AwsUpOpts, "buildFrom" | "buildFromPath">,
): DeploymentImageProvenance {
  if (plugin?.kind === "source") {
    return { kind: "source-build", source: "plugin", ...sourceBuildInfo(plugin.sourceDir!) };
  }
  if (opts.buildFrom && isServiceName(workload)) {
    return {
      kind: "source-build",
      source: "checkout",
      ...sourceBuildInfo(resolveBuildRepoRoot(opts.buildFromPath, [workload])),
    };
  }
  const source = workloadSourceImage(config, workload, plugin);
  if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
  return { kind: "configured", source };
}

const sourceBuildInfoByRoot = new Map<string, { gitCommit?: string; dirty?: boolean }>();

function sourceBuildInfo(root: string): { gitCommit?: string; dirty?: boolean } {
  const cached = sourceBuildInfoByRoot.get(root);
  if (cached) return cached;
  const info: { gitCommit?: string; dirty?: boolean } = existsSync(join(root, ".git"))
    ? {
        gitCommit: capture("git", ["-C", root, "rev-parse", "HEAD"]).trim(),
        dirty: capture("git", ["-C", root, "status", "--porcelain"]).trim().length > 0,
      }
    : {};
  sourceBuildInfoByRoot.set(root, info);
  return info;
}

function sourceImageDigest(source: string): string {
  const pinned = source.match(/@(?<digest>sha256:[0-9a-f]{64})$/)?.groups?.digest;
  if (pinned) return pinned;
  const output = capture("docker", ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", source]);
  const digest = (JSON.parse(output) as { digest?: string }).digest;
  if (!digest?.startsWith("sha256:"))
    throw new CliError(`registry did not return an immutable digest for AWS source image ${source}`);
  return digest;
}

export function plannedWorkloadImage(config: QmConfig, workload: string, plugin: ResolvedPlugin | undefined): string {
  const source = workloadSourceImage(config, workload, plugin);
  if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
  return `${expectedWorkloadImageRepository(config, workload)}@${sourceImageDigest(source)}`;
}

function workloadBuildArgs(config: QmConfig, workload: string): Record<string, string> {
  return { ...requireAws(config).services[workload]?.buildArgs };
}

export function imageTransferArgs(source: string, tagged: string): string[] {
  return ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", tagged, source];
}

export async function publishWorkloadImage(
  config: QmConfig,
  workload: string,
  plugin: ResolvedPlugin | undefined,
  label: string,
  opts: AwsUpOpts,
  signal?: AbortSignal,
): Promise<string> {
  const aws = requireAws(config);
  const spec = aws.services[workload]!;
  const tagged = `${ecrHost(aws)}/${spec.ecrRepository}:${label}`;
  const platform = `linux/${workloadArchitecture(config, workload)}`;
  if (plugin?.kind === "source") {
    const args = [
      "buildx",
      "build",
      "--platform",
      platform,
      "--provenance=false",
      "--push",
      "-f",
      plugin.dockerfile!,
      "-t",
      tagged,
    ];
    for (const [name, value] of Object.entries(workloadBuildArgs(config, workload)))
      args.push("--build-arg", `${name}=${value}`);
    args.push(plugin.sourceDir!);
    if (signal) await runInheritAsync("docker", args, { signal });
    else runInherit("docker", args);
  } else if (opts.buildFrom && isServiceName(workload)) {
    const root = resolveBuildRepoRoot(opts.buildFromPath, [workload]);
    const dockerfile = join(root, spec.dockerfile ?? join("deploy", workload, "Dockerfile"));
    if (spec.dockerfile && !existsSync(dockerfile)) {
      throw new CliError(`aws.services.${workload}.dockerfile is missing from the build checkout: ${spec.dockerfile}`);
    }
    const args = [
      "buildx",
      "build",
      "--platform",
      platform,
      "--provenance=false",
      "--push",
      "-f",
      dockerfile,
      "-t",
      tagged,
    ];
    const info = sourceBuildInfo(root);
    if (info.gitCommit) args.push("--build-arg", `GIT_SHA=${info.gitCommit}${info.dirty ? "-dirty" : ""}`);
    for (const [name, value] of Object.entries(workloadBuildArgs(config, workload)))
      args.push("--build-arg", `${name}=${value}`);
    args.push(root);
    if (signal) await runInheritAsync("docker", args, { signal });
    else runInherit("docker", args);
  } else {
    const source = workloadSourceImage(config, workload, plugin);
    if (!source) throw new CliError(`AWS workload ${workload} has no source image`);
    if (signal) await runInheritAsync("docker", imageTransferArgs(source, tagged), { signal });
    else runInherit("docker", imageTransferArgs(source, tagged));
  }
  const response = await ecr(aws).send(
    new DescribeImagesCommand({ repositoryName: spec.ecrRepository, imageIds: [{ imageTag: label }] }),
  );
  const digest = response.imageDetails?.[0]?.imageDigest;
  if (!digest) throw new CliError(`ECR did not return a digest for ${tagged}`);
  return `${ecrHost(aws)}/${spec.ecrRepository}@${digest}`;
}

export function releaseCandidate(config: QmConfig, path: string): AwsReleaseCandidate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(`could not read AWS release candidate ${path}: ${errMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(`AWS release candidate ${path} is not an object`);
  }
  const candidate = parsed as Partial<AwsReleaseCandidate>;
  const aws = requireAws(config);
  if (
    candidate.contract !== 1 ||
    candidate.accountId !== aws.accountId ||
    candidate.region !== aws.region ||
    typeof candidate.label !== "string" ||
    !IMAGE_TAG.test(candidate.label) ||
    !candidate.images ||
    typeof candidate.images !== "object" ||
    Array.isArray(candidate.images) ||
    !candidate.imageProvenance ||
    typeof candidate.imageProvenance !== "object" ||
    Array.isArray(candidate.imageProvenance) ||
    (candidate.architectures !== undefined &&
      (!candidate.architectures ||
        typeof candidate.architectures !== "object" ||
        Array.isArray(candidate.architectures)))
  ) {
    throw new CliError(`AWS release candidate ${path} has an invalid contract or targets another AWS account/region`);
  }
  for (const [workload, architecture] of Object.entries(candidate.architectures ?? {})) {
    if (!candidate.images[workload] || (architecture !== "arm64" && architecture !== "amd64"))
      throw new CliError(`AWS release candidate ${path} has an invalid ${workload} architecture`);
  }
  for (const [workload, image] of Object.entries(candidate.images)) {
    const provenance = candidate.imageProvenance[workload];
    const validProvenance =
      provenance?.kind === "configured"
        ? typeof provenance.source === "string"
        : provenance?.kind === "source-build" &&
          (provenance.source === undefined || provenance.source === "plugin" || provenance.source === "checkout") &&
          (provenance.gitCommit === undefined || typeof provenance.gitCommit === "string") &&
          (provenance.dirty === undefined || typeof provenance.dirty === "boolean");
    if (
      !aws.services[workload] ||
      typeof image !== "string" ||
      !isPinnedWorkloadImage(config, workload, image) ||
      !validProvenance
    ) {
      throw new CliError(`AWS release candidate ${path} has an invalid ${workload} image or provenance`);
    }
    const architecture = candidate.architectures?.[workload];
    if (candidate.architectures && architecture !== workloadArchitecture(config, workload))
      throw new CliError(
        `AWS release candidate ${path} architecture for ${workload} does not match its configuration; use a matching architecture or rebuild the candidate`,
      );
    if (
      architecture === undefined &&
      provenance?.kind === "source-build" &&
      isServiceName(workload) &&
      !aws.services[workload]!.architecture
    )
      throw new CliError(
        `AWS release candidate ${path} has no architecture for source-built ${workload}; set aws.services.${workload}.architecture to the image platform or rebuild the candidate`,
      );
  }
  return candidate as AwsReleaseCandidate;
}

export type DeploymentImageProvenance =
  | { kind: "configured"; source: string }
  | { kind: "source-build"; source?: "plugin" | "checkout"; gitCommit?: string; dirty?: boolean };

export interface AwsReleaseCandidate {
  contract: 1;
  accountId: string;
  region: string;
  label: string;
  images: Record<string, string>;
  imageProvenance: Record<string, DeploymentImageProvenance>;
  architectures?: Record<string, "arm64" | "amd64">;
}

export async function promoteStagedImage(
  config: QmConfig,
  service: string,
  image: string,
  label: string,
): Promise<void> {
  const aws = requireAws(config);
  const repositoryName = aws.services[service]!.ecrRepository;
  const digest = image.split("@")[1];
  if (!digest) throw new CliError(`staged image for ${service} is not digest-pinned`);
  const { images } = await ecr(aws).send(
    new BatchGetImageCommand({ repositoryName, imageIds: [{ imageDigest: digest }] }),
  );
  const staged = images?.[0];
  if (!staged?.imageManifest) throw new CliError(`ECR did not return the staged manifest for ${service}@${digest}`);
  try {
    await ecr(aws).send(
      new PutImageCommand({
        repositoryName,
        imageTag: label,
        imageManifest: staged.imageManifest,
        imageManifestMediaType: staged.imageManifestMediaType,
      }),
    );
  } catch (error) {
    if (awsErrorCode(error) !== "ImageAlreadyExistsException") throw error;
  }
}
