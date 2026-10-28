import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { zipSync, type ZipOptions } from "fflate";
import {
  DeleteTaskDefinitionsCommand,
  DeregisterTaskDefinitionCommand,
  ECSClient,
  ListTagsForResourceCommand,
  paginateListTaskDefinitions,
} from "@aws-sdk/client-ecs";
import {
  CreateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListTagsCommand,
  paginateListMicrovmImages,
  paginateListMicrovms,
  TerminateMicrovmCommand,
  UpdateMicrovmImageCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { awsErrorCode, withAwsLease } from "../aws-lease.ts";
import { awsClient } from "../aws-sdk.ts";
import { updateConfigCoreEnv, type QmConfig } from "../config.ts";
import { CliError, ok, step } from "../log.ts";
import { awsObjectStoreBucket } from "../terraform.ts";
import { sleep } from "../util.ts";
import { templateUrl } from "../templates.ts";

interface ImageSummary {
  name?: string | undefined;
  imageArn?: string | undefined;
  state?: string | undefined;
  tags?: Record<string, string>;
}

interface InfraWaitOptions {
  sleep?: (ms: number) => Promise<void>;
}

type AwsAccount = NonNullable<QmConfig["aws"]>;
const microvms = (aws: AwsAccount) => awsClient(LambdaMicrovmsClient, aws.region);
const ecs = (aws: AwsAccount) => awsClient(ECSClient, aws.region);
const IN_TRANSITION = ["CREATING", "UPDATING", "DELETING"];

function asset(name: string): Buffer {
  return readFileSync(templateUrl(`aws/microvm-agent/${name}`));
}

export function microvmBuildArchive(): Buffer {
  const entry = (name: string): [Uint8Array, ZipOptions] => [asset(name), { level: 9, mtime: new Date(1980, 0, 1) }];
  return Buffer.from(zipSync({ Dockerfile: entry("Dockerfile"), "agent.mjs": entry("agent.mjs") }));
}

async function findImage(aws: AwsAccount, imageName: string): Promise<ImageSummary | undefined> {
  for await (const page of paginateListMicrovmImages({ client: microvms(aws) }, { nameFilter: imageName })) {
    const image = page.items?.find((item) => item.name === imageName);
    if (image) return image;
  }
  return undefined;
}

function configuredAws(config: QmConfig, operation: string): Promise<{ aws: AwsAccount; imageName: string }> {
  if (!config.aws || config.target !== "aws") throw new CliError(`${operation} is only available for target aws`);
  const imageName = config.env.core?.AWS_DEPLOY_IMAGE;
  if (!imageName) throw new CliError("env.core.AWS_DEPLOY_IMAGE is required");
  return configuredAwsAccount(config, operation).then((aws) => ({ aws, imageName }));
}

async function configuredAwsAccount(config: QmConfig, operation: string): Promise<AwsAccount> {
  if (!config.aws || config.target !== "aws") throw new CliError(`${operation} is only available for target aws`);
  const { Account } = await awsClient(STSClient, config.aws.region).send(new GetCallerIdentityCommand({}));
  if (Account !== config.aws.accountId) {
    throw new CliError(`AWS account mismatch: config=${config.aws.accountId}, credentials=${Account}`);
  }
  return config.aws;
}

function taskDefinitionFamily(arn: string): string | undefined {
  const marker = ":task-definition/";
  const start = arn.indexOf(marker);
  if (start === -1) return undefined;
  return arn.slice(start + marker.length).replace(/:\d+$/, "");
}

async function listTaskDefinitions(aws: AwsAccount, family: string, status: "ACTIVE" | "INACTIVE"): Promise<string[]> {
  const arns: string[] = [];
  for await (const page of paginateListTaskDefinitions({ client: ecs(aws) }, { familyPrefix: family, status }))
    arns.push(...(page.taskDefinitionArns ?? []));
  return arns.filter((arn) => taskDefinitionFamily(arn) === family);
}

async function assertTaskDefinitionOwnership(config: QmConfig, aws: AwsAccount, arn: string): Promise<void> {
  const { tags = [] } = await ecs(aws).send(new ListTagsForResourceCommand({ resourceArn: arn }));
  const byKey = Object.fromEntries(
    tags.flatMap((tag) => (tag.key && tag.value ? [[tag.key, tag.value] as const] : [])),
  );
  if (byKey["Deployment"] !== config.orgId || !["qm-cli", "terraform"].includes(byKey["ManagedBy"] ?? "")) {
    throw new CliError(
      `refusing to delete task definition ${arn}: ownership tags do not match deployment ${config.orgId}`,
    );
  }
}

export async function deleteAwsTaskDefinitions(config: QmConfig): Promise<void> {
  const aws = await configuredAwsAccount(config, "infra delete-task-definitions");
  await withAwsLease(aws, async () => {
    for (const family of [...new Set(Object.values(aws.services).map((service) => service.ecsService))].sort()) {
      const active = await listTaskDefinitions(aws, family, "ACTIVE");
      const inactive = await listTaskDefinitions(aws, family, "INACTIVE");
      const revisions = [...new Set([...active, ...inactive])];
      for (const arn of revisions) await assertTaskDefinitionOwnership(config, aws, arn);
      for (const arn of active) await ecs(aws).send(new DeregisterTaskDefinitionCommand({ taskDefinition: arn }));
      for (let index = 0; index < revisions.length; index += 10) {
        const { failures } = await ecs(aws).send(
          new DeleteTaskDefinitionsCommand({ taskDefinitions: revisions.slice(index, index + 10) }),
        );
        if (failures?.length) {
          throw new CliError(
            `failed to delete task definitions: ${failures.map((failure) => `${failure.arn ?? "unknown"} (${failure.reason ?? failure.detail ?? "unknown"})`).join(", ")}`,
          );
        }
      }
      ok(`deleted ${revisions.length} task definition revision${revisions.length === 1 ? "" : "s"} for ${family}`);
    }
  });
}

async function assertImageIdentity(config: QmConfig, image: ImageSummary): Promise<ImageSummary> {
  const expectedName = config.env.core!.AWS_DEPLOY_IMAGE!;
  const expectedArn = `arn:aws:lambda:${config.aws!.region}:${config.aws!.accountId}:microvm-image:${expectedName}`;
  if (image.name !== expectedName) throw new CliError(`refusing to manage unexpected MicroVM image name ${image.name}`);
  if (image.imageArn !== expectedArn)
    throw new CliError(`refusing to manage unexpected MicroVM image ARN ${image.imageArn}`);
  const { Tags: tags = {} } = await microvms(config.aws!).send(new ListTagsCommand({ Resource: image.imageArn }));
  if (tags["ManagedBy"] !== "qm-cli" || tags["Deployment"] !== config.orgId) {
    throw new CliError(
      `refusing to manage MicroVM image ${image.name}: ownership tags do not match deployment ${config.orgId}`,
    );
  }
  return { ...image, tags };
}

async function settledImage(
  config: QmConfig,
  imageName: string,
  options: InfraWaitOptions,
): Promise<ImageSummary | undefined> {
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const image = await findImage(config.aws!, imageName);
    if (!image || image.state === "DELETED") return undefined;
    if (!IN_TRANSITION.includes(image.state ?? "")) return assertImageIdentity(config, image);
    if (Date.now() >= deadline) throw new CliError(`timed out waiting for MicroVM image ${imageName}`);
    await wait(10_000);
  }
}

