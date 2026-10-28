import https from "node:https";
import { CloudFrontClient, paginateListDistributions } from "@aws-sdk/client-cloudfront";
import { DescribeServicesCommand, type Service, type ServiceConnectConfiguration } from "@aws-sdk/client-ecs";
import {
  DescribeLoadBalancersCommand,
  paginateDescribeListeners,
  paginateDescribeTargetGroups,
  paginateDescribeRules,
  DescribeTargetHealthCommand,
  type Listener,
  type Rule,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { ServiceDiscoveryClient, paginateListNamespaces, paginateListServices } from "@aws-sdk/client-servicediscovery";
import { createHash } from "node:crypto";
import { resolveCname, lookup } from "node:dns/promises";
import { validAlbHostname, awsCoreHostnames, awsPortalAppsDomain } from "../../aws-routing.ts";
import { awsClient } from "../../aws-sdk.ts";
import { type AwsConfig, type QmConfig } from "../../config.ts";
import { type DeploymentLayerTransport, httpDeploymentLayerTransport } from "../../deployment-layer.ts";
import { CliError, errMessage } from "../../log.ts";
import { isServiceName, serviceDef, hostsWebEdge, PUBLIC_PORT } from "../../services.ts";
import { ECS_SERVICE_BATCH_SIZE, all, awsSecretString, chunks, ecs, elb, requireAws } from "./clients.ts";

export async function fetchCore(
  url: URL,
  init: RequestInit,
  maxResponseBytes?: number,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, init);
  if (maxResponseBytes === undefined) return { status: response.status, body: await response.text() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) throw new CliError("AWS core response exceeded its size limit");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
}

export async function awsCoreRequest(
  config: QmConfig,
  url: URL,
  init: RequestInit,
  maxResponseBytes?: number,
): Promise<{ status: number; body: string }> {
  const target = (await awsPublicFrontDoor(config)).dnsName.toLowerCase().replace(/\.$/, "");
  if (!validAlbHostname(target)) throw new CliError("AWS deployment-layer ALB hostname is invalid");
  if (awsPublicOrigin(config).protocol === "http:") {
    await assertCloudFrontLayerTarget(config, url, target);
    return fetchCore(url, init, maxResponseBytes);
  }
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        hostname: target,
        servername: url.hostname,
        method: init.method,
        headers: { ...(init.headers as Record<string, string>), host: url.host },
        signal: init.signal ?? undefined,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (maxResponseBytes !== undefined && size > maxResponseBytes) {
            const error = new CliError("AWS core response exceeded its size limit");
            reject(error);
            response.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end(init.body as string | undefined);
  });
}

