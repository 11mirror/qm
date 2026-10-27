import {
  type RegisterTaskDefinitionCommandInput,
  RegisterTaskDefinitionCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
} from "@aws-sdk/client-ecs";
import { DescribeSecretCommand, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { readFileSync } from "node:fs";
import { awsErrorCode } from "../../aws-lease.ts";
import { canonicalJson } from "../../canonical-json.ts";
import {
  type QmConfig,
  securityScreenEnv,
  effectiveSandboxBackend,
  sandboxCoreEnv,
  awsWorkloadArchitecture,
  isDigestPinned,
  awsTaskRoleArn,
  type AwsConfig,
} from "../../config.ts";
import { CliError, step, note } from "../../log.ts";
import { type ComputedSecret, runtimeSecretNames, secretsForService, computedSecrets } from "../../secrets.ts";
import {
  type ServiceName,
  serviceDef,
  coreWebEnv,
  hostedServiceEnv,
  hostsWebEdge,
  isServiceName,
  PUBLIC_PORT,
} from "../../services.ts";
import { awsObjectStoreBucket } from "../../terraform.ts";
import { isInvalidSecret } from "../../util.ts";
import { type EcsTaskDefinition, awsSecretString, ecs, requireAws, secretsManager } from "./clients.ts";

export function containerSecretNames(service: string, secret: ComputedSecret): string[] {
  const names = runtimeSecretNames(service, secret);
  return names.length ? names : [secret.name];
}

export async function registerTaskDefinition(config: QmConfig, file: string): Promise<string> {
  const definition = JSON.parse(readFileSync(file, "utf8")) as RegisterTaskDefinitionCommandInput;
  const tags = [
    { key: "ManagedBy", value: "qm-cli" },
    { key: "Deployment", value: config.orgId },
  ];
  const { taskDefinition } = await ecs(config.aws!).send(new RegisterTaskDefinitionCommand({ ...definition, tags }));
  return taskDefinition?.taskDefinitionArn ?? "";
}

function secretValueFrom(config: QmConfig, name: string, arns?: Record<string, string>): string {
  if (arns?.[name]) return arns[name];
  const aws = requireAws(config);
  return `arn:aws:secretsmanager:${aws.region}:${aws.accountId}:secret:${aws.secretsPrefix}${name}`;
}

export function serviceEnvironment(config: QmConfig, service: ServiceName): Record<string, string> {
  const aws = requireAws(config);
  const def = serviceDef(service);
  const env: Record<string, string> = {
    ...(service === "core"
      ? {
          ...coreWebEnv(config),
          ...(config.model ? { PI_MODEL: config.model } : {}),
          ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
        }
      : {
          CORE_ORG_ID: config.orgId,
          CORE_API_URL: def.tcpIngress
            ? (config.apiUrl ?? config.publicUrl)
            : `http://core.${aws.networking.cloudMapNamespace}:8080`,
        }),
    ...hostedServiceEnv(config.services, config.env, service),
    ...(service === "core" ? securityScreenEnv(config) : {}),
  };
  if (service === "core") {
    const sandboxBackend = effectiveSandboxBackend(config);
    const stores = {
      DEPLOY_PROVIDER: config.env.core?.DEPLOY_PROVIDER?.trim() || "aws",
      AWS_DEPLOY_REGION: aws.region,
      RUN_STORE: "postgres",
      S3_BUCKET: config.env.core?.S3_BUCKET?.trim() || awsObjectStoreBucket(config),
      S3_REGION: aws.region,
    };
    Object.assign(env, sandboxCoreEnv(config).env, {
      ...(sandboxBackend ? { SANDBOX_BACKEND: sandboxBackend } : {}),
      ...stores,
    });
  }
  if (service === "core" && hostsWebEdge(config.services)) env.PORTAL_XFF_TRUSTED_HOPS = "1";
  env[def.docker.portEnv] = String(def.docker.internalPort);
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

export function workloadEnvironment(
  config: QmConfig,
  workload: string,
  backgroundDeploymentId?: string,
): Record<string, string> {
  if (isServiceName(workload)) {
    const env = serviceEnvironment(config, workload);
    if (workload === "core" && requireAws(config).backgroundWorkControl) {
      if (!backgroundDeploymentId)
        throw new CliError("controlled background work requires a manifest-bound deployment identity");
      env.BACKGROUND_DEPLOYMENT_ID = backgroundDeploymentId;
    }
    return env;
  }
  const plugin = config.plugins.find((entry) => entry.name === workload);
  return Object.fromEntries(
    Object.entries({
      ...(plugin?.coreAccess === false
        ? {}
        : { CORE_API_URL: `http://core.${requireAws(config).networking.cloudMapNamespace}:8080` }),
      CORE_ORG_ID: config.orgId,
      ...plugin?.env,
      PORT: "8080",
    }).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function workloadSecrets(config: QmConfig, workload: string, available?: Record<string, string>) {
  const secrets = secretsForService(config, workload).filter(
    (secret) => secret.required || Boolean(available?.[secret.name]),
  );
  const plugin = config.plugins.find((entry) => entry.name === workload);
  if (
    !isServiceName(workload) &&
    plugin?.coreAccess !== false &&
    !secrets.some((secret) => secret.name === "CORE_SIGNING_SECRET")
  ) {
    const signing = computedSecrets(config).find((secret) => secret.name === "CORE_SIGNING_SECRET");
    if (signing) return [...secrets, signing];
  }
  return secrets;
}

export function workloadArchitecture(config: QmConfig, workload: string): "arm64" | "amd64" {
  requireAws(config);
  return awsWorkloadArchitecture(config, workload);
}

export function renderTaskDefinition(
  config: QmConfig,
  service: string,
  image: string,
  secretArns?: Record<string, string>,
  backgroundDeploymentId?: string,
): EcsTaskDefinition {
  if (!isDigestPinned(image)) throw new CliError(`aws task image for ${service} must be pinned by digest`);
  const aws = requireAws(config);
  const spec = aws.services[service];
  if (!spec) throw new CliError(`aws.services.${service} is missing`);
  const def = isServiceName(service) ? serviceDef(service) : undefined;
  const internalPort = def?.docker.internalPort ?? 8080;
  const executionRoleArn = spec.executionRoleArn ?? `arn:aws:iam::${aws.accountId}:role/${aws.cluster}-task-execution`;
  const taskRoleArn = awsTaskRoleArn(aws, service, spec);
  const secrets = workloadSecrets(config, service, secretArns)
    .flatMap((secret) =>
      containerSecretNames(service, secret).map((name) => ({
        name,
        valueFrom: secretValueFrom(config, secret.name, secretArns),
      })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const healthCheck = def
    ? {
        command: def.tcpIngress?.healthCheck ?? [
          "CMD",
          "node",
          "-e",
          `fetch('http://127.0.0.1:${internalPort}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
        ],
        interval: 10,
        timeout: 5,
        retries: 3,
        startPeriod: 30,
      }
    : undefined;
  return {
    family: spec.ecsService,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: String(spec.cpu),
    memory: String(spec.memory),
    runtimePlatform: {
      cpuArchitecture: workloadArchitecture(config, service) === "arm64" ? "ARM64" : "X86_64",
      operatingSystemFamily: "LINUX",
    },
    executionRoleArn,
    taskRoleArn,
    containerDefinitions: [
      {
        name: service,
        image,
        essential: true,
        environment: Object.entries(workloadEnvironment(config, service, backgroundDeploymentId)).map(
          ([name, value]) => ({ name, value }),
        ),
        secrets,
        portMappings: [
          {
            name: service,
            containerPort: internalPort,
            hostPort: internalPort,
            protocol: "tcp",
            ...(def?.tcpIngress ? {} : { appProtocol: "http" }),
          },
          ...(service === "core" && hostsWebEdge(config.services)
            ? [
                {
                  name: "public",
                  containerPort: PUBLIC_PORT,
                  hostPort: PUBLIC_PORT,
                  protocol: "tcp",
                  appProtocol: "http",
                },
              ]
            : []),
        ],
        ...(healthCheck ? { healthCheck } : {}),
        ...(spec.stopTimeout !== undefined ? { stopTimeout: spec.stopTimeout } : {}),
        logConfiguration: {
          logDriver: "awslogs",
          options: {
            "awslogs-group": spec.logGroup ?? `/ecs/${spec.ecsService}`,
            "awslogs-region": aws.region,
            "awslogs-stream-prefix": service,
          },
        },
      },
    ],
  };
}

export async function secretArns(config: QmConfig): Promise<Record<string, string>> {
  const aws = requireAws(config);
  const controlValues = new Map<string, string>();
  const pairs: Array<readonly [string, string]> = [];
  for (const secret of computedSecrets(config)) pairs.push(...(await secretArn(aws, secret, controlValues)));
  if (
    aws.backgroundWorkControl &&
    controlValues.get("CORE_SIGNING_SECRET") === controlValues.get("DEPLOYMENT_CONTROL_SECRET")
  )
    throw new CliError("DEPLOYMENT_CONTROL_SECRET must differ from CORE_SIGNING_SECRET");
  return Object.fromEntries(pairs);
}

async function secretArn(
  aws: AwsConfig,
  secret: ComputedSecret,
  controlValues: Map<string, string>,
): Promise<Array<readonly [string, string]>> {
  {
    const id = `${aws.secretsPrefix}${secret.name}`;
    try {
      if (!secret.required) {
        const metadata = await secretsManager(aws).send(new DescribeSecretCommand({ SecretId: id }));
        const hasCurrent = Object.values(metadata.VersionIdsToStages ?? {}).some((stages) =>
          stages.includes("AWSCURRENT"),
        );
        return metadata.ARN && !metadata.DeletedDate && hasCurrent ? [[secret.name, metadata.ARN] as const] : [];
      }
      const value = await secretsManager(aws).send(new GetSecretValueCommand({ SecretId: id }));
      if (!value.ARN || isInvalidSecret(secret.name, value.SecretString)) {
        throw new CliError(`required AWS secret ${secret.name} has no usable, non-placeholder AWSCURRENT value`);
      }
      if (secret.name === "CORE_SIGNING_SECRET" || secret.name === "DEPLOYMENT_CONTROL_SECRET")
        controlValues.set(secret.name, value.SecretString!);
      return [[secret.name, value.ARN] as const];
    } catch (error) {
      if (!secret.required && awsErrorCode(error) === "ResourceNotFoundException") return [];
      throw error;
    }
  }
}

export async function assertAwsPublicApiUrl(config: QmConfig): Promise<void> {
  if (!computedSecrets(config).some((secret) => secret.name === "PUBLIC_API_URL")) return;
  const value = await awsSecretString(requireAws(config), "PUBLIC_API_URL");
  const bound = config.apiUrl ? ("apiUrl" as const) : ("publicUrl" as const);
  const expected = new URL(config.apiUrl ?? config.publicUrl).toString().replace(/\/$/, "");
  let normalized: string;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") throw new Error("not HTTPS");
    normalized = parsed.toString().replace(/\/$/, "");
  } catch {
    throw new CliError(`required AWS secret PUBLIC_API_URL must be a valid HTTPS URL equal to the configured ${bound}`);
  }
  if (normalized !== expected) {
    throw new CliError(`required AWS secret PUBLIC_API_URL must equal the configured HTTPS ${bound} (${expected})`);
  }
}

async function liveTask(config: QmConfig, service: string): Promise<Record<string, unknown> | null> {
  const aws = requireAws(config);
  const spec = aws.services[service]!;
  const described = await ecs(aws).send(
    new DescribeServicesCommand({ cluster: aws.cluster, services: [spec.ecsService] }),
  );
  const arn = described.services?.[0]?.taskDefinition;
  if (!arn) return null;
  const { taskDefinition } = await ecs(aws).send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
  return (taskDefinition as Record<string, unknown> | undefined) ?? null;
}

function normalizeLiveTask(task: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!task) return null;
  const copy = structuredClone(task);
  for (const key of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
  ])
    delete copy[key];
  for (const key of ["volumes", "placementConstraints"] as const) {
    if (Array.isArray(copy[key]) && copy[key].length === 0) delete copy[key];
  }
  if (copy.enableFaultInjection === false) delete copy.enableFaultInjection;
  const containers = copy.containerDefinitions;
  if (Array.isArray(containers)) {
    for (const value of containers) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const container = value as Record<string, unknown>;
      if (container.cpu === 0) delete container.cpu;
      for (const key of ["mountPoints", "volumesFrom", "systemControls", "resourceRequirements", "ulimits"] as const) {
        if (Array.isArray(container[key]) && container[key].length === 0) delete container[key];
      }
      for (const key of ["environment", "secrets", "portMappings"] as const) {
        if (Array.isArray(container[key])) {
          container[key] = [...container[key]].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
        }
      }
    }
  }
  if (Array.isArray(copy.requiresCompatibilities)) copy.requiresCompatibilities.sort();
  return copy;
}

function taskReviewShape(task: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeLiveTask(task)!;
  const values = Array.isArray(normalized.containerDefinitions) ? normalized.containerDefinitions : [];
  normalized.containerDefinitions = Object.fromEntries(
    values.map((value) => {
      const container = value as Record<string, unknown>;
      const shaped = { ...container };
      for (const field of ["environment", "secrets"] as const) {
        const entries = Array.isArray(shaped[field]) ? (shaped[field] as Array<Record<string, unknown>>) : [];
        shaped[field] = Object.fromEntries(
          entries.map((entry) => [String(entry.name), field === "environment" ? entry.value : entry.valueFrom]),
        );
      }
      return [String(container.name), shaped];
    }),
  );
  return normalized;
}

export interface TaskDefinitionChange {
  path: string;
  live: unknown;
  desired: unknown;
}

function diffTaskValues(desired: unknown, live: unknown, path: string, out: TaskDefinitionChange[]): void {
  if (canonicalJson(desired) === canonicalJson(live)) return;
  if (
    desired &&
    live &&
    typeof desired === "object" &&
    typeof live === "object" &&
    !Array.isArray(desired) &&
    !Array.isArray(live)
  ) {
    const expected = desired as Record<string, unknown>;
    const actual = live as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      diffTaskValues(expected[key], actual[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push({
    path,
    live: live === undefined ? "<absent>" : live,
    desired: desired === undefined ? "<absent>" : desired,
  });
}

export function taskDefinitionChanges(
  desired: EcsTaskDefinition,
  live: Record<string, unknown> | null,
): TaskDefinitionChange[] {
  const out: TaskDefinitionChange[] = [];
  diffTaskValues(
    taskReviewShape(desired as unknown as Record<string, unknown>),
    live ? taskReviewShape(live) : null,
    "taskDefinition",
    out,
  );
  return out;
}

export function taskDefinitionDiff(desired: EcsTaskDefinition, live: Record<string, unknown> | null): string[] {
  return taskDefinitionChanges(desired, live).map((change) => change.path);
}

export async function reportTaskChanges(
  config: QmConfig,
  services: string[],
  images: Record<string, string>,
  arns: Record<string, string>,
  restart: ReadonlySet<string> = new Set(),
  backgroundDeploymentId?: string,
): Promise<Array<{ service: string; task: EcsTaskDefinition; changed: boolean }>> {
  const desired = [];
  for (const service of services)
    desired.push({
      service,
      task: renderTaskDefinition(config, service, images[service]!, arns, backgroundDeploymentId),
      live: await liveTask(config, service),
    });
  return desired.map((item) => {
    const changes = taskDefinitionChanges(item.task, item.live);
    step(
      `${item.service}: ${changes.length ? `${changes.length} task-definition change${changes.length === 1 ? "" : "s"}` : "no task-definition change"}`,
    );
    if (changes.length) note(JSON.stringify({ service: item.service, changes }, null, 2));
    if (restart.has(item.service)) step(`${item.service}: restart requested with the deployment`);
    return { service: item.service, task: item.task, changed: changes.length > 0 || restart.has(item.service) };
  });
}
