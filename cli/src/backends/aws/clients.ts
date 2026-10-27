import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ECRClient } from "@aws-sdk/client-ecr";
import {
  ECSClient,
  type Service,
  type TaskDefinition,
  DescribeTaskDefinitionCommand,
  paginateListTasks,
} from "@aws-sdk/client-ecs";
import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { IAMClient } from "@aws-sdk/client-iam";
import { type DBInstance, RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { awsClient } from "../../aws-sdk.ts";
import { type QmConfig, type AwsConfig } from "../../config.ts";
import { CliError } from "../../log.ts";
import { type ResolvedPlugin, discoverPlugins } from "../../plugins.ts";
import { runnableServices } from "../../services.ts";
import { assertTerraformScaffoldSupportsConfig } from "../../terraform.ts";
import { capture } from "../../util.ts";

export interface AwsUpOpts {
  dryRun?: boolean;
  yes?: boolean;
  buildFrom?: boolean;
  buildFromPath?: string;
  imageLabel?: string;
  only?: string[];
  restart?: string[];
  sandboxDir?: string;
  envFile?: string;
  buildOnly?: boolean;
  buildConcurrency?: number;
  candidate?: string;
  candidateOut?: string;
  inactive?: boolean;
}

export interface EcsTaskDefinition {
  family: string;
  networkMode: "awsvpc";
  requiresCompatibilities: ["FARGATE"];
  cpu: string;
  memory: string;
  runtimePlatform: { cpuArchitecture: "ARM64" | "X86_64"; operatingSystemFamily: "LINUX" };
  executionRoleArn: string;
  taskRoleArn: string;
  containerDefinitions: Array<Record<string, unknown>>;
}

export function requireAws(config: QmConfig): AwsConfig {
  if (!config.aws) throw new CliError('target "aws" requires an aws block');
  return config.aws;
}

export function rdsInstanceIdentifier(aws: AwsConfig): string {
  return aws.rdsInstance ?? `${aws.cluster}-core`;
}

export function awsTopology(
  config: QmConfig,
  configDir: string,
): { aws: AwsConfig; workloads: string[]; plugins: ResolvedPlugin[] } {
  const aws = requireAws(config);
  assertTerraformScaffoldSupportsConfig(config, configDir);
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length) throw new CliError(discovered.errors.join("\n"));
  const workloads = [...runnableServices(config.services), ...discovered.plugins.map((plugin) => plugin.name)];
  const enabled = new Set(workloads);
  const stale = Object.keys(aws.services)
    .filter((workload) => !enabled.has(workload))
    .sort();
  const missing = workloads.filter((workload) => !aws.services[workload]);
  if (stale.length || missing.length) {
    const problems = [
      ...(stale.length ? [`disabled workloads: ${stale.join(", ")}`] : []),
      ...(missing.length ? [`missing enabled workloads: ${missing.join(", ")}`] : []),
    ];
    throw new CliError(`aws.services topology mismatch (${problems.join("; ")})`);
  }
  return { aws, workloads, plugins: discovered.plugins };
}

export function awsArgs(aws: AwsConfig, args: string[]): string[] {
  return [...args, "--region", aws.region];
}

export function awsJson<T>(aws: AwsConfig, args: string[]): T {
  const raw = capture(process.env.AWS_BIN ?? "aws", awsArgs(aws, [...args, "--output", "json"]));
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

export const ecs = (aws: AwsConfig): ECSClient => awsClient(ECSClient, aws.region);

export const iam = (aws: AwsConfig): IAMClient => awsClient(IAMClient, aws.region);

export const elb = (aws: AwsConfig): ElasticLoadBalancingV2Client =>
  awsClient(ElasticLoadBalancingV2Client, aws.region);

export const ecr = (aws: AwsConfig): ECRClient => awsClient(ECRClient, aws.region);

export const secretsManager = (aws: AwsConfig): SecretsManagerClient => awsClient(SecretsManagerClient, aws.region);

export const s3 = (config: QmConfig): S3Client => awsClient(S3Client, requireAws(config).region);

export async function awsSecretString(aws: AwsConfig, name: string): Promise<string> {
  const id = `${aws.secretsPrefix}${name}`;
  const { SecretString } = await secretsManager(aws).send(new GetSecretValueCommand({ SecretId: id }));
  return (SecretString ?? "").trim();
}

export async function assertAwsCallerAccount(aws: AwsConfig): Promise<void> {
  const { Account: account } = await awsClient(STSClient, aws.region).send(new GetCallerIdentityCommand({}));
  if (account !== aws.accountId) {
    throw new CliError(`authenticated to AWS account ${account || "unknown"}, expected ${aws.accountId}`);
  }
}

export type EcsServiceState = Service;

export async function describeTaskDefinition(
  aws: AwsConfig,
  taskDefinition: string,
): Promise<TaskDefinition | undefined> {
  return (await ecs(aws).send(new DescribeTaskDefinitionCommand({ taskDefinition }))).taskDefinition;
}

export async function all<P, T>(pages: AsyncIterable<P>, items: (page: P) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  for await (const page of pages) out.push(...(items(page) ?? []));
  return out;
}

export function runningTaskArns(aws: AwsConfig, serviceName: string): Promise<string[]> {
  const input = { cluster: aws.cluster, serviceName, desiredStatus: "RUNNING" as const };
  return all(paginateListTasks({ client: ecs(aws) }, input), (page) => page.taskArns);
}

export const ECS_SERVICE_BATCH_SIZE = 10;

export function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export const dynamo = (aws: AwsConfig): DynamoDBClient => awsClient(DynamoDBClient, aws.region);

export function timestamp(value: Date | string | undefined): number {
  return value === undefined ? NaN : new Date(value).getTime();
}

export async function describeDbInstance(aws: AwsConfig, database: string): Promise<DBInstance | undefined> {
  const rds = awsClient(RDSClient, aws.region);
  return (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: database }))).DBInstances?.[0];
}