async function waitForImageVersion(
  aws: AwsAccount,
  imageArn: string,
  imageVersion: string,
  options: InfraWaitOptions,
): Promise<void> {
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const version = await microvms(aws).send(
      new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion }),
    );
    if (version.imageVersion !== imageVersion) {
      throw new CliError(`MicroVM image version response changed from ${imageVersion} to ${version.imageVersion}`);
    }
    if (version.state === "SUCCESSFUL" && version.status === "ACTIVE") return;
    if (version.state === "FAILED") {
      throw new CliError(
        `MicroVM image version ${imageVersion} failed${version.stateReason ? `: ${version.stateReason}` : ""}`,
      );
    }
    if (["DELETING", "DELETED", "DELETE_FAILED"].includes(version.state ?? "")) {
      throw new CliError(`MicroVM image version ${imageVersion} entered unexpected state ${version.state}`);
    }
    if (Date.now() >= deadline) throw new CliError(`timed out waiting for MicroVM image version ${imageVersion}`);
    await wait(10_000);
  }
}

function recordImagePin(
  configPath: string,
  imageArn: string,
  version: string,
  executionRoleArn: string,
): { imageArn: string; version: string } {
  const raw = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    updateConfigCoreEnv(raw, {
      AWS_DEPLOY_IMAGE_VERSION: version,
      AWS_DEPLOY_EXEC_ROLE_ARN: executionRoleArn,
    }),
  );
  ok(`built ${imageArn} version ${version}`);
  ok("recorded AWS_DEPLOY_IMAGE_VERSION and AWS_DEPLOY_EXEC_ROLE_ARN in the QM deployment config");
  return { imageArn, version };
}

