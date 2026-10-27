/**
 * Routes AWS SDK calls made by the CLI to the fake `aws` executable the tests install at AWS_BIN, so a
 * test scripts one fake and reads one call log no matter which path a call takes. Each SDK command
 * becomes the AWS CLI invocation that sends the same request: `ECSClient` + `DescribeServicesCommand
 * { cluster, services }` runs `aws ecs describe-services --cluster <c> --services <s...>`. The fake's
 * JSON stdout is the response; a non-zero exit becomes an error named after "An error occurred (Code)".
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [package, client export, AWS CLI service]
const services = [
  ["@aws-sdk/client-cloudfront", "CloudFrontClient", "cloudfront"],
  ["@aws-sdk/client-cloudwatch-logs", "CloudWatchLogsClient", "logs"],
  ["@aws-sdk/client-dynamodb", "DynamoDBClient", "dynamodb"],
  ["@aws-sdk/client-ec2", "EC2Client", "ec2"],
  ["@aws-sdk/client-ecr", "ECRClient", "ecr"],
  ["@aws-sdk/client-ecs", "ECSClient", "ecs"],
  ["@aws-sdk/client-elastic-load-balancing-v2", "ElasticLoadBalancingV2Client", "elbv2"],
  ["@aws-sdk/client-iam", "IAMClient", "iam"],
  ["@aws-sdk/client-lambda-microvms", "LambdaMicrovmsClient", "lambda-microvms"],
  ["@aws-sdk/client-rds", "RDSClient", "rds"],
  ["@aws-sdk/client-s3", "S3Client", "s3api"],
  ["@aws-sdk/client-secrets-manager", "SecretsManagerClient", "secretsmanager"],
  ["@aws-sdk/client-servicediscovery", "ServiceDiscoveryClient", "servicediscovery"],
  ["@aws-sdk/client-sts", "STSClient", "sts"],
] as const;

const kebab = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

function bodyFile(body: string | Uint8Array): string {
  const file = join(mkdtempSync(join(tmpdir(), "qm-aws-body-")), "body");
  writeFileSync(file, body);
  return file;
}

function cliArgs(input: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const flag = `--${kebab(key)}`;
    if (value === undefined) continue;
    if (key === "Body") args.push(flag, bodyFile(value as string | Uint8Array));
    else if (typeof value === "boolean") args.push(value ? flag : `--no-${kebab(key)}`);
    else if (typeof value === "string" || typeof value === "number") args.push(flag, String(value));
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) args.push(flag, ...value);
    else args.push(flag, JSON.stringify(value));
  }
  return args;
}

function run(service: string, command: { constructor: { name: string }; input: object }): unknown {
  const bin = process.env.AWS_BIN;
  if (!bin) throw new Error("AWS SDK call in a test without a fake AWS_BIN");
  const operation = kebab(command.constructor.name.replace(/Command$/, ""));
  // get-object writes the body to an outfile operand, as the CLI does.
  const outfile =
    operation === "get-object" ? join(mkdtempSync(join(tmpdir(), "qm-aws-object-")), "object") : undefined;
  // register-task-definition takes its definition document as --cli-input-json and its tags as
  // --tags, the way the CLI used to be invoked.
  const { tags, ...definition } = command.input as { tags?: unknown };
  const input =
    operation === "register-task-definition"
      ? ["--cli-input-json", `file://${bodyFile(JSON.stringify(definition))}`, "--tags", JSON.stringify(tags)]
      : cliArgs(command.input as Record<string, unknown>);
  const argv = [service, operation, ...input, ...(outfile ? [outfile] : [])];
  const result = spawnSync(bin, argv, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || `${service} ${operation} exited ${result.status}`;
    const code = /An error occurred \((\w+)\)/.exec(stderr)?.[1];
    throw Object.assign(new Error(stderr), { ...(code ? { name: code } : {}), $metadata: { httpStatusCode: 400 } });
  }
  if (outfile) {
    const body = readFileSync(outfile, "utf8");
    return { Body: { transformToString: async () => body } };
  }
  const out = result.stdout.trim();
  return out ? JSON.parse(out) : {};
}

// A packed CLI run in a child process (`node --import` this file) sets QM_TEST_AWS_SDK_ROOT to its
// installed package, so the patch lands on the SDK copy that CLI loads.
const load = createRequire(
  join(process.env.QM_TEST_AWS_SDK_ROOT ?? join(import.meta.dirname, "../.."), "package.json"),
);
for (const [pkg, name, service] of services) {
  const Client = (load(pkg) as Record<string, { prototype: { send: unknown } }>)[name]!;
  Client.prototype.send = async function (command: never) {
    return run(service, command);
  };
}
