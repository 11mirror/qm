import { randomUUID } from "node:crypto";
import { DeleteItemCommand, DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { awsClient } from "./aws-sdk.ts";
import type { AwsConfig } from "./config.ts";
import { CliError, errMessage, warn } from "./log.ts";
import { capture } from "./util.ts";

const LEASE_SECONDS = 60 * 60;

export interface AwsLease {
  table: string;
  key: string;
  holder: string;
  releaseOnSignal?: () => void;
  renewTimer?: ReturnType<typeof setInterval>;
}

export function awsText(aws: AwsConfig, args: string[]): string {
  return capture(process.env.AWS_BIN ?? "aws", [...args, "--region", aws.region, "--output", "text"]).trim();
}

export function awsErrorCode(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  if (typeof name === "string" && /^\w+(?:Exception|Fault)$/.test(name)) return name;
  const message = errMessage(error);
  return /An error occurred \((\w+)\)/.exec(message)?.[1] ?? /^\s*([A-Z]\w*(?:Exception|Fault)):/m.exec(message)?.[1];
}

export function deployLocksTable(aws: AwsConfig): string {
  return aws.deploymentState?.table ?? `${aws.cluster}-deploy-locks`;
}

export function deploymentStateKey(aws: AwsConfig, key: string): string {
  return aws.deploymentState ? `${aws.deploymentState.namespace}/${key}` : key;
}

const dynamo = (aws: AwsConfig): DynamoDBClient => awsClient(DynamoDBClient, aws.region);

export async function acquireAwsLease(aws: AwsConfig, key = "deploy"): Promise<AwsLease> {
  key = deploymentStateKey(aws, key);
  const table = deployLocksTable(aws);
  const holder = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    await dynamo(aws).send(
      new PutItemCommand({
        TableName: table,
        Item: { lockKey: { S: key }, holder: { S: holder }, expiresAt: { N: String(now + LEASE_SECONDS) } },
        ConditionExpression: "attribute_not_exists(lockKey) OR expiresAt < :now",
        ExpressionAttributeValues: { ":now": { N: String(now) } },
      }),
    );
  } catch (error) {
    if (awsErrorCode(error) === "ConditionalCheckFailedException") {
      throw new CliError(
        `another QM operation holds the ${JSON.stringify(key)} lease in ${table}; it expires within ${LEASE_SECONDS / 60} minutes, or delete that item to release it manually`,
      );
    }
    throw error;
  }
  const lease: AwsLease = { table, key, holder };
  const onSignal = (): void => {
    void releaseAwsLease(aws, lease).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  lease.releaseOnSignal = () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  lease.renewTimer = setInterval(() => void renewAwsLease(aws, lease), (LEASE_SECONDS / 3) * 1000);
  lease.renewTimer.unref();
  return lease;
}

async function renewAwsLease(aws: AwsConfig, lease: AwsLease): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await dynamo(aws).send(
      new UpdateItemCommand({
        TableName: lease.table,
        Key: { lockKey: { S: lease.key } },
        UpdateExpression: "SET expiresAt = :expiresAt",
        ConditionExpression: "holder = :holder",
        ExpressionAttributeValues: { ":expiresAt": { N: String(now + LEASE_SECONDS) }, ":holder": { S: lease.holder } },
      }),
    );
  } catch (error) {
    if (awsErrorCode(error) === "ConditionalCheckFailedException") {
      clearInterval(lease.renewTimer);
      lease.renewTimer = undefined;
      warn(
        `the ${JSON.stringify(lease.key)} lease in ${lease.table} was taken over by another QM operation; this run no longer holds it and a concurrent operation may be mutating the stack`,
      );
    } else {
      warn(`could not renew the ${JSON.stringify(lease.key)} lease in ${lease.table}: ${errMessage(error)}`);
    }
  }
}

export async function releaseAwsLease(aws: AwsConfig, lease: AwsLease): Promise<void> {
  if (lease.renewTimer) clearInterval(lease.renewTimer);
  lease.renewTimer = undefined;
  lease.releaseOnSignal?.();
  lease.releaseOnSignal = undefined;
  try {
    await dynamo(aws).send(
      new DeleteItemCommand({
        TableName: lease.table,
        Key: { lockKey: { S: lease.key } },
        ConditionExpression: "holder = :holder",
        ExpressionAttributeValues: { ":holder": { S: lease.holder } },
      }),
    );
  } catch (error) {
    warn(`could not release AWS lease: ${(error as Error).message}`);
  }
}

export async function withAwsLease<T>(aws: AwsConfig, operation: (lease: AwsLease) => Promise<T>): Promise<T> {
  const lease = await acquireAwsLease(aws);
  try {
    return await operation(lease);
  } finally {
    await releaseAwsLease(aws, lease);
  }
}
