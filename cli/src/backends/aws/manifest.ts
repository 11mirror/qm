import { GetItemCommand, type TransactWriteItem, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID, createHash } from "node:crypto";
import { deployLocksTable, deploymentStateKey } from "../../aws-lease.ts";
import { type AwsConfig, type QmConfig } from "../../config.ts";
import {
  assertLayerBodyFits,
  type DeploymentLayerSyncResult,
  syncDeploymentLayerBody,
} from "../../deployment-layer.ts";
import { CliError, errMessage, note, ok, warn } from "../../log.ts";
import { awsObjectStoreBucket } from "../../terraform.ts";
import { envNum, sleep } from "../../util.ts";
import { describeDbInstance, dynamo, rdsInstanceIdentifier, requireAws, s3, timestamp } from "./clients.ts";
import { type DeploymentImageProvenance } from "./images.ts";

export interface DeploymentManifest {
  id: string;
  backgroundDeploymentId?: string;
  previous?: string;
  createdAt: string;
  imageLabel?: string;
  dbSnapshot?: string;
  dbRestorePoint?: string;
  tasks: Record<string, string>;
  counts?: Record<string, number>;
  imageProvenance?: Record<string, DeploymentImageProvenance>;
  layer?: { key: string; sha256: string };
}

const DEPLOYMENT_POINTER_KEY = "deployment/current";

const DEPLOYMENT_MANIFEST_PREFIX = "deployment/manifest/";

async function deploymentStateString(aws: AwsConfig, key: string, name: string): Promise<string | undefined> {
  const { Item } = await dynamo(aws).send(
    new GetItemCommand({
      TableName: deployLocksTable(aws),
      Key: { lockKey: { S: deploymentStateKey(aws, key) } },
      ConsistentRead: true,
    }),
  );
  return Item?.[name]?.S;
}

export async function deploymentManifest(aws: AwsConfig, id: string): Promise<DeploymentManifest> {
  const raw = await deploymentStateString(aws, `${DEPLOYMENT_MANIFEST_PREFIX}${id}`, "manifest");
  if (!raw) throw new CliError(`AWS deployment manifest ${id} is missing`);
  try {
    return JSON.parse(raw) as DeploymentManifest;
  } catch {
    throw new CliError(`AWS deployment manifest ${id} is invalid`);
  }
}

export function currentDeploymentManifest(aws: AwsConfig): Promise<DeploymentManifest | undefined> {
  return deploymentManifestAtPointer(aws, DEPLOYMENT_POINTER_KEY);
}

async function deploymentManifestAtPointer(aws: AwsConfig, key: string): Promise<DeploymentManifest | undefined> {
  const id = await deploymentStateString(aws, key, "manifestId");
  return id ? await deploymentManifest(aws, id) : undefined;
}

export async function manifestTransaction(
  aws: AwsConfig,
  manifest: DeploymentManifest | undefined,
  pointerId: string,
): Promise<void> {
  const table = deployLocksTable(aws);
  const writes: TransactWriteItem[] = [];
  if (manifest) {
    writes.push({
      Put: {
        TableName: table,
        Item: {
          lockKey: { S: deploymentStateKey(aws, `${DEPLOYMENT_MANIFEST_PREFIX}${manifest.id}`) },
          manifest: { S: JSON.stringify(manifest) },
        },
      },
    });
    if (manifest.imageLabel)
      writes.push({
        Put: {
          TableName: table,
          Item: {
            lockKey: { S: deploymentStateKey(aws, `deployment/label/${manifest.imageLabel}`) },
            manifestId: { S: manifest.id },
          },
        },
      });
  }
  writes.push({
    Put: {
      TableName: table,
      Item: {
        lockKey: { S: deploymentStateKey(aws, DEPLOYMENT_POINTER_KEY) },
        manifestId: { S: pointerId },
      },
    },
  });
  try {
    await dynamo(aws).send(new TransactWriteItemsCommand({ TransactItems: writes }));
  } catch (error) {
    throw new CliError(
      `AWS deployment manifest write failed: ${errMessage(error)}; run \`qm check --live\` to establish the current manifest before deploying again`,
      { cause: error },
    );
  }
}

export async function deploymentManifestForTarget(aws: AwsConfig, target: string): Promise<DeploymentManifest> {
  const labeled = await deploymentManifestAtPointer(aws, `deployment/label/${target}`);
  return labeled ?? (await deploymentManifest(aws, target));
}

