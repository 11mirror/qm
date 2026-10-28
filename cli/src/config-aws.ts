import { isAbsolute } from "node:path";
import { CliError } from "./log.ts";
import { isDeclaredService, isServiceName, isVirtualService, pluginNameError, type ServiceName } from "./services.ts";
import { DNS_LABEL, IAM_ROLE_ARN, isPlainObject, validateStringArray, validateStringMap } from "./config-validators.ts";
import type { AwsConfig, AwsServiceConfig } from "./config.ts";

export const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type AwsAccount = Pick<AwsConfig, "accountId" | "cluster">;

export const awsManagedTaskRoleArn = (aws: AwsAccount, name: string): string =>
  `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-${name}-task`;

export function awsTaskRoleArn(aws: AwsAccount, name: string, service: AwsServiceConfig): string {
  if (service.taskRoleArn) return service.taskRoleArn;
  if (name === "core" || service.assumeRoleArns?.length) return awsManagedTaskRoleArn(aws, name);
  return `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-task`;
}

type RequiredString = (value: unknown, field: string) => string;

type AwsCoordinates = Record<"ecrRepository" | "ecsService" | "targetGroup", Map<string, string>>;

function awsRequiredString(path: string): RequiredString {
  const requiredString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim())
      throw new CliError(`${path}: "aws.${field}" must be a non-empty string`);
    return value;
  };
  return requiredString;
}

function awsRoleArn(path: string, accountId: string, requiredString: RequiredString): RequiredString {
  const roleArn = (value: unknown, field: string): string => {
    const arn = requiredString(value, field);
    const match = IAM_ROLE_ARN.exec(arn);
    if (!match || match[1] !== accountId) {
      throw new CliError(
        `${path}: "aws.${field}" must be an IAM role ARN in account ${accountId} and the commercial AWS partition`,
      );
    }
    return arn;
  };
  return roleArn;
}

function validateAwsAccount(
  raw: Record<string, unknown>,
  path: string,
  requiredString: RequiredString,
  configuredSecretNames: string[],
) {
  const accountId = requiredString(raw["accountId"], "accountId");
  if (!/^\d{12}$/.test(accountId)) throw new CliError(`${path}: "aws.accountId" must be exactly 12 digits`);
  const cluster = requiredString(raw["cluster"], "cluster");
  if (cluster.length > 49 || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(cluster)) {
    throw new CliError(
      `${path}: "aws.cluster" must be at most 49 lowercase letters, digits, and single hyphens, start with a letter, and end with a letter or digit so its derived IAM and RDS names are valid`,
    );
  }
  const region = requiredString(raw["region"], "region");
  if (/^(?:cn-|us-gov-|us-iso|eu-isoe-)/.test(region)) {
    throw new CliError(
      `${path}: "aws.region" must be in the commercial AWS partition; GovCloud, China, and isolated partitions are not supported`,
    );
  }
  const secretsPrefix = requiredString(raw["secretsPrefix"], "secretsPrefix");
  if (secretsPrefix.length > 256 || !/^[A-Za-z0-9/_+=.@-]+$/.test(secretsPrefix)) {
    throw new CliError(
      `${path}: "aws.secretsPrefix" must be at most 256 AWS secret-name characters (letters, digits, /_+=.@-) so computed secret names fit`,
    );
  }
  const oversizedSecret = configuredSecretNames.find((name) => `${secretsPrefix}${name}`.length > 512);
  if (oversizedSecret) {
    throw new CliError(
      `${path}: "aws.secretsPrefix" plus computed secret ${JSON.stringify(oversizedSecret)} exceeds the 512-character AWS secret-name limit`,
    );
  }
  const imageLabel = requiredString(raw["imageLabel"], "imageLabel");
  if (!IMAGE_TAG.test(imageLabel)) {
    throw new CliError(
      `${path}: "aws.imageLabel" must be a valid OCI/ECR tag (1-128 letters, digits, underscores, periods, or hyphens; the first character cannot be a period or hyphen)`,
    );
  }
  return { accountId, cluster, region, secretsPrefix, imageLabel };
}