export const awsDeploymentLayerTransport: DeploymentLayerTransport = httpDeploymentLayerTransport({
  urlOf: (config) => {
    const url = new URL(config.apiUrl ?? config.publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new CliError("AWS deployment-layer URL must be HTTPS without credentials or a fragment");
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/deployment-layer`;
    return url;
  },
  request: awsCoreRequest,
  secretFallback: (config) => (config.aws ? awsSecretString(config.aws, "CORE_SIGNING_SECRET") : undefined),
  timeoutMs: 60_000,
});

export function assertAwsPublicListener(
  publicUrl: string,
  listener: { Protocol?: string; Port?: number; Certificates?: Array<{ CertificateArn?: string }> },
): void {
  const protocol = new URL(publicUrl).protocol;
  if (protocol === "https:") {
    if (listener.Protocol !== "HTTPS" || listener.Port !== 443) {
      throw new Error(
        `publicUrl is HTTPS but the ALB listener is ${listener.Protocol ?? "missing"}:${listener.Port ?? "missing"}; configure certificate_arn and apply Terraform`,
      );
    }
    if (!listener.Certificates?.some((certificate) => Boolean(certificate.CertificateArn))) {
      throw new Error(
        "publicUrl is HTTPS but the ALB listener has no certificate; configure certificate_arn and apply Terraform",
      );
    }
    return;
  }
  if (protocol === "http:") {
    if (listener.Protocol !== "HTTP" || listener.Port !== 80) {
      throw new Error(
        `publicUrl is HTTP but the ALB listener is ${listener.Protocol ?? "missing"}:${listener.Port ?? "missing"}`,
      );
    }
    return;
  }
  throw new Error(`publicUrl must use http or https (got ${protocol})`);
}

type AwsPublicListener = Listener;

interface AwsPublicFrontDoor {
  loadBalancerArn: string;
  dnsName: string;
  listener: AwsPublicListener;
}

function awsPublicOrigin(config: QmConfig): URL {
  const value = config.env.core?.AWS_PUBLIC_ORIGIN_URL?.trim() || config.publicUrl;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url;
  } catch {
    throw new Error("env.core.AWS_PUBLIC_ORIGIN_URL must be an HTTP(S) URL when set");
  }
}

function isHttpsRedirectListener(listener: AwsPublicListener): boolean {
  if (listener.Protocol !== "HTTP" || listener.Port !== 80) return false;
  const actions = listener.DefaultActions ?? [];
  return actions.length === 1 && actions[0]?.Type === "redirect" && actions[0].RedirectConfig?.Protocol === "HTTPS";
}

export type AwsEcsRoutingService = Service;

function awsServiceConnectConfiguration(service: AwsEcsRoutingService): ServiceConnectConfiguration | undefined {
  return service.deployments?.find((deployment) => deployment.status === "PRIMARY")?.serviceConnectConfiguration;
}

export async function assertAwsServiceDiscovery(
  config: QmConfig,
  ecsServices: ReadonlyMap<string, AwsEcsRoutingService>,
): Promise<void> {
  const aws = requireAws(config);
  const cloudMap = { client: awsClient(ServiceDiscoveryClient, aws.region) };
  const namespaces = await all(paginateListNamespaces(cloudMap, {}), (page) => page.Namespaces);
  let namespaceId: string | undefined;
  let registrations: Array<{ Arn?: string; Name?: string }> = [];
  for (const name of Object.keys(aws.services)) {
    const ecsService = ecsServices.get(name);
    const connect = ecsService ? awsServiceConnectConfiguration(ecsService) : undefined;
    if (!connect?.enabled) throw new Error(`ECS service ${name} does not have Service Connect enabled`);
    const namespace = namespaces.find((item) => item.Arn === connect.namespace || item.Name === connect.namespace);
    if (!connect.namespace || !namespace?.Id)
      throw new Error(`ECS service ${name} references a missing Cloud Map namespace`);
    if (namespaceId && namespaceId !== namespace.Id)
      throw new Error("ECS services must share their Service Connect namespace");
    if (!namespaceId) {
      namespaceId = namespace.Id;
      const Filters = [{ Name: "NAMESPACE_ID" as const, Values: [namespaceId], Condition: "EQ" as const }];
      registrations = await all(paginateListServices(cloudMap, { Filters }), (page) => page.Services);
    }
    const endpoints = connect.services?.filter((service) => service.portName === name) ?? [];
    if (endpoints.length !== 1)
      throw new Error(`ECS service ${name} does not publish its named ${name} port through Service Connect`);
    const endpoint = endpoints[0]!;
    const discoveryName = endpoint.discoveryName ?? endpoint.portName;
    if (!registrations.some((service) => service.Name === discoveryName && service.Arn)) {
      throw new Error(`service ${discoveryName} is missing from ${namespace.Name}`);
    }
    const expectedDns = `${name}.${aws.networking.cloudMapNamespace}`;
    const expectedPort = isServiceName(name) ? serviceDef(name).docker.internalPort : 8080;
    if (!endpoint.clientAliases?.some((alias) => alias.dnsName === expectedDns && alias.port === expectedPort)) {
      throw new Error(`ECS service ${name} does not publish the ${expectedDns}:${expectedPort} client alias`);
    }
  }
}

async function awsEcsRoutingServices(config: QmConfig): Promise<ReadonlyMap<string, AwsEcsRoutingService>> {
  const aws = requireAws(config);
  const entries = Object.keys(aws.services).map((name) => [name, aws.services[name]!] as const);
  const services: AwsEcsRoutingService[] = [];
  const failures: Array<{ arn?: string; reason?: string }> = [];
  for (const batch of chunks(
    entries.map(([, spec]) => spec.ecsService),
    ECS_SERVICE_BATCH_SIZE,
  )) {
    const described = await ecs(aws).send(new DescribeServicesCommand({ cluster: aws.cluster, services: batch }));
    services.push(...((described.services ?? []) as AwsEcsRoutingService[]));
    failures.push(...(described.failures ?? []));
  }
  if (failures.length) {
    throw new Error(
      `could not describe ECS routing attachments: ${failures.map((failure) => `${failure.arn ?? "unknown"} (${failure.reason ?? "unknown"})`).join(", ")}`,
    );
  }
  return new Map(
    entries.map(([name, spec]) => {
      const service = services.find((candidate) => candidate.serviceName === spec.ecsService);
      if (!service) throw new Error(`ECS service ${spec.ecsService} is missing`);
      return [name, service] as const;
    }),
  );
}

async function awsPublicFrontDoor(config: QmConfig): Promise<AwsPublicFrontDoor> {
  const aws = requireAws(config);
  const albName =
    aws.alb ?? `${aws.cluster.slice(0, 23)}-${createHash("sha1").update(aws.cluster).digest("hex").slice(0, 8)}`;
  const loadBalancers = await elb(aws).send(new DescribeLoadBalancersCommand({ Names: [albName] }));
  const loadBalancer = loadBalancers.LoadBalancers?.[0];
  if (!loadBalancer?.LoadBalancerArn || !loadBalancer.DNSName || loadBalancer.State?.Code !== "active") {
    throw new Error(`load balancer is ${loadBalancer?.State?.Code ?? "missing"}`);
  }
  const LoadBalancerArn = loadBalancer.LoadBalancerArn;
  const listeners = (await all(
    paginateDescribeListeners({ client: elb(aws) }, { LoadBalancerArn }),
    (page) => page.Listeners,
  )) as AwsPublicListener[];
  const origin = awsPublicOrigin(config);
  const httpsFrontDoor = origin.protocol === "https:";
  const redirects = httpsFrontDoor ? listeners.filter(isHttpsRedirectListener) : [];
  const candidates = listeners.filter((listener) => !redirects.includes(listener));
  if (candidates.length !== 1 || redirects.length > 1) {
    const found = listeners
      .map(
        (listener) =>
          `${listener.Protocol ?? "unknown"}:${listener.Port ?? "?"} (default ${listener.DefaultActions?.map((action) => action.Type ?? "unknown").join("+") || "none"})`,
      )
      .join(", ");
    throw new Error(
      `expected exactly one public listener${httpsFrontDoor ? " plus at most one port-80 HTTPS-redirect listener" : ""}, found ${found || "none"}`,
    );
  }
  const listener = candidates[0];
  if (!listener?.ListenerArn) throw new Error("public listener is missing");
  assertAwsPublicListener(origin.toString(), listener);
  return { loadBalancerArn: loadBalancer.LoadBalancerArn, dnsName: loadBalancer.DNSName, listener };
}

async function assertCloudFrontLayerTarget(config: QmConfig, url: URL, target: string): Promise<void> {
  interface Distribution {
    DomainName?: string;
    Status?: string;
    Enabled?: boolean;
    ContinuousDeploymentPolicyId?: string;
    CacheBehaviors?: { Quantity?: number };
    DefaultCacheBehavior?: {
      TargetOriginId?: string;
      MaxTTL?: number;
      CachePolicyId?: string;
      FunctionAssociations?: { Quantity?: number };
      LambdaFunctionAssociations?: { Quantity?: number };
    };
    Origins?: {
      Items?: Array<{
        Id?: string;
        DomainName?: string;
        OriginPath?: string;
        CustomOriginConfig?: { OriginProtocolPolicy?: string; HTTPPort?: number };
      }>;
    };
  }
  const cloudFront = { client: awsClient(CloudFrontClient, requireAws(config).region) };
  const distributions: Distribution[] = await all(
    paginateListDistributions(cloudFront, {}),
    (page) => page.DistributionList?.Items,
  );
  const matches = distributions.filter((distribution) => distribution.DomainName === url.hostname);
  const distribution = matches.length === 1 ? matches[0] : undefined;
  const behavior = distribution?.DefaultCacheBehavior;
  const origin = distribution?.Origins?.Items?.find((item) => item.Id === behavior?.TargetOriginId);
  if (
    !distribution?.Enabled ||
    distribution.Status !== "Deployed" ||
    distribution.ContinuousDeploymentPolicyId ||
    behavior?.MaxTTL !== 0 ||
    behavior.CachePolicyId ||
    distribution.CacheBehaviors?.Quantity !== 0 ||
    (behavior?.FunctionAssociations?.Quantity ?? 0) !== 0 ||
    (behavior?.LambdaFunctionAssociations?.Quantity ?? 0) !== 0 ||
    origin?.DomainName?.toLowerCase().replace(/\.$/, "") !== target ||
    origin.OriginPath ||
    origin.CustomOriginConfig?.OriginProtocolPolicy !== "http-only" ||
    origin.CustomOriginConfig.HTTPPort !== 80 ||
    (url.port && url.port !== "443")
  ) {
    throw new CliError(
      "AWS deployment-layer HTTPS proxy must be a deployed CloudFront distribution routing directly to the selected ALB without alternate behaviors, origin paths, or edge functions",
    );
  }
}

interface RoutingLayout {
  config: QmConfig;
  aws: AwsConfig;
  hasPortal: boolean;
  coreHosts: string[];
  ingress: string[];
  publicPaths: ReadonlyMap<string, string[]>;
  targets: Map<string, string>;
  alternateTargets: ReadonlyMap<string, string>;
  productionRules: ReadonlyMap<string, string>;
  expectedTargetArns: ReadonlySet<string>;
  listener: AwsPublicListener;
}

function assertListenerDefault(layout: RoutingLayout): void {
  const { hasPortal, targets, alternateTargets, listener } = layout;
  const defaults = listener.DefaultActions ?? [];
  if (alternateTargets.size) {
    if (
      defaults.length !== 1 ||
      defaults[0]?.Type !== "fixed-response" ||
      defaults[0].FixedResponseConfig?.StatusCode !== "404" ||
      defaults[0].TargetGroupArn
    ) {
      throw new Error("blue/green listener default must return a fixed 404 response");
    }
  } else if (hasPortal) {
    if (
      defaults.length !== 1 ||
      defaults[0]?.Type !== "forward" ||
      defaults[0].TargetGroupArn !== targets.get("portal")
    ) {
      throw new Error("portal listener default does not route only to portal");
    }
  } else if (
    defaults.length !== 1 ||
    defaults[0]?.Type !== "fixed-response" ||
    defaults[0].FixedResponseConfig?.StatusCode !== "404" ||
    defaults[0].TargetGroupArn
  ) {
    throw new Error("non-portal listener default must return a fixed 404 response");
  }
}

function ownSharedAlbRules(layout: RoutingLayout, nonDefault: Rule[]): Rule[] {
  const { config, productionRules, expectedTargetArns } = layout;
  const hostname = new URL(config.publicUrl).hostname.toLowerCase();
  const portalAppsDomain = awsPortalAppsDomain(config);
  const expectedHosts = [hostname, ...(portalAppsDomain ? [`*.${portalAppsDomain}`] : [])];
  const overlaps = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a.startsWith("*.")) return b.endsWith(a.slice(1));
    if (b.startsWith("*.")) return a.endsWith(b.slice(1));
    return false;
  };
  const ownRule = productionRules.get("portal");
  for (const rule of nonDefault) {
    const hosts = rule.Conditions?.filter((condition) => condition.Field === "host-header");
    const values = (hosts?.[0]?.HostHeaderConfig?.Values ?? hosts?.[0]?.Values ?? []).map((value) =>
      value.toLowerCase(),
    );
    const companyHosts = values.filter((value) => validAlbHostname(value));
    if (
      hosts?.length !== 1 ||
      companyHosts.length !== 1 ||
      values.some(
        (value) =>
          !validAlbHostname(value) &&
          !(
            value.startsWith("*.") &&
            validAlbHostname(value.slice(2)) &&
            value.slice(2).endsWith(`.${companyHosts[0]}`)
          ),
      )
    ) {
      throw new Error("shared ALB rules require one company hostname and company-contained app wildcards");
    }
    const matchesHost = values.some((value) =>
      expectedHosts.some((expected) => overlaps(value, expected) || overlaps(expected, value)),
    );
    if (rule.RuleArn === ownRule) {
      if (values.length !== expectedHosts.length || expectedHosts.some((value) => !values.includes(value)))
        throw new Error("shared ALB portal rule must match only this company and its configured app hostname");
    } else {
      const referencesOwnTarget = rule.Actions?.some(
        (action) =>
          expectedTargetArns.has(action.TargetGroupArn ?? "") ||
          action.ForwardConfig?.TargetGroups?.some((target) => expectedTargetArns.has(target.TargetGroupArn ?? "")),
      );
      if (matchesHost || referencesOwnTarget) throw new Error("shared ALB has an overlapping company route");
    }
  }
  return nonDefault
    .filter((rule) => rule.RuleArn === ownRule)
    .map((rule) => ({
      ...rule,
      Conditions: rule.Conditions?.filter((condition) => condition.Field !== "host-header"),
    }));
}

function publicPluginRules(layout: RoutingLayout, nonDefault: Rule[]): Set<Rule> {
  const { publicPaths, targets, alternateTargets, productionRules } = layout;
  const pluginRules = new Set<(typeof nonDefault)[number]>();
  for (const [name, paths] of publicPaths) {
    const matches = nonDefault.filter((rule) =>
      alternateTargets.size
        ? rule.RuleArn === productionRules.get(name)
        : rule.Actions?.length === 1 &&
          rule.Actions[0]?.Type === "forward" &&
          rule.Actions[0]?.TargetGroupArn === targets.get(name),
    );
    const rule = matches[0];
    const condition = rule?.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
    const actual =
      condition?.Field === "path-pattern" ? (condition.PathPatternConfig?.Values ?? condition.Values ?? []) : [];
    if (
      matches.length !== 1 ||
      !rule ||
      actual.length !== paths.length ||
      paths.some((path) => !actual.includes(path))
    ) {
      throw new Error(`public plugin ${name} must route exactly its declared publicPaths`);
    }
    pluginRules.add(rule);
  }
  for (const rule of pluginRules) {
    const priority = Number(rule.Priority);
    if (
      !Number.isInteger(priority) ||
      priority < 1 ||
      nonDefault.some(
        (other) =>
          !pluginRules.has(other) && (!Number.isInteger(Number(other.Priority)) || priority >= Number(other.Priority)),
      )
    ) {
      throw new Error("public plugin routes must precede core and portal routes");
    }
  }
  return pluginRules;
}

function blueGreenTargets(layout: RoutingLayout, nonDefault: Rule[]): ReadonlyMap<string, string> {
  const { hasPortal, coreHosts, ingress, publicPaths, targets, alternateTargets, productionRules } = layout;
  if (nonDefault.length !== ingress.length) {
    throw new Error("blue/green ALB has unexpected non-default rules");
  }
  for (const name of ingress) {
    const rule = nonDefault.find((candidate) => candidate.RuleArn === productionRules.get(name));
    const action = rule?.Actions?.length === 1 ? rule.Actions[0] : undefined;
    const weightedTargets = action?.ForwardConfig?.TargetGroups ?? [];
    const primary = targets.get(name)!;
    const alternate = alternateTargets.get(name)!;
    const expected = new Set([primary, alternate]);
    const active = weightedTargets.filter((target) => (target.Weight ?? 0) > 0);
    if (
      action?.Type !== "forward" ||
      weightedTargets.length !== 2 ||
      weightedTargets.some((target) => !target.TargetGroupArn || !expected.has(target.TargetGroupArn)) ||
      active.length !== 1 ||
      !active[0]?.TargetGroupArn
    ) {
      throw new Error(`blue/green ALB rule for ${name} must route to exactly one of its two target groups`);
    }
    const condition = rule?.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
    const pathValues =
      condition?.Field === "path-pattern" ? (condition.PathPatternConfig?.Values ?? condition.Values ?? []) : [];
    const hostValues =
      condition?.Field === "host-header" ? (condition.HostHeaderConfig?.Values ?? condition.Values ?? []) : [];
    let expectedPaths: string[];
    if (publicPaths.has(name)) expectedPaths = publicPaths.get(name)!;
    else if (name === "portal") expectedPaths = ["/*"];
    else if (hasPortal) expectedPaths = [];
    else expectedPaths = ["/v1/*"];
    const expectedHosts = name === "core" && hasPortal ? coreHosts : [];
    if (
      pathValues.length !== expectedPaths.length ||
      expectedPaths.some((value) => !pathValues.includes(value)) ||
      hostValues.length !== expectedHosts.length ||
      expectedHosts.some((value) => !hostValues.map((host) => host.toLowerCase()).includes(value))
    ) {
      throw new Error(`blue/green ALB rule for ${name} does not match its production route`);
    }
    targets.set(name, active[0].TargetGroupArn);
  }
  return targets;
}

function rollingTargets(
  layout: RoutingLayout,
  nonDefault: Rule[],
  pluginRules: Set<Rule>,
): ReadonlyMap<string, string> {
  const { hasPortal, coreHosts, targets } = layout;
  const rules = nonDefault.filter((rule) => !pluginRules.has(rule));
  if (hasPortal && !coreHosts.length && rules.length)
    throw new Error("portal mode must not expose non-default ALB rules");
  if (hasPortal && coreHosts.length) {
    const found: string[] = [];
    for (const rule of rules) {
      const action = rule.Actions?.length === 1 ? rule.Actions[0] : undefined;
      const condition = rule.Conditions?.length === 1 ? rule.Conditions[0] : undefined;
      const values =
        condition?.Field === "host-header" ? (condition.HostHeaderConfig?.Values ?? condition.Values ?? []) : [];
      if (action?.Type !== "forward" || action.TargetGroupArn !== targets.get("core") || !values.length) {
        throw new Error(
          `portal ALB has a non-default rule that is not a single host-header forward to core (expected only ${coreHosts.join(", ")})`,
        );
      }
      found.push(...values.map((value) => value.toLowerCase()));
    }
    if (found.length !== coreHosts.length || coreHosts.some((host) => !found.includes(host))) {
      throw new Error(
        `portal ALB host rules must route exactly ${coreHosts.join(", ")} to core (live: ${found.join(", ") || "none"})`,
      );
    }
  }
  if (!hasPortal) {
    const coreRule = rules.filter(
      (rule) =>
        rule.Actions?.length === 1 &&
        rule.Actions[0]?.Type === "forward" &&
        rule.Actions[0].TargetGroupArn === targets.get("core") &&
        rule.Conditions?.length === 1 &&
        rule.Conditions[0]?.Field === "path-pattern" &&
        rule.Conditions[0].PathPatternConfig?.Values?.length === 1 &&
        rule.Conditions[0].PathPatternConfig.Values[0] === "/v1/*",
    );
    if (coreRule.length !== 1) {
      throw new Error("non-portal ALB must route only /v1/* directly to core");
    }
    if (rules.length !== 1) throw new Error("non-portal ALB has unexpected non-default rules");
  }
  return targets;
}

export async function assertAwsPublicRouting(
  config: QmConfig,
  ecsServices?: ReadonlyMap<string, AwsEcsRoutingService>,
): Promise<ReadonlyMap<string, string>> {
  const aws = requireAws(config);
  const hash = (value: string, length: number): string =>
    createHash("sha1").update(value).digest("hex").slice(0, length);
  const hasPortal = hostsWebEdge(config.services);
  const frontDoor = hasPortal ? "portal" : "core";
  const pinned = (name: string): string | undefined => {
    if (name === frontDoor) return aws.services.core?.targetGroup;
    return name === "core" ? undefined : aws.services[name]?.targetGroup;
  };
  const targetName = (name: string): string =>
    pinned(name) ??
    `${aws.cluster.slice(0, 20)}-${name.replaceAll("-", "").slice(0, 4)}-${hash(`${aws.cluster}:${name}`, 6)}`;
  const ingressService = (name: string): string => (name === "portal" ? "core" : name);
  const coreHosts = hasPortal ? awsCoreHostnames(config) : [];
  let ingress = ["core"];
  if (hasPortal) ingress = coreHosts.length ? ["portal", "core"] : ["portal"];
  const publicPaths = new Map(
    Object.entries(aws.services).flatMap(([name, service]) =>
      service?.publicPaths?.length ? [[name, service.publicPaths] as const] : [],
    ),
  );
  ingress.push(...publicPaths.keys());
  const { loadBalancerArn, listener } = await awsPublicFrontDoor(config);
  const targetGroups = await all(
    paginateDescribeTargetGroups({ client: elb(aws) }, { LoadBalancerArn: loadBalancerArn }),
    (page) => page.TargetGroups,
  );
  const routingServices = ecsServices ?? (await awsEcsRoutingServices(config));
  const targets = new Map<string, string>();
  const alternateTargets = new Map<string, string>();
  const productionRules = new Map<string, string>();
  const expectedTargetArns = new Set<string>();
  for (const name of ingress) {
    const expectedName = targetName(name);
    const target = targetGroups.find((group) => group.TargetGroupName === expectedName);
    if (!target?.TargetGroupArn) throw new Error(`target group for ${name} is missing`);
    targets.set(name, target.TargetGroupArn);
    expectedTargetArns.add(target.TargetGroupArn);
    const attachment = (routingServices.get(ingressService(name))?.loadBalancers ?? []).find(
      (item) => item.targetGroupArn === target.TargetGroupArn,
    );
    if (!attachment) {
      throw new Error(`ECS service ${ingressService(name)} is not attached to the ${name} target group`);
    }
    if (name === "portal" && attachment.containerPort !== PUBLIC_PORT) {
      throw new Error(`the portal target group must reach core on its public port ${PUBLIC_PORT}`);
    }
    const alternate = attachment.advancedConfiguration?.alternateTargetGroupArn;
    const productionRule = attachment.advancedConfiguration?.productionListenerRule;
    if (Boolean(alternate) !== Boolean(productionRule)) {
      throw new Error(`ECS service ${name} has an incomplete blue/green load-balancer configuration`);
    }
    if (alternate && productionRule) {
      if (!targetGroups.some((group) => group.TargetGroupArn === alternate)) {
        throw new Error(`alternate target group for ${name} is missing`);
      }
      alternateTargets.set(name, alternate);
      productionRules.set(name, productionRule);
      expectedTargetArns.add(alternate);
    }
  }
  for (const name of Object.keys(aws.services)) {
    if (
      !ingress.map(ingressService).includes(name) &&
      !(isServiceName(name) && serviceDef(name).tcpIngress) &&
      (routingServices.get(name)?.loadBalancers ?? []).length
    ) {
      throw new Error(`private ECS service ${name} is attached to a load balancer`);
    }
  }
  if (
    !aws.sharedAlb &&
    (targetGroups.length !== expectedTargetArns.size ||
      targetGroups.some((group) => !group.TargetGroupArn || !expectedTargetArns.has(group.TargetGroupArn)))
  ) {
    throw new Error("ALB has target groups for private or unknown services");
  }
  if (alternateTargets.size && alternateTargets.size !== ingress.length) {
    throw new Error("ALB cannot mix rolling and blue/green ingress services");
  }
  if (aws.sharedAlb && (!hasPortal || coreHosts.length || publicPaths.size || alternateTargets.size !== 1)) {
    throw new Error("shared ALB requires one blue/green portal ingress without additional public routes");
  }
  const layout: RoutingLayout = {
    config,
    aws,
    hasPortal,
    coreHosts,
    ingress,
    publicPaths,
    targets,
    alternateTargets,
    productionRules,
    expectedTargetArns,
    listener,
  };
  assertListenerDefault(layout);
  const rules = await all(
    paginateDescribeRules({ client: elb(aws) }, { ListenerArn: listener.ListenerArn! }),
    (page) => page.Rules,
  );
  let nonDefault = rules.filter((rule) => !rule.IsDefault);
  if (aws.sharedAlb) nonDefault = ownSharedAlbRules(layout, nonDefault);
  const pluginRules = publicPluginRules(layout, nonDefault);
  if (alternateTargets.size) return blueGreenTargets(layout, nonDefault);
  return rollingTargets(layout, nonDefault, pluginRules);
}

export async function assertAwsPublicFrontDoor(config: QmConfig): Promise<void> {
  try {
    await assertAwsPublicRouting(config);
  } catch (error) {
    throw new CliError(`AWS public front door is not ready for deployment: ${errMessage(error)}`);
  }
}

export async function assertAwsPublicNetwork(config: QmConfig, rejectServerErrors = false): Promise<void> {
  const originHostname = awsPublicOrigin(config).hostname.toLowerCase().replace(/\.$/, "");
  const albHostname = (await awsPublicFrontDoor(config)).dnsName.toLowerCase().replace(/\.$/, "");
  if (originHostname !== albHostname) {
    const failures: string[] = [];
    const noted =
      (what: string) =>
      (error: unknown): string[] => {
        failures.push(`${what}: ${errMessage(error)}`);
        return [];
      };
    const [cnames, publicAddresses, albAddresses] = await Promise.all([
      resolveCname(originHostname).catch(noted(`CNAME ${originHostname}`)),
      lookup(originHostname, { all: true })
        .then((values) => values.map((value) => value.address))
        .catch(noted(`lookup ${originHostname}`)),
      lookup(albHostname, { all: true })
        .then((values) => values.map((value) => value.address))
        .catch(noted(`lookup ${albHostname}`)),
    ]);
    const cnameMatch = cnames.some((name) => name.toLowerCase().replace(/\.$/, "") === albHostname);
    const albSet = new Set(albAddresses);
    const addressMatch = publicAddresses.some((address) => albSet.has(address));
    if (!cnameMatch && !addressMatch) {
      throw new CliError(
        `AWS public origin ${originHostname} does not resolve to this stack's ALB ${albHostname}${failures.length ? ` (${failures.join("; ")})` : ""}`,
      );
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(config.publicUrl, { redirect: "manual", signal: controller.signal });
    await response.body?.cancel();
    if (rejectServerErrors && response.status >= 500) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new CliError(`AWS public URL is not reachable with trusted TLS and matching DNS: ${errMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertAwsHealthyIngress(config: QmConfig, targets: ReadonlyMap<string, string>): Promise<void> {
  const aws = requireAws(config);
  for (const [name, targetGroupArn] of targets) {
    const health =
      (await elb(aws).send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })))
        .TargetHealthDescriptions ?? [];
    if (!health.some((target) => target.TargetHealth?.State === "healthy")) {
      const states = health.map(
        (target) =>
          `${target.TargetHealth?.State ?? "unknown"}${target.TargetHealth?.Reason ? ` (${target.TargetHealth.Reason})` : ""}`,
      );
      throw new Error(`${name} target group has no healthy targets${states.length ? `: ${states.join(", ")}` : ""}`);
    }
  }
}