export async function recordDeploymentManifest(
  aws: AwsConfig,
  tasks: Record<string, string>,
  release: {
    id?: string;
    imageLabel?: string;
    dbRestorePoint?: string;
    layer?: DeploymentManifest["layer"];
    imageProvenance?: DeploymentManifest["imageProvenance"];
    counts?: DeploymentManifest["counts"];
    backgroundDeploymentId?: string;
  },
): Promise<DeploymentManifest> {
  const current = await currentDeploymentManifest(aws);
  const counts = release.counts ?? current?.counts;
  const manifest: DeploymentManifest = {
    id: release.id ?? randomUUID(),
    ...((release.backgroundDeploymentId ?? current?.backgroundDeploymentId)
      ? { backgroundDeploymentId: release.backgroundDeploymentId ?? current?.backgroundDeploymentId }
      : {}),
    ...(current ? { previous: current.id } : {}),
    createdAt: new Date().toISOString(),
    ...(release.imageLabel ? { imageLabel: release.imageLabel } : {}),
    ...(release.dbRestorePoint ? { dbRestorePoint: release.dbRestorePoint } : {}),
    tasks,
    ...(counts ? { counts } : {}),
    ...(release.imageProvenance ? { imageProvenance: release.imageProvenance } : {}),
    ...(release.layer ? { layer: release.layer } : {}),
  };
  await manifestTransaction(aws, manifest, manifest.id);
  return manifest;
}

export async function putDeploymentLayerArtifact(
  config: QmConfig,
  body: string,
): Promise<NonNullable<DeploymentManifest["layer"]>> {
  assertLayerBodyFits(body);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const key = `deployment/layers/${sha256}.json`;
  await s3(config).send(new PutObjectCommand({ Bucket: awsObjectStoreBucket(config), Key: key, Body: body }));
  return { key, sha256 };
}

export async function getDeploymentLayerArtifact(
  config: QmConfig,
  layer: DeploymentManifest["layer"],
): Promise<string> {
  if (!layer) throw new CliError("target AWS deployment manifest has no restorable deployment layer");
  const object = await s3(config).send(new GetObjectCommand({ Bucket: awsObjectStoreBucket(config), Key: layer.key }));
  const body = (await object.Body?.transformToString("utf8")) ?? "";
  assertLayerBodyFits(body);
  if (createHash("sha256").update(body).digest("hex") !== layer.sha256)
    throw new CliError("AWS deployment-layer artifact does not match its manifest");
  return body;
}

function assertAwsLayerApplied(
  result: DeploymentLayerSyncResult | undefined,
  expected: NonNullable<DeploymentManifest["layer"]> | string,
): void {
  const expectedHash = typeof expected === "string" ? expected : expected.sha256;
  if (!result || result.status === "degraded" || result.durable !== true || result.contentHash !== expectedHash) {
    throw new CliError("AWS deployment layer was not durably applied with the expected content hash");
  }
}

export async function retryLiveProbe<T>(probe: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + envNum("QM_AWS_LIVE_PROBE_DEADLINE_MS", 2 * 60_000);
  for (;;) {
    try {
      return await probe();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      note(`live probe failed (${errMessage(error)}); retrying while old tasks drain`);
      await sleep(envNum("QM_AWS_LIVE_PROBE_POLL_MS", 5_000));
    }
  }
}

export async function syncAwsLayerAfterRoll(
  args: Parameters<typeof syncDeploymentLayerBody>[0],
  body: string,
  expected: NonNullable<DeploymentManifest["layer"]> | string,
): Promise<void> {
  await retryLiveProbe(async () => {
    assertAwsLayerApplied(await syncDeploymentLayerBody(args, body), expected);
  });
}

function dbSnapshotRestoreHint(aws: AwsConfig, snapshot: string): string {
  return `restore: aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier ${snapshot} --db-instance-identifier ${rdsInstanceIdentifier(aws)}-restored --region ${aws.region}, then repoint the stack at the restored instance`;
}

function dbRestorePointHint(aws: AwsConfig, restorePoint: string): string {
  const database = rdsInstanceIdentifier(aws);
  return `restore: aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier ${database} --target-db-instance-identifier ${database}-restored --restore-time ${restorePoint} --region ${aws.region}, then repoint the stack at the restored instance; valid only while ${restorePoint} is inside the instance's automated-backup retention window`;
}

function manifestDbRestoreHint(aws: AwsConfig, manifest: DeploymentManifest): string | undefined {
  if (manifest.dbRestorePoint) return dbRestorePointHint(aws, manifest.dbRestorePoint);
  if (manifest.dbSnapshot) return dbSnapshotRestoreHint(aws, manifest.dbSnapshot);
  return undefined;
}

