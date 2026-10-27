/**
 * Routes AWS SDK calls made by the CLI to the fake `aws` executable the tests install at AWS_BIN, so a
 * test scripts one fake and reads one call log no matter which path a call takes. Each SDK command
 * becomes the AWS CLI invocation that sends the same request: `ECSClient` + `DescribeServicesCommand
 * { cluster, services }` runs `aws ecs describe-services --cluster <c> --services <s...>`. The fake's
 * JSON stdout is the response; a non-zero exit becomes an error named after "An error occurred (Code)".
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [package, client export, AWS CLI service]
const services = [
  ["@aws-sdk/client-dynamodb", "DynamoDBClient", "dynamodb"],
  ["@aws-sdk/client-ecs", "ECSClient", "ecs"],
  ["@aws-sdk/client-lambda-microvms", "LambdaMicrovmsClient", "lambda-microvms"],
  ["@aws-sdk/client-s3", "S3Client", "s3api"],
  ["@aws-sdk/client-sts", "STSClient", "sts"],
] as const;

const kebab = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

function cliArgs(input: Record<string, unknown>): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const flag = `--${kebab(key)}`;
    if (value === undefined) continue;
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      const file = join(mkdtempSync(join(tmpdir(), "qm-aws-body-")), "body");
      writeFileSync(file, value);
      args.push(flag, file);
    } else if (typeof value === "boolean") args.push(value ? flag : `--no-${kebab(key)}`);
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
  const result = spawnSync(bin, [service, operation, ...cliArgs(command.input as Record<string, unknown>)], {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || `${service} ${operation} exited ${result.status}`;
    const code = /An error occurred \((\w+)\)/.exec(stderr)?.[1];
    throw Object.assign(new Error(stderr), { ...(code ? { name: code } : {}), $metadata: { httpStatusCode: 400 } });
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