export async function buildAwsMicrovmImage(
  config: QmConfig,
  configPath: string,
  options: InfraWaitOptions = {},
): Promise<{ imageArn: string; version: string }> {
  const configured = await configuredAws(config, "infra build-image");
  return withAwsLease(configured.aws, () => buildAwsMicrovmImageLocked(config, configPath, options, configured));
}

async function buildAwsMicrovmImageLocked(
  config: QmConfig,
  configPath: string,
  options: InfraWaitOptions,
  { aws, imageName }: { aws: AwsAccount; imageName: string },
): Promise<{ imageArn: string; version: string }> {
  const archive = microvmBuildArchive();
  const digest = createHash("sha256").update(archive).digest("hex");
  const bucket = awsObjectStoreBucket(config);
  const key = `deployment/microvm-images/${digest}.zip`;
  const uri = `s3://${bucket}/${key}`;
  const buildRoleArn = `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-build`;
  const defaultExecutionRoleArn = `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-microvm-exec`;
  const executionRoleArn = config.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN ?? defaultExecutionRoleArn;
  if (!new RegExp(`^arn:aws[a-z-]*:iam::${aws.accountId}:role/[A-Za-z0-9_+=,.@/-]+$`).test(executionRoleArn)) {
    throw new CliError("AWS_DEPLOY_EXEC_ROLE_ARN must name a role in the configured AWS account");
  }
  const baseImageArn = `arn:aws:lambda:${aws.region}:aws:microvm-image:al2023-1`;
  const found = await findImage(aws, imageName);
  let existing = found && found.state !== "DELETED" ? await assertImageIdentity(config, found) : undefined;
  if (existing && IN_TRANSITION.includes(existing.state ?? "")) {
    if (existing.state !== "DELETING")
      step(`waiting for the in-progress ${imageName} image build before starting this build`);
    existing = await settledImage(config, imageName, options);
  }
  if (existing?.state === "DELETE_FAILED") throw new CliError(`MicroVM image ${imageName} is in state DELETE_FAILED`);
  await awsClient(S3Client, aws.region).send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: archive }));
  step(`uploaded ${uri}`);
  const wait = options.sleep ?? sleep;
  const deadline = Date.now() + 15 * 60_000;
  let operation: ImageSummary & { imageVersion?: string | undefined };
  for (;;) {
    const artifact = { codeArtifact: { uri }, baseImageArn, buildRoleArn, clientToken: `${digest}-${randomUUID()}` };
    try {
      const tags = { ManagedBy: "qm-cli", Deployment: config.orgId };
      operation = existing
        ? await microvms(aws).send(new UpdateMicrovmImageCommand({ imageIdentifier: existing.imageArn, ...artifact }))
        : await microvms(aws).send(new CreateMicrovmImageCommand({ name: imageName, tags, ...artifact }));
      step(`${existing ? "updating" : "creating"} ${imageName}`);
      break;
    } catch (error) {
      if (awsErrorCode(error) !== "ConflictException") throw error;
      if (Date.now() >= deadline) throw new CliError(`timed out waiting to start MicroVM image build ${imageName}`);
      step(`another ${imageName} image operation started; waiting for it before retrying this build`);
      await wait(10_000);
      existing = await settledImage(config, imageName, options);
    }
  }
  if (!operation.imageArn || !operation.imageVersion) {
    throw new CliError(`AWS did not return the MicroVM image ARN and version for ${imageName}`);
  }
  await assertImageIdentity(config, { ...operation, name: operation.name || imageName });
  await waitForImageVersion(aws, operation.imageArn, operation.imageVersion, options);
  return recordImagePin(configPath, operation.imageArn, operation.imageVersion, executionRoleArn);
}