function validateAwsOptionalFields(raw: Record<string, unknown>, path: string, requiredString: RequiredString) {
  let deploymentState: AwsConfig["deploymentState"];
  if (raw["deploymentState"] !== undefined) {
    const state = raw["deploymentState"];
    if (
      !isPlainObject(state) ||
      typeof state.table !== "string" ||
      !/^[A-Za-z0-9_.-]{3,255}$/.test(state.table) ||
      typeof state.namespace !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(state.namespace)
    ) {
      throw new CliError(
        `${path}: "aws.deploymentState" requires a valid DynamoDB table name and a lowercase company namespace`,
      );
    }
    deploymentState = { table: state.table, namespace: state.namespace };
  }
  let alb: string | undefined;
  if (raw["alb"] !== undefined) {
    alb = requiredString(raw["alb"], "alb");
    if (alb.length > 32 || !DNS_LABEL.test(alb) || alb.startsWith("internal-")) {
      throw new CliError(
        `${path}: "aws.alb" must be a valid load balancer name (at most 32 letters, digits, and interior hyphens, not starting with "internal-")`,
      );
    }
  }
  if (raw["backgroundWorkControl"] !== undefined && typeof raw["backgroundWorkControl"] !== "boolean") {
    throw new CliError(`${path}: "aws.backgroundWorkControl" must be a boolean`);
  }
  if (raw["sharedAlb"] !== undefined && typeof raw["sharedAlb"] !== "boolean") {
    throw new CliError(`${path}: "aws.sharedAlb" must be a boolean`);
  }
  if (raw["sharedAlb"] === true && !alb) {
    throw new CliError(`${path}: "aws.sharedAlb" requires "aws.alb"`);
  }
  let rdsInstance: string | undefined;
  if (raw["rdsInstance"] !== undefined) {
    rdsInstance = requiredString(raw["rdsInstance"], "rdsInstance");
    if (rdsInstance.length > 63 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(rdsInstance) || rdsInstance.includes("--")) {
      throw new CliError(
        `${path}: "aws.rdsInstance" must be a valid DB instance identifier (at most 63 lowercase characters, starting with a letter, no double or trailing hyphens)`,
      );
    }
  }
  let predeployDbSnapshot: boolean | undefined;
  let dbInstanceClass: string | undefined;
  if (raw["dbInstanceClass"] !== undefined) {
    dbInstanceClass = requiredString(raw["dbInstanceClass"], "dbInstanceClass");
    if (!/^db\.[a-z0-9]+\.[a-z0-9]+$/.test(dbInstanceClass)) {
      throw new CliError(`${path}: "aws.dbInstanceClass" must be a valid RDS DB instance class such as db.t4g.small`);
    }
  }
  if (raw["predeployDbSnapshot"] !== undefined) {
    if (typeof raw["predeployDbSnapshot"] !== "boolean") {
      throw new CliError(
        `${path}: "aws.predeployDbSnapshot" must be a boolean (false skips the pre-deploy RDS restore-point check)`,
      );
    }
    predeployDbSnapshot = raw["predeployDbSnapshot"];
  }
  let dbRetentionMinDays: number | undefined;
  if (raw["dbRetentionMinDays"] !== undefined) {
    const days = raw["dbRetentionMinDays"];
    if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 35) {
      throw new CliError(
        `${path}: "aws.dbRetentionMinDays" must be an integer between 0 and 35 (the RDS automated-backup retention range)`,
      );
    }
    dbRetentionMinDays = days;
  }
  let objectStoreBucket: string | undefined;
  if (raw["objectStoreBucket"] !== undefined) {
    objectStoreBucket = requiredString(raw["objectStoreBucket"], "objectStoreBucket");
    if (
      objectStoreBucket.length < 3 ||
      objectStoreBucket.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(objectStoreBucket) ||
      objectStoreBucket.includes("..") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(objectStoreBucket)
    ) {
      throw new CliError(
        `${path}: "aws.objectStoreBucket" must be a valid S3 bucket name (3-63 lowercase letters, digits, and interior hyphens or dots; not IP-address-formatted)`,
      );
    }
  }
  let deployBranch: string | undefined;
  if (raw["deployBranch"] !== undefined) {
    deployBranch = requiredString(raw["deployBranch"], "deployBranch");
    const segments = deployBranch.split("/");
    if (
      deployBranch.length > 255 ||
      deployBranch.startsWith("refs/") ||
      deployBranch.includes("..") ||
      !/^[A-Za-z0-9._/-]+$/.test(deployBranch) ||
      segments.some(
        (segment) => !segment || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
      )
    ) {
      throw new CliError(`${path}: "aws.deployBranch" must be a valid git branch name (not a refs/* path)`);
    }
  }
  let deployEnvironment: string | undefined;
  if (raw["deployEnvironment"] !== undefined) {
    deployEnvironment = requiredString(raw["deployEnvironment"], "deployEnvironment");
    if (deployEnvironment.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(deployEnvironment)) {
      throw new CliError(`${path}: "aws.deployEnvironment" must be a valid GitHub environment name`);
    }
  }
  return {
    deploymentState,
    alb,
    rdsInstance,
    predeployDbSnapshot,
    dbInstanceClass,
    dbRetentionMinDays,
    objectStoreBucket,
    deployBranch,
    deployEnvironment,
  };
}