export async function assertPredeployDbRestorePoint(config: QmConfig): Promise<string> {
  const aws = requireAws(config);
  const database = rdsInstanceIdentifier(aws);
  const instance = await describeDbInstance(aws, database);
  if (instance?.DBInstanceStatus !== "available" && instance?.DBInstanceStatus !== "storage-optimization") {
    throw new CliError(
      `database ${database} is ${instance?.DBInstanceStatus ?? "missing"}; refusing to deploy without an available source for the pre-deploy restore point`,
    );
  }
  const retention = instance.BackupRetentionPeriod ?? 0;
  const minimumRetention = aws.dbRetentionMinDays ?? 1;
  if (retention < minimumRetention) {
    throw new CliError(
      `database ${database} keeps ${retention} day(s) of automated backups, below the required ${minimumRetention}; raise its backup retention (db_backup_retention_days in the reference module) or lower aws.dbRetentionMinDays before deploying`,
    );
  }
  const latestRestorable = timestamp(instance.LatestRestorableTime);
  if (!Number.isFinite(latestRestorable)) {
    throw new CliError(
      `database ${database} reports no LatestRestorableTime; point-in-time recovery is not active, refusing to deploy without a restore point`,
    );
  }
  const lagMs = Date.now() - latestRestorable;
  const maxLagMs = envNum("QM_AWS_DB_MAX_RESTORE_LAG_MS", 10 * 60_000);
  if (lagMs > maxLagMs) {
    throw new CliError(
      `database ${database} is restorable only up to ${new Date(latestRestorable).toISOString()} (${Math.round(lagMs / 1000)}s ago, above the allowed ${Math.round(maxLagMs / 1000)}s); its continuous backup stream is behind, refusing to deploy without a fresh restore point`,
    );
  }
  const restorePoint = new Date().toISOString();
  ok(
    `pre-deploy database restore point: ${restorePoint} (continuous backups current to ${Math.round(lagMs / 1000)}s ago; ${dbRestorePointHint(aws, restorePoint)})`,
  );
  return restorePoint;
}

export async function confirmDbRestorePointCovered(config: QmConfig, restorePoint: string): Promise<void> {
  const aws = requireAws(config);
  const database = rdsInstanceIdentifier(aws);
  let latestRestorable: string | undefined;
  try {
    const latest = timestamp((await describeDbInstance(aws, database))?.LatestRestorableTime);
    latestRestorable = Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
  } catch (error) {
    warn(`could not confirm the pre-deploy restore point ${restorePoint} is restorable yet: ${errMessage(error)}`);
    return;
  }
  const latest = Date.parse(latestRestorable ?? "");
  if (Number.isFinite(latest) && latest >= Date.parse(restorePoint)) {
    ok(`pre-deploy database restore point ${restorePoint} is covered by continuous backups`);
  } else if (Date.now() - Date.parse(restorePoint) <= envNum("QM_AWS_DB_MAX_RESTORE_LAG_MS", 10 * 60_000)) {
    note(
      `pre-deploy database restore point ${restorePoint} is not covered by continuous backups yet (database ${database} is restorable up to ${latestRestorable ?? "an unknown time"}); the stream catches up within minutes — leave the instance intact until it does`,
    );
  } else {
    warn(
      `pre-deploy database restore point ${restorePoint} is still not restorable: database ${database} is restorable only up to ${latestRestorable ?? "an unknown time"}; if the instance is lost before its backup stream passes the restore point, that point is unrecoverable — leave the instance intact until this catches up`,
    );
  }
}

export async function firstRolledBackDbRestore(
  aws: AwsConfig,
  current: DeploymentManifest,
  targetId: string,
): Promise<{ kind: "restore point" | "snapshot"; hint: string } | undefined> {
  const seen = new Set<string>();
  let oldest: { kind: "restore point" | "snapshot"; hint: string } | undefined;
  let manifest: DeploymentManifest | undefined = current;
  while (manifest && !seen.has(manifest.id)) {
    if (manifest.id === targetId) return oldest;
    if (manifest.dbRestorePoint) {
      oldest = { kind: "restore point", hint: `${manifest.dbRestorePoint} (${manifestDbRestoreHint(aws, manifest)})` };
    } else if (manifest.dbSnapshot) {
      oldest = { kind: "snapshot", hint: `${manifest.dbSnapshot} (${manifestDbRestoreHint(aws, manifest)})` };
    }
    seen.add(manifest.id);
    if (!manifest.previous) return undefined;
    try {
      manifest = await deploymentManifest(aws, manifest.previous);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