async function deleteMicrovmBuildArtifacts(config: QmConfig): Promise<void> {
  const s3 = awsClient(S3Client, config.aws!.region);
  const bucket = awsObjectStoreBucket(config);
  const prefix = "deployment/microvm-images/";
  const objects: Array<{ Key: string; VersionId: string | undefined }> = [];
  let page: ListObjectVersionsCommandOutput | undefined;
  do {
    page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: page?.NextKeyMarker,
        VersionIdMarker: page?.NextVersionIdMarker,
      }),
    );
    for (const object of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])])
      if (object.Key?.startsWith(prefix)) objects.push({ Key: object.Key, VersionId: object.VersionId });
  } while (page.IsTruncated);
  for (let index = 0; index < objects.length; index += 1000) {
    const { Errors } = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.slice(index, index + 1000), Quiet: true },
      }),
    );
    if (Errors?.length) {
      throw new CliError(
        `failed to delete MicroVM build artifacts: ${Errors.map((error) => `${error.Key ?? "unknown"}@${error.VersionId ?? "unknown"} (${error.Code ?? "unknown"})`).join(", ")}`,
      );
    }
  }
  ok(`deleted ${objects.length} MicroVM build artifact version${objects.length === 1 ? "" : "s"}`);
}

export async function deleteAwsMicrovmImage(config: QmConfig, options: InfraWaitOptions = {}): Promise<void> {
  const configured = await configuredAws(config, "infra delete-image");
  return withAwsLease(configured.aws, () => deleteAwsMicrovmImageLocked(config, options, configured));
}

async function deleteAwsMicrovmImageLocked(
  config: QmConfig,
  options: InfraWaitOptions,
  { aws, imageName }: { aws: AwsAccount; imageName: string },
): Promise<void> {
  const expectedArn = `arn:aws:lambda:${aws.region}:${aws.accountId}:microvm-image:${imageName}`;
  const found = await findImage(aws, imageName);
  if (!found || found.state === "DELETED") {
    ok(`MicroVM image ${imageName} is already deleted`);
    return deleteMicrovmBuildArtifacts(config);
  }
  await assertImageIdentity(config, found);
  if (IN_TRANSITION.includes(found.state ?? "")) {
    step(`waiting for ${imageName} to leave state ${found.state}`);
    if (!(await settledImage(config, imageName, options))) {
      ok(`MicroVM image ${imageName} is deleted`);
      return deleteMicrovmBuildArtifacts(config);
    }
  }

  const wait = options.sleep ?? sleep;
  let deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const active = [];
    for await (const page of paginateListMicrovms({ client: microvms(aws) }, { imageIdentifier: expectedArn }))
      active.push(...(page.items ?? []).filter((microvm) => microvm.state !== "TERMINATED"));
    for (const microvm of active) {
      if (microvm.state === "TERMINATING") continue;
      await microvms(aws).send(new TerminateMicrovmCommand({ microvmIdentifier: microvm.microvmId }));
      step(`terminating MicroVM ${microvm.microvmId}`);
    }
    if (active.length === 0) break;
    if (Date.now() >= deadline) throw new CliError(`timed out terminating MicroVMs for image ${imageName}`);
    await wait(10_000);
  }

  await microvms(aws).send(new DeleteMicrovmImageCommand({ imageIdentifier: expectedArn }));
  step(`deleting MicroVM image ${imageName}`);
  deadline = Date.now() + 15 * 60_000;
  for (;;) {
    const image = await findImage(aws, imageName);
    if (!image || image.state === "DELETED") {
      ok(`deleted MicroVM image ${imageName}`);
      return deleteMicrovmBuildArtifacts(config);
    }
    if (image.state === "DELETE_FAILED") throw new CliError(`MicroVM image ${imageName} failed to delete`);
    if (Date.now() >= deadline) throw new CliError(`timed out deleting MicroVM image ${imageName}`);
    await wait(10_000);
  }
}