const validFargateSize = (cpu: number, memory: number): boolean => {
  const range = (min: number, max: number, step: number): boolean =>
    memory >= min && memory <= max && (memory - min) % step === 0;
  if (cpu === 256) return [512, 1024, 2048].includes(memory);
  if (cpu === 512) return range(1024, 4096, 1024);
  if (cpu === 1024) return range(2048, 8192, 1024);
  if (cpu === 2048) return range(4096, 16384, 1024);
  if (cpu === 4096) return range(8192, 30720, 1024);
  if (cpu === 8192) return range(16384, 61440, 4096);
  if (cpu === 16384) return range(32768, 122880, 8192);
  return false;
};

function validateAwsServiceAccess(
  service: AwsServiceConfig,
  name: string,
  value: Record<string, unknown>,
  path: string,
  cluster: string,
): void {
  if (value["publicPaths"] !== undefined) {
    const paths = validateStringArray(value["publicPaths"], path, `aws.services.${name}.publicPaths`);
    if (
      isDeclaredService(name) ||
      ["v1", "d", "key", "models", "slack", "api", "assets", "oauth", "healthz", "readyz", "metrics"].includes(name) ||
      paths.length === 0 ||
      paths.length > 5 ||
      new Set(paths).size !== paths.length
    ) {
      throw new CliError(`${path}: aws.services.${name}.publicPaths requires 1–5 unique plugin path prefixes`);
    }
    for (const prefix of paths) {
      if (
        prefix.length > 128 ||
        !prefix.startsWith(`/${name}/`) ||
        !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/\*$/.test(prefix)
      ) {
        throw new CliError(`${path}: aws.services.${name}.publicPaths must use /${name}/ paths ending in /*`);
      }
    }
    service.publicPaths = paths;
  }
  if (value["assumeRoleArns"] !== undefined) {
    const arns = validateStringArray(value["assumeRoleArns"], path, `aws.services.${name}.assumeRoleArns`);
    if (arns.length === 0) {
      throw new CliError(`${path}: "aws.services.${name}.assumeRoleArns" must contain at least one IAM role ARN`);
    }
    for (const arn of arns) {
      if (!IAM_ROLE_ARN.test(arn)) {
        throw new CliError(`${path}: "aws.services.${name}.assumeRoleArns" must contain commercial AWS IAM role ARNs`);
      }
    }
    service.assumeRoleArns = [...new Set(arns)];
    if (!service.taskRoleArn && `${cluster}-${name}-task`.length > 64) {
      throw new CliError(
        `${path}: "aws.services.${name}.assumeRoleArns" requires an explicit taskRoleArn because the derived IAM role name exceeds 64 characters`,
      );
    }
  }
}

