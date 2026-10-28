import { CloudWatchLogsClient, paginateDescribeLogGroups } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { EC2Client, DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { DescribeRepositoriesCommand } from "@aws-sdk/client-ecr";
import { DescribeClustersCommand, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { GetRoleCommand, GetOpenIDConnectProviderCommand } from "@aws-sdk/client-iam";
import { ListObjectsV2Command, HeadBucketCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deployLocksTable, awsErrorCode } from "../../aws-lease.ts";
import { awsClient } from "../../aws-sdk.ts";
import { canonicalJson } from "../../canonical-json.ts";
import { type QmConfig } from "../../config.ts";
import { deploymentLayerBody, currentDeploymentLayerState } from "../../deployment-layer.ts";
import { checkControlledLiveSession } from "../../live-session.ts";
import { header, step, warn, errMessage, CliError, ok } from "../../log.ts";
import { computedSecrets } from "../../secrets.ts";
import { isServiceName } from "../../services.ts";
import { hclString, awsObjectStoreBucket, declaredVariables, terraformVarsDrift } from "../../terraform.ts";
import { capture, isInvalidSecret } from "../../util.ts";
import { doctorCommon } from "../doctor.ts";
import { type ResolvedPlugin } from "../../plugins.ts";
import { awsBackgroundWorkStatus, awsBackgroundWorkTransport } from "./background-work.ts";
import {
  all,
  assertAwsCallerAccount,
  awsSecretString,
  awsTopology,
  describeDbInstance,
  describeTaskDefinition,
  dynamo,
  ecr,
  ecs,
  iam,
  rdsInstanceIdentifier,
  requireAws,
  s3,
  type EcsServiceState,
} from "./clients.ts";
import {
  assertAwsDeployImage,
  expectedWorkloadImageRepository,
  isPinnedWorkloadImage,
  plannedWorkloadImage,
  workloadSourceImage,
} from "./images.ts";
import {
  currentDeploymentManifest,
  getDeploymentLayerArtifact,
  retryLiveProbe,
  type DeploymentManifest,
} from "./manifest.ts";
import { awsLiveSession, describedServices, workloadDesiredCount } from "./rollout.ts";
import {
  type AwsEcsRoutingService,
  assertAwsHealthyIngress,
  assertAwsPublicNetwork,
  assertAwsPublicRouting,
  assertAwsServiceDiscovery,
  awsDeploymentLayerTransport,
} from "./routing.ts";
import {
  assertAwsPublicApiUrl,
  containerSecretNames,
  renderTaskDefinition,
  secretArns,
  taskDefinitionDiff,
  workloadEnvironment,
  workloadSecrets,
} from "./task-definitions.ts";

export function githubTrustSubject(configDir: string, deployBranch?: string, deployEnvironment?: string): string {
  const tfvars = join(configDir, "infra", "terraform.tfvars");
  const source = existsSync(tfvars) ? readFileSync(tfvars, "utf8") : undefined;
  const tfValue = (name: string): string | undefined => (source === undefined ? undefined : hclString(source, name));
  let repo = process.env.GITHUB_REPOSITORY;
  if (!repo && source !== undefined) {
    repo = tfValue("github_repository");
    if (!repo || repo === "replace-me/repository" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("infra/terraform.tfvars must set an explicit github_repository owner/name");
    }
  }
  if (!repo) {
    const remote = capture("git", ["-C", configDir, "config", "--get", "remote.origin.url"]).trim();
    repo = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1];
    if (!repo) throw new Error("cannot derive the GitHub repository from this deployment checkout");
  }
  const configuredPrefix = tfValue("github_subject_prefix");
  if (
    configuredPrefix !== undefined &&
    configuredPrefix !== "" &&
    !/^repo:[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@-]+$/.test(configuredPrefix)
  ) {
    throw new Error("infra/terraform.tfvars github_subject_prefix must be an exact repo:owner/repository prefix");
  }
  const subjectPrefix = configuredPrefix || `repo:${repo}`;
  if (deployEnvironment) return `${subjectPrefix}:environment:${deployEnvironment}`;
  const tfRef = tfValue("github_ref");
  if (tfRef !== undefined && !/^refs\/heads\/\S+$/.test(tfRef)) {
    throw new Error("infra/terraform.tfvars github_ref must be a refs/heads/* branch ref");
  }
  const ref = deployBranch ? `refs/heads/${deployBranch}` : (tfRef ?? "refs/heads/main");
  return `${subjectPrefix}:ref:${ref}`;
}

export function assertGithubDeployTrust(statements: unknown, accountId: string, expectedSubject: string): void {
  let list: unknown[] = [];
  if (Array.isArray(statements)) list = statements;
  else if (statements) list = [statements];
  if (list.length !== 1 || typeof list[0] !== "object" || list[0] === null || Array.isArray(list[0])) {
    throw new Error("deploy role must have exactly one trust statement");
  }
  const statement = list[0] as Record<string, unknown>;
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  if (statement.Effect !== "Allow" || actions.length !== 1 || actions[0] !== "sts:AssumeRoleWithWebIdentity") {
    throw new Error("deploy role trust must only allow GitHub OIDC assumption");
  }
  const principal = statement.Principal as Record<string, unknown> | undefined;
  if (
    principal?.Federated !== `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com` ||
    Object.keys(principal).length !== 1
  ) {
    throw new Error("deploy role trust must name only the account's GitHub OIDC provider");
  }
  const condition = statement.Condition as Record<string, unknown> | undefined;
  const equals = condition?.StringEquals as Record<string, unknown> | undefined;
  const live = equals?.["token.actions.githubusercontent.com:sub"];
  const rawSubjects: unknown[] = Array.isArray(live) ? live : [live].filter((s) => s !== undefined);
  const withoutIdPins = (subject: string): string =>
    subject.replace(/^repo:([^/:@]+)(?:@\d+)?\/([^/:@]+)(?:@\d+)?:/, "repo:$1/$2:");
  const expectedPinsIds = withoutIdPins(expectedSubject) !== expectedSubject;
  const subjects = expectedPinsIds
    ? rawSubjects
    : rawSubjects.map((subject) => (typeof subject === "string" ? withoutIdPins(subject) : subject));
  const repoPrefix = `${expectedSubject.split(":").slice(0, 2).join(":")}:`;
  if (
    !condition ||
    Object.keys(condition).length !== 1 ||
    !equals ||
    Object.keys(equals).length !== 2 ||
    equals["token.actions.githubusercontent.com:aud"] !== "sts.amazonaws.com" ||
    !subjects.includes(expectedSubject) ||
    !subjects.every(
      (subject) => typeof subject === "string" && subject.startsWith(repoPrefix) && !subject.includes("*"),
    )
  ) {
    const rendered = rawSubjects.length > 0 ? rawSubjects.join(", ") : "missing";
    throw new Error(
      `OIDC trust must pin audience and only ${repoPrefix}* subjects including ${expectedSubject} (live subject: ${rendered})`,
    );
  }
}

export async function assertAwsDeploymentStorage(config: QmConfig): Promise<void> {
  const aws = requireAws(config);
  const tableName = deployLocksTable(aws);
  const { Table: table } = await dynamo(aws).send(new DescribeTableCommand({ TableName: tableName }));
  if (table?.TableStatus !== "ACTIVE")
    throw new Error(`deploy-lock table ${tableName} is ${table?.TableStatus ?? "missing"}`);
  await s3(config).send(
    new ListObjectsV2Command({ Bucket: awsObjectStoreBucket(config), Prefix: "deployment/", MaxKeys: 1 }),
  );
}

type DoctorCheck = (label: string, fn: () => unknown) => Promise<void>;

async function doctorInfrastructure(config: QmConfig, configDir: string, check: DoctorCheck): Promise<void> {
  const aws = requireAws(config);
  const tfvarsPath = join(configDir, "infra", "terraform.tfvars");
  if (existsSync(tfvarsPath))
    await check("Terraform coordinates", async () => {
      const path = tfvarsPath;
      const existing = readFileSync(path, "utf8");
      const variablesPath = join(configDir, "infra", "variables.tf");
      const declared = existsSync(variablesPath) ? declaredVariables(readFileSync(variablesPath, "utf8")) : [];
      const drift = terraformVarsDrift(config, existing, declared);
      if (drift.length)
        throw new Error(`terraform.tfvars drift (${drift.join(", ")}); run \`qm infra render\` and commit the result`);
    });
  else step("Terraform coordinates: external infrastructure (no vendored infra/terraform.tfvars)");
  await check("ECS cluster", async () => {
    const cluster = (await ecs(aws).send(new DescribeClustersCommand({ clusters: [aws.cluster] }))).clusters?.[0];
    if (cluster?.status !== "ACTIVE") throw new Error(`cluster is ${cluster?.status ?? "missing"}`);
  });
  await check("deployment state stores", () => assertAwsDeploymentStorage(config));
  const snapshotBucket = config.env.core?.S3_BUCKET?.trim();
  if (snapshotBucket)
    await check(`core S3 bucket ${snapshotBucket}`, async () => {
      try {
        await s3(config).send(new HeadBucketCommand({ Bucket: snapshotBucket }));
      } catch (error) {
        throw new Error(`the env.core.S3_BUCKET override is missing or not readable: ${errMessage(error)}`, {
          cause: error,
        });
      }
    });
  await check("Lambda MicroVM deploy image", () => assertAwsDeployImage(config));
}

async function doctorIdentity(config: QmConfig, configDir: string, check: DoctorCheck): Promise<void> {
  const aws = requireAws(config);
  await check("deploy role", async () => {
    const expectedSubject = githubTrustSubject(configDir, aws.deployBranch, aws.deployEnvironment);
    const { Role: role } = await iam(aws).send(new GetRoleCommand({ RoleName: aws.deployRoleArn.split("/").pop()! }));
    if (role?.Arn !== aws.deployRoleArn) throw new Error("role ARN differs from config");
    const trust = JSON.parse(decodeURIComponent(role.AssumeRolePolicyDocument ?? "{}")) as { Statement?: unknown };
    assertGithubDeployTrust(trust.Statement, aws.accountId, expectedSubject);
    if (process.env.GITHUB_ACTIONS === "true") {
      const caller = await awsClient(STSClient, aws.region).send(new GetCallerIdentityCommand({}));
      const roleName = aws.deployRoleArn.split("/").pop()!;
      if (!caller.Arn?.includes(`:assumed-role/${roleName}/`))
        throw new Error("workflow is not actually running as the configured deploy role");
    }
  });
  await check("GitHub OIDC provider", async () => {
    const arn = `arn:aws:iam::${aws.accountId}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = await iam(aws).send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn }));
    if (provider.Url !== "token.actions.githubusercontent.com")
      throw new Error("GitHub OIDC provider URL is incorrect");
    if (!provider.ClientIDList?.includes("sts.amazonaws.com"))
      throw new Error("GitHub OIDC provider does not trust sts.amazonaws.com");
  });
}

async function doctorDatabase(config: QmConfig, check: DoctorCheck): Promise<void> {
  const aws = requireAws(config);
  await check("RDS", async () => {
    const database = await describeDbInstance(aws, rdsInstanceIdentifier(aws));
    if (database?.DBInstanceStatus !== "available" && database?.DBInstanceStatus !== "storage-optimization")
      throw new Error(`database is ${database?.DBInstanceStatus || "missing"}`);
    const coreService = aws.services.core;
    if (!coreService) throw new Error("aws.services.core is missing");
    const described = await ecs(aws).send(
      new DescribeServicesCommand({ cluster: aws.cluster, services: [coreService.ecsService] }),
    );
    const coreGroups = described.services?.[0]?.networkConfiguration?.awsvpcConfiguration?.securityGroups ?? [];
    const databaseGroups = (database.VpcSecurityGroups ?? []).flatMap((group) =>
      group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
    );
    const ec2 = awsClient(EC2Client, aws.region);
    const permissions = databaseGroups.length
      ? ((await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: databaseGroups }))).SecurityGroups?.flatMap(
          (group) => group.IpPermissions ?? [],
        ) ?? [])
      : [];
    const reachable = permissions.some(
      (permission) =>
        permission.IpProtocol === "tcp" &&
        (permission.FromPort ?? Infinity) <= 5432 &&
        (permission.ToPort ?? -Infinity) >= 5432 &&
        (permission.UserIdGroupPairs ?? []).some((pair) => pair.GroupId && coreGroups.includes(pair.GroupId)),
    );
    if (!reachable) throw new Error("database security groups do not allow the core ECS service on port 5432");
    const databaseUrl = await awsSecretString(aws, "DATABASE_URL");
    if (!database.Endpoint?.Address || new URL(databaseUrl).hostname !== database.Endpoint.Address)
      throw new Error("DATABASE_URL does not point at the configured RDS endpoint");
  });
}

async function doctorServices(config: QmConfig, check: DoctorCheck): Promise<void> {
  const aws = requireAws(config);
  const ecsServices = new Map<string, AwsEcsRoutingService>();
  for (const service of Object.keys(aws.services)) {
    const spec = aws.services[service]!;
    await check(`ECS service ${spec.ecsService}`, async () => {
      const described = await ecs(aws).send(
        new DescribeServicesCommand({ cluster: aws.cluster, services: [spec.ecsService] }),
      );
      const found = described.services?.[0] as AwsEcsRoutingService | undefined;
      if (found?.status !== "ACTIVE") throw new Error(`service is ${found?.status ?? "missing"}`);
      ecsServices.set(service, found);
    });
    await check(`ECR ${spec.ecrRepository}`, async () => {
      const { repositories } = await ecr(aws).send(
        new DescribeRepositoriesCommand({ repositoryNames: [spec.ecrRepository] }),
      );
      const repository = repositories?.[0];
      if (!repository?.repositoryArn) throw new Error("repository is missing");
    });
  }
  const logGroups = new Map<string, string[]>();
  for (const [name, spec] of Object.entries(aws.services)) {
    const group = spec.logGroup ?? `/ecs/${spec.ecsService}`;
    logGroups.set(group, [...(logGroups.get(group) ?? []), name]);
  }
  for (const [group, names] of logGroups) {
    await check(`CloudWatch log group ${group}`, async () => {
      const logs = { client: awsClient(CloudWatchLogsClient, aws.region) };
      const found = await all(paginateDescribeLogGroups(logs, { logGroupNamePrefix: group }), (page) => page.logGroups);
      if (!found.some((item) => item.logGroupName === group)) {
        throw new Error(
          `log group is missing — the awslogs driver refuses to start ${names.join(", ")} without it; create it or fix aws.services.${names.join("/")}.logGroup`,
        );
      }
    });
  }
  await check("Cloud Map routing", () => assertAwsServiceDiscovery(config, ecsServices));
  await check("ALB routing", async () => void (await assertAwsPublicRouting(config, ecsServices)));
  await check("public URL DNS and TLS", () => assertAwsPublicNetwork(config));
}

async function doctorSecrets(config: QmConfig, check: DoctorCheck, failures: string[]): Promise<Map<string, string>> {
  const aws = requireAws(config);
  const runtimeSecrets = new Map<string, string>();
  for (const secret of computedSecrets(config)) {
    const inspect = async (): Promise<void> => {
      const value = await awsSecretString(aws, secret.name);
      if (isInvalidSecret(secret.name, value)) throw new Error("missing, placeholder, or insecure value");
      runtimeSecrets.set(secret.name, value);
    };
    if (secret.required)
      await check(`secret ${secret.name}`, async () => {
        await inspect();
        if (secret.name === "PUBLIC_API_URL") await assertAwsPublicApiUrl(config);
      });
    else {
      try {
        await inspect();
        step(`optional secret ${secret.name}: configured`);
      } catch (error) {
        const code = awsErrorCode(error);
        if (code === "ResourceNotFoundException") warn(`optional secret ${secret.name}: not configured`);
        else if (code === "AccessDeniedException") warn(`optional secret ${secret.name}: not readable by this role`);
        else {
          failures.push(`optional secret ${secret.name}: ${errMessage(error)}`);
          warn(`optional secret ${secret.name}: failed`);
        }
      }
    }
  }
  return runtimeSecrets;
}

export async function awsDoctor(config: QmConfig, configDir: string): Promise<void> {
  const { aws } = awsTopology(config, configDir);
  header(`qm doctor — ${config.orgId} (aws)`);
  await assertAwsCallerAccount(aws);
  step("AWS caller account: ok");
  const failures: string[] = [];
  const check = async (label: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
      step(`${label}: ok`);
    } catch (error) {
      failures.push(`${label}: ${(error as Error).message}`);
      warn(`${label}: failed`);
    }
  };
  await doctorInfrastructure(config, configDir, check);
  await doctorIdentity(config, configDir, check);
  await doctorDatabase(config, check);
  await doctorServices(config, check);
  const runtimeSecrets = await doctorSecrets(config, check, failures);
  if (failures.length) throw new CliError(`doctor failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  const runtimeNames = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"] as const;
  const priorRuntime = new Map(runtimeNames.map((name) => [name, process.env[name]]));
  for (const name of runtimeNames) {
    const stored = runtimeSecrets.get(name);
    if (stored !== undefined) process.env[name] = stored;
    else delete process.env[name];
  }
  try {
    await doctorCommon(config, runtimeSecrets, { configDir, requiredSecretValues: true });
  } finally {
    for (const name of runtimeNames) {
      const prior = priorRuntime.get(name);
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
  ok("all AWS deployment prerequisites are ready");
}

type LiveCheckOpts = { report?: boolean; configDir?: string; envFile?: string; sandboxDir?: string };

function desiredLiveImages(
  config: QmConfig,
  services: string[],
  plugins: ReadonlyMap<string, ResolvedPlugin>,
  manifest: DeploymentManifest,
  failures: string[],
): Record<string, string> {
  const desiredImages: Record<string, string> = {};
  for (const service of services) desiredLiveImage(service);
  return desiredImages;

  function desiredLiveImage(service: string): void {
    const provenance = manifest.imageProvenance?.[service];
    if (!provenance) return;
    const plugin = plugins.get(service);
    if (provenance.kind === "source-build") {
      if (plugin?.kind === "image" || (isServiceName(service) && config.imageOverrides[service])) {
        failures.push(
          `${service}: image build provenance drift (deployed from source, current workload uses a configured image)`,
        );
      }
      return;
    }
    if (plugin?.kind === "source") {
      failures.push(
        `${service}: image build provenance drift (deployed from a configured image, current workload builds from source)`,
      );
      return;
    }
    const source = workloadSourceImage(config, service, plugin);
    if (!source) {
      failures.push(`${service}: configured image source is missing for prebuilt deployment`);
      return;
    }
    try {
      desiredImages[service] = plannedWorkloadImage(config, service, plugin);
    } catch (error) {
      failures.push(`${service}: could not resolve desired image: ${errMessage(error)}`);
    }
  }
}

async function recordServiceDrift(
  config: QmConfig,
  service: string,
  state: EcsServiceState,
  manifest: DeploymentManifest,
  arns: Record<string, string>,
  desiredImages: Record<string, string>,
  failures: string[],
): Promise<void> {
  const aws = requireAws(config);
  const expectedTask = manifest.tasks[service];
  if (!expectedTask) {
    failures.push(`${service}: missing from current deployment manifest ${manifest.id}`);
    return;
  }
  const primary = (state.deployments ?? []).filter((deployment) => deployment.status === "PRIMARY");
  const wantCount = workloadDesiredCount(config, service);
  if (state.status !== "ACTIVE" || state.desiredCount !== wantCount || state.runningCount !== wantCount) {
    failures.push(
      `${service}: runtime is ${state.status ?? "missing"} with ${state.runningCount ?? 0}/${state.desiredCount ?? 0} running, expected ${wantCount}`,
    );
  }
  if (
    primary.length !== 1 ||
    primary[0]?.taskDefinition !== state.taskDefinition ||
    primary[0]?.rolloutState !== "COMPLETED"
  ) {
    failures.push(`${service}: configured task is not the sole healthy PRIMARY deployment`);
  }
  if (state.taskDefinition !== expectedTask)
    failures.push(`${service}: service task does not match deployment manifest ${manifest.id}`);
  const live = ((await describeTaskDefinition(aws, expectedTask)) as Record<string, unknown> | undefined) ?? null;
  if (!live) {
    failures.push(`${service}: no live task definition`);
    return;
  }
  const container = (live.containerDefinitions as Array<Record<string, unknown>> | undefined)?.find(
    (item) => item.name === service,
  );
  const liveEnv = Object.fromEntries(
    ((container?.environment as Array<{ name: string; value: string }> | undefined) ?? []).map((item) => [
      item.name,
      item.value,
    ]),
  );
  const expectedEnv = workloadEnvironment(config, service, manifest.backgroundDeploymentId);
  if (canonicalJson(liveEnv) !== canonicalJson(expectedEnv))
    failures.push(`${service}: environment drift (including live-only keys)`);
  const expectedSecrets = workloadSecrets(config, service, arns)
    .flatMap((secret) => containerSecretNames(service, secret))
    .sort();
  const liveSecretEntries = (container?.secrets as Array<{ name: string; valueFrom?: string }> | undefined) ?? [];
  const liveSecrets = liveSecretEntries.map((secret) => secret.name).sort();
  if (JSON.stringify(liveSecrets) !== JSON.stringify(expectedSecrets)) failures.push(`${service}: secret-name drift`);
  const repository = expectedWorkloadImageRepository(config, service);
  if (typeof container?.image !== "string" || !isPinnedWorkloadImage(config, service, container.image)) {
    failures.push(`${service}: live image is not a digest from ${repository}`);
  } else {
    const desiredImage = desiredImages[service];
    if (desiredImage && container.image !== desiredImage) {
      failures.push(`${service}: image drift (live ${container.image}, desired ${desiredImage})`);
    }
    const comparisonImage = desiredImage ?? `${repository}@sha256:${"0".repeat(64)}`;
    const fields = taskDefinitionDiff(
      renderTaskDefinition(config, service, comparisonImage, arns, manifest.backgroundDeploymentId),
      live,
    ).filter((field) => desiredImage || field !== `taskDefinition.containerDefinitions.${service}.image`);
    if (fields.length) failures.push(`${service}: task-definition drift (${fields.join(", ")})`);
  }
}

async function recordLayerDrift(
  config: QmConfig,
  configDir: string,
  opts: LiveCheckOpts,
  manifest: DeploymentManifest,
  failures: string[],
): Promise<void> {
  if (!manifest.layer) {
    failures.push(`deployment manifest ${manifest.id} has no deployment-layer artifact`);
  } else {
    try {
      await getDeploymentLayerArtifact(config, manifest.layer);
      if (opts.sandboxDir && existsSync(opts.sandboxDir)) {
        const directoryHash = createHash("sha256").update(deploymentLayerBody(opts.sandboxDir)).digest("hex");
        if (directoryHash !== manifest.layer.sha256)
          failures.push("deployment layer does not match the deployment directory");
      }
      await retryLiveProbe(async () => {
        const state = await currentDeploymentLayerState({
          config,
          transport: awsDeploymentLayerTransport,
          configDir,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        });
        if (state.contentHash !== manifest.layer!.sha256)
          throw new Error("deployment layer content does not match the current manifest");
        if (state.status !== "applied" || state.runtimeContentHash !== manifest.layer!.sha256)
          throw new Error("deployment layer is not applied by the live core");
      });
    } catch (error) {
      failures.push(`deployment layer drift: ${errMessage(error)}`);
    }
  }
}

async function recordLiveSessionSmoke(
  config: QmConfig,
  configDir: string,
  opts: LiveCheckOpts,
  core: EcsServiceState,
  failures: string[],
): Promise<void> {
  const aws = requireAws(config);
  try {
    const cohort = aws.backgroundWorkControl ? await awsBackgroundWorkStatus(config, configDir) : undefined;
    if (cohort && cohort.status.ownerDeploymentId === cohort.deploymentId) {
      const transport = awsBackgroundWorkTransport(config, "/v1/deployment/live-session", 600_000, 65_536);
      await checkControlledLiveSession({
        before: cohort,
        read: () => awsBackgroundWorkStatus(config, configDir),
        request: (body) => transport("POST", body),
      });
    } else {
      await awsLiveSession(config, core);
    }
    if (opts.report ?? true) step("core: private live session smoke passed");
  } catch (error) {
    failures.push(`core: private live session smoke failed: ${errMessage(error)}`);
  }
}

async function checkLive(config: QmConfig, opts: LiveCheckOpts = {}): Promise<void> {
  const configDir = opts.configDir ?? process.cwd();
  const { aws, workloads: services, plugins: resolvedPlugins } = awsTopology(config, configDir);
  const plugins = new Map(resolvedPlugins.map((plugin) => [plugin.name, plugin]));
  await assertAwsCallerAccount(aws);
  const failures: string[] = [];
  try {
    await assertAwsDeployImage(config);
  } catch (error) {
    failures.push(`deploy image drift: ${errMessage(error)}`);
  }
  const arns = await secretArns(config);
  const states = await describedServices(config, services);
  const manifest = await currentDeploymentManifest(aws);
  if (!manifest)
    throw new CliError("live drift detected: no current AWS deployment manifest", { clause: "aws.live-drift" });
  const desiredImages = desiredLiveImages(config, services, plugins, manifest, failures);
  if (manifest.imageLabel !== aws.imageLabel)
    failures.push(
      `deployment manifest label ${manifest.imageLabel ?? "missing"} does not match configured release ${aws.imageLabel ?? "missing"}`,
    );
  for (const service of services)
    await recordServiceDrift(config, service, states.get(service)!, manifest, arns, desiredImages, failures);
  try {
    const targets = await assertAwsPublicRouting(config);
    await assertAwsHealthyIngress(config, targets);
  } catch (error) {
    failures.push(`public front-door drift: ${errMessage(error)}`);
  }
  try {
    await retryLiveProbe(() => assertAwsPublicNetwork(config, true));
  } catch (error) {
    failures.push(`public network drift: ${errMessage(error)}`);
  }
  await recordLayerDrift(config, configDir, opts, manifest, failures);
  if (!failures.length) await recordLiveSessionSmoke(config, configDir, opts, states.get("core")!, failures);
  if (failures.length)
    throw new CliError(`live drift detected:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`, {
      clause: "aws.live-drift",
    });
  if (opts.report ?? true) ok("live AWS deployment matches the directory in both directions");
}

export async function awsCheckLive(
  config: QmConfig,
  opts: { report?: boolean; configDir?: string; envFile?: string; sandboxDir?: string } = {},
): Promise<void> {
  try {
    await checkLive(config, opts);
  } catch (error) {
    if (error instanceof CliError && error.clause === "aws.live-drift") throw error;
    throw new CliError(errMessage(error), { clause: "aws.live-drift", cause: error });
  }
}