function validateAwsServiceRuntime(
  service: AwsServiceConfig,
  name: string,
  value: Record<string, unknown>,
  path: string,
  requiredString: RequiredString,
  coordinates: AwsCoordinates,
): void {
  if (value["architecture"] !== undefined) {
    if (value["architecture"] !== "arm64" && value["architecture"] !== "amd64") {
      throw new CliError(`${path}: "aws.services.${name}.architecture" must be "arm64" or "amd64"`);
    }
    service.architecture = value["architecture"];
  }
  if (value["desiredCount"] !== undefined) {
    const desiredCount = value["desiredCount"];
    if (typeof desiredCount !== "number" || !Number.isInteger(desiredCount) || desiredCount <= 0) {
      throw new CliError(`${path}: "aws.services.${name}.desiredCount" must be a positive integer`);
    }
    service.desiredCount = desiredCount;
  }
  if (value["targetGroup"] !== undefined) {
    const targetGroup = requiredString(value["targetGroup"], `services.${name}.targetGroup`);
    if (targetGroup.length > 32 || !DNS_LABEL.test(targetGroup)) {
      throw new CliError(
        `${path}: "aws.services.${name}.targetGroup" must be a valid target group name (at most 32 letters, digits, and interior hyphens)`,
      );
    }
    const previous = coordinates.targetGroup.get(targetGroup);
    if (previous) {
      throw new CliError(
        `${path}: "aws.services.${name}.targetGroup" duplicates aws.services.${previous}.targetGroup (${JSON.stringify(targetGroup)})`,
      );
    }
    coordinates.targetGroup.set(targetGroup, name);
    service.targetGroup = targetGroup;
  }
  if (value["logGroup"] !== undefined) {
    const logGroup = requiredString(value["logGroup"], `services.${name}.logGroup`);
    if (logGroup.length > 512 || !/^[A-Za-z0-9_/.#-]+$/.test(logGroup)) {
      throw new CliError(
        `${path}: "aws.services.${name}.logGroup" must be a valid CloudWatch log group name (at most 512 characters: letters, digits, _ / . # -)`,
      );
    }
    service.logGroup = logGroup;
  }
  if (value["stopTimeout"] !== undefined) {
    const stopTimeout = value["stopTimeout"];
    if (typeof stopTimeout !== "number" || !Number.isInteger(stopTimeout) || stopTimeout < 2 || stopTimeout > 120) {
      throw new CliError(
        `${path}: "aws.services.${name}.stopTimeout" must be an integer between 2 and 120 seconds (the Fargate limit)`,
      );
    }
    service.stopTimeout = stopTimeout;
  }
  if (value["buildArgs"] !== undefined)
    service.buildArgs = validateStringMap(value["buildArgs"], path, `aws.services.${name}.buildArgs`);
  if (value["dockerfile"] !== undefined) {
    const dockerfile = requiredString(value["dockerfile"], `services.${name}.dockerfile`);
    if (isAbsolute(dockerfile) || dockerfile.includes("\\") || dockerfile.split("/").includes("..")) {
      throw new CliError(
        `${path}: "aws.services.${name}.dockerfile" must be a forward-slash relative path inside the build checkout`,
      );
    }
    service.dockerfile = dockerfile;
  }
}

function validateAwsServices(
  servicesRaw: Record<string, unknown>,
  path: string,
  requiredString: RequiredString,
  roleArn: RequiredString,
  cluster: string,
): Record<string, AwsServiceConfig> {
  const services: Record<string, AwsServiceConfig> = {};
  const coordinates = {
    ecrRepository: new Map<string, string>(),
    ecsService: new Map<string, string>(),
    targetGroup: new Map<string, string>(),
  };
  for (const [name, value] of Object.entries(servicesRaw)) {
    if (isVirtualService(name)) {
      const move =
        name === "portal" && isPlainObject(value) && value["targetGroup"] !== undefined
          ? " and move its targetGroup to aws.services.core.targetGroup"
          : "";
      throw new CliError(
        `${path}: "aws.services.${name}" is no longer a workload — core runs ${name}. Delete the entry${move}; the next terraform apply retires its ECS service and ECR repository`,
      );
    }
    if (!isServiceName(name) && pluginNameError(name)) {
      throw new CliError(`${path}: "aws.services" has invalid workload name "${name}"`);
    }
    if (!isPlainObject(value)) throw new CliError(`${path}: "aws.services.${name}" must be an object`);
    const positiveInt = (field: "cpu" | "memory"): number => {
      const n = value[field];
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new CliError(`${path}: "aws.services.${name}.${field}" must be a positive integer`);
      }
      return n;
    };
    const service: AwsServiceConfig = {
      ecrRepository: requiredString(value["ecrRepository"], `services.${name}.ecrRepository`),
      ecsService: requiredString(value["ecsService"], `services.${name}.ecsService`),
      cpu: positiveInt("cpu"),
      memory: positiveInt("memory"),
    };
    if (!validFargateSize(service.cpu, service.memory)) {
      throw new CliError(
        `${path}: "aws.services.${name}" cpu ${service.cpu} and memory ${service.memory} are not a supported Fargate task size`,
      );
    }
    for (const field of ["ecrRepository", "ecsService"] as const) {
      const previous = coordinates[field].get(service[field]);
      if (previous) {
        throw new CliError(
          `${path}: "aws.services.${name}.${field}" duplicates aws.services.${previous}.${field} (${JSON.stringify(service[field])})`,
        );
      }
      coordinates[field].set(service[field], name);
    }
    for (const role of ["taskRoleArn", "executionRoleArn"] as const) {
      if (value[role] !== undefined) service[role] = roleArn(value[role], `services.${name}.${role}`);
    }
    validateAwsServiceAccess(service, name, value, path, cluster);
    validateAwsServiceRuntime(service, name, value, path, requiredString, coordinates);
    services[name] = service;
  }
  return services;
}

export function validateAws(
  raw: unknown,
  path: string,
  enabledServices: ServiceName[],
  configuredSecretNames: string[],
): AwsConfig {
  if (!isPlainObject(raw)) throw new CliError(`${path}: "aws" must be an object`);
  const requiredString = awsRequiredString(path);
  const networking = raw["networking"];
  if (!isPlainObject(networking)) throw new CliError(`${path}: "aws.networking" must be an object`);
  const { accountId, cluster, region, secretsPrefix, imageLabel } = validateAwsAccount(
    raw,
    path,
    requiredString,
    configuredSecretNames,
  );
  const {
    deploymentState,
    alb,
    rdsInstance,
    predeployDbSnapshot,
    dbInstanceClass,
    dbRetentionMinDays,
    objectStoreBucket,
    deployBranch,
    deployEnvironment,
  } = validateAwsOptionalFields(raw, path, requiredString);
  const cloudMapNamespace = requiredString(networking["cloudMapNamespace"], "networking.cloudMapNamespace");
  const namespaceLabels = cloudMapNamespace.split(".");
  if (
    cloudMapNamespace.length > 253 ||
    namespaceLabels.some((label) => label.length === 0 || label.length > 63 || !DNS_LABEL.test(label))
  ) {
    throw new CliError(
      `${path}: "aws.networking.cloudMapNamespace" must be a valid DNS namespace of at most 253 characters with labels of at most 63 characters`,
    );
  }
  const roleArn = awsRoleArn(path, accountId, requiredString);
  const deployRoleArn = roleArn(raw["deployRoleArn"], "deployRoleArn");
  const servicesRaw = raw["services"];
  if (!isPlainObject(servicesRaw))
    throw new CliError(`${path}: "aws.services" must be an object keyed by service name`);
  const services = validateAwsServices(servicesRaw, path, requiredString, roleArn, cluster);
  const effectiveTaskRoleArn = (name: string, service: AwsServiceConfig): string =>
    awsTaskRoleArn({ accountId, cluster }, name, service);
  const taskRoleOwners = new Map<string, string[]>();
  for (const [name, service] of Object.entries(services)) {
    const role = effectiveTaskRoleArn(name, service);
    taskRoleOwners.set(role, [...(taskRoleOwners.get(role) ?? []), name]);
  }
  for (const [name, service] of Object.entries(services)) {
    if (!service.assumeRoleArns) continue;
    const role = effectiveTaskRoleArn(name, service);
    const owners = taskRoleOwners.get(role)!;
    if (owners.length > 1) {
      throw new CliError(
        `${path}: "aws.services.${name}.taskRoleArn" must be unique because assumeRoleArns grants workload-scoped permissions; ${role} is also used by ${owners.filter((owner) => owner !== name).join(", ")}`,
      );
    }
  }
  for (const name of enabledServices) {
    if (!services[name]) throw new CliError(`${path}: "aws.services.${name}" is required because ${name} is enabled`);
  }
  const netOut: AwsConfig["networking"] = {
    cloudMapNamespace,
  };
  for (const key of ["subnets", "securityGroups"] as const) {
    if (networking[key] !== undefined) {
      throw new CliError(
        `${path}: "aws.networking.${key}" is not supported; network placement belongs to the provisioned ECS services`,
      );
    }
  }
  const out: AwsConfig = {
    accountId,
    region,
    cluster,
    deployRoleArn,
    secretsPrefix,
    imageLabel,
    networking: netOut,
    services,
  };
  if (deploymentState) out.deploymentState = deploymentState;
  if (alb) out.alb = alb;
  if (raw["sharedAlb"] !== undefined) out.sharedAlb = raw["sharedAlb"] as boolean;
  if (raw["backgroundWorkControl"] !== undefined) out.backgroundWorkControl = raw["backgroundWorkControl"] as boolean;
  if (out.backgroundWorkControl && (services.core?.ecsService.length ?? 0) > 219)
    throw new CliError(
      `${path}: controlled core service names must leave room for a unique deployment identity (maximum 219 characters)`,
    );
  if (rdsInstance) out.rdsInstance = rdsInstance;
  if (dbInstanceClass) out.dbInstanceClass = dbInstanceClass;
  if (predeployDbSnapshot !== undefined) out.predeployDbSnapshot = predeployDbSnapshot;
  if (dbRetentionMinDays !== undefined) out.dbRetentionMinDays = dbRetentionMinDays;
  if (deployBranch) out.deployBranch = deployBranch;
  if (deployEnvironment) out.deployEnvironment = deployEnvironment;
  if (objectStoreBucket) out.objectStoreBucket = objectStoreBucket;
  return out;
}
