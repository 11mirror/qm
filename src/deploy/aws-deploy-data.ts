import { GetObjectCommand, NoSuchKey, PutObjectCommand } from "@aws-sdk/client-s3";
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { shq } from "../util/shell.ts";
import { swallowAs } from "../util/errors.ts";
import type { AwsDeployContext } from "./aws-deploy-provider.ts";

export const DATA_DIR = "/data";
const dataTarPath = (): string =>
  `/tmp/qm-data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tar`;
const DATA_DB = `${DATA_DIR}/app.db`;
const LITESTREAM_CONFIG = "/etc/qm-litestream.yml";
const LITESTREAM_ENV = "/etc/qm-litestream.env";
const LITESTREAM_LOG = "/tmp/qm-litestream.log";
const DATA_CREDS_TTL_SEC = 3600;
const MAX_DATA_TAR_BYTES = 180 * 1024 * 1024;

const LIVE_REPLICATOR_PIDS = `ls_pids() { for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null); case "\${c%% *}" in litestream|*/litestream) case "$c" in *${LITESTREAM_CONFIG}*) echo "\${p#/proc/}";; esac;; esac; done; }`;

export function awsLitestreamOps(ctx: AwsDeployContext) {
  const { region, dataBucket, dataRoleArn, sts, litestreamKeyPrefix, execRaw, writeAbs } = ctx;
  async function mintDataCreds(
    deploymentId: string,
  ): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
          Resource: `arn:aws:s3:::${dataBucket}/${litestreamKeyPrefix(deploymentId)}/*`,
        },
        {
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: `arn:aws:s3:::${dataBucket}`,
          Condition: { StringLike: { "s3:prefix": `${litestreamKeyPrefix(deploymentId)}/*` } },
        },
      ],
    });
    const r = await sts!.send(
      new AssumeRoleCommand({
        RoleArn: dataRoleArn!,
        RoleSessionName: `deploy-${deploymentId.slice(0, 8)}`,
        Policy: policy,
        DurationSeconds: DATA_CREDS_TTL_SEC,
      }),
    );
    const c = r.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken)
      throw new Error("assume-role returned no credentials");
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
  }

  async function stageLitestream(deploymentId: string, id: string, endpoint: string): Promise<void> {
    const creds = await mintDataCreds(deploymentId);
    const env = `AWS_ACCESS_KEY_ID=${creds.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${creds.secretAccessKey}\nAWS_SESSION_TOKEN=${creds.sessionToken}\nAWS_REGION=${region}\n`;
    const config = [
      "dbs:",
      `  - path: ${DATA_DB}`,
      "    replicas:",
      "      - type: s3",
      `        bucket: ${dataBucket}`,
      `        path: ${litestreamKeyPrefix(deploymentId)}`,
      `        region: ${region}`,
      "",
    ].join("\n");
    await writeAbs(id, endpoint, LITESTREAM_ENV, Buffer.from(env));
    await writeAbs(id, endpoint, LITESTREAM_CONFIG, Buffer.from(config));
  }

  const litestreamStartScript = (deploymentId: string): string => {
    const fail = (code: number): string => `{ tail -c 400 ${shq(LITESTREAM_LOG)} >&2 2>/dev/null; exit ${code}; }`;
    return [
      `command -v litestream >/dev/null 2>&1 && command -v aws >/dev/null 2>&1 || exit 24`,
      `chmod 600 ${shq(LITESTREAM_ENV)} 2>/dev/null || true`,
      `( set -a; . ${shq(LITESTREAM_ENV)}; set +a; litestream snapshots -config ${shq(LITESTREAM_CONFIG)} ${shq(DATA_DB)} && printf ok | aws s3 cp - s3://${dataBucket}/${litestreamKeyPrefix(deploymentId)}/.write-probe && aws s3 rm s3://${dataBucket}/${litestreamKeyPrefix(deploymentId)}/.write-probe ) >> ${shq(LITESTREAM_LOG)} 2>&1 || ${fail(23)}`,
      LIVE_REPLICATOR_PIDS,
      `for q in $(ls_pids); do kill -TERM "$q" 2>/dev/null || true; done`,
      `for i in $(seq 1 40); do [ -z "$(ls_pids)" ] && break; sleep 0.25; done`,
      `for q in $(ls_pids); do kill -KILL "$q" 2>/dev/null || true; done`,
      `for i in $(seq 1 40); do [ -z "$(ls_pids)" ] && break; sleep 0.25; done`,
      `[ -z "$(ls_pids)" ] || ${fail(25)}`,
      `( set -a; . ${shq(LITESTREAM_ENV)}; set +a; litestream restore -config ${shq(LITESTREAM_CONFIG)} -if-replica-exists -if-db-not-exists ${shq(DATA_DB)} ) >> ${shq(LITESTREAM_LOG)} 2>&1 || ${fail(21)}`,
      `if [ ! -f ${shq(DATA_DB)} ] && [ -f ${shq(`${DATA_DB}.tar-fallback`)} ]; then for s in -wal -shm -journal; do [ -f ${shq(`${DATA_DB}.tar-fallback`)}$s ] && mv ${shq(`${DATA_DB}.tar-fallback`)}$s ${shq(DATA_DB)}$s || true; done; mv ${shq(`${DATA_DB}.tar-fallback`)} ${shq(DATA_DB)}; fi`,
      `rm -f ${shq(`${DATA_DB}.tar-fallback`)} ${shq(`${DATA_DB}.tar-fallback`)}-wal ${shq(`${DATA_DB}.tar-fallback`)}-shm ${shq(`${DATA_DB}.tar-fallback`)}-journal`,
      `setsid sh -c ${shq(`set -a; . ${LITESTREAM_ENV}; set +a; exec litestream replicate -config ${LITESTREAM_CONFIG}`)} >> ${shq(LITESTREAM_LOG)} 2>&1 &`,
      `for i in $(seq 1 40); do [ "$(ls_pids | wc -l | tr -d '[:space:]')" = "1" ] && break; sleep 0.25; done`,
      `[ "$(ls_pids | wc -l | tr -d '[:space:]')" = "1" ] || ${fail(22)}`,
    ].join("\n");
  };

  async function refreshLitestream(deploymentId: string, id: string, endpoint: string): Promise<void> {
    await stageLitestream(deploymentId, id, endpoint);
    const r = await execRaw(id, endpoint, litestreamStartScript(deploymentId), 120);
    if (r.code !== 0) throw new Error(`litestream refresh failed (code ${r.code}): ${r.stderr.slice(0, 400)}`);
  }
  return { stageLitestream, litestreamStartScript, refreshLitestream };
}

export function awsDataSnapshots(ctx: AwsDeployContext) {
  const { dataBucket, s3, litestream, dataKeyFor, daemon, execRaw, writeAbs } = ctx;
  async function readAbsBytes(id: string, endpoint: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(id, endpoint, "/read", { path: absPath });
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`microVM read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function snapshotData(deploymentId: string, id: string, endpoint: string): Promise<boolean> {
    if (!s3 || !dataBucket) return false;
    const tarPath = dataTarPath();
    const excl = `--exclude='./app.db' --exclude='./app.db-*' --exclude='./.app.db-litestream'`;
    const ff = `! -name 'app.db' ! -name 'app.db-*' ! -path './.app.db-litestream*'`;
    const tarCmd = litestream
      ? `${LIVE_REPLICATOR_PIDS}; if [ -n "$(ls_pids)" ]; then ` +
        `[ -n "$(find . -mindepth 1 ${ff} -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} ${excl} . || { rm -f ${shq(tarPath)}; exit 5; }; ` +
        `else [ -n "$(find . -mindepth 1 -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} . || { rm -f ${shq(tarPath)}; exit 5; }; fi`
      : `[ -n "$(find . -mindepth 1 -print -quit)" ] || exit 3; tar -cf ${shq(tarPath)} . || { rm -f ${shq(tarPath)}; exit 5; }`;
    const script =
      `cd ${shq(DATA_DIR)} 2>/dev/null || exit 3; ${tarCmd}; ` +
      `[ "$(wc -c < ${shq(tarPath)})" -le ${MAX_DATA_TAR_BYTES} ] || { rm -f ${shq(tarPath)}; exit 4; }`;
    const made = await execRaw(id, endpoint, script, 180);
    if (made.code === 3) return false;
    if (made.code === 4)
      throw new Error(`data snapshot refused: /data is over the ${MAX_DATA_TAR_BYTES / 1024 / 1024} MB snapshot cap`);
    if (made.code !== 0) throw new Error(`data snapshot tar failed (code ${made.code}): ${made.stderr.slice(0, 200)}`);
    const tar = await readAbsBytes(id, endpoint, tarPath);
    await execRaw(id, endpoint, `rm -f ${shq(tarPath)}`, 30).catch(
      swallowAs("aws-deploy: remove data snapshot tar", undefined),
    );
    if (!tar?.length) throw new Error("data snapshot read-back empty");
    await s3.send(new PutObjectCommand({ Bucket: dataBucket, Key: dataKeyFor(deploymentId), Body: tar }));
    return true;
  }

  async function hydrateData(deploymentId: string, id: string, endpoint: string): Promise<void> {
    if (!s3 || !dataBucket) return;
    let tar: Uint8Array | null;
    try {
      const got = await s3.send(new GetObjectCommand({ Bucket: dataBucket, Key: dataKeyFor(deploymentId) }));
      tar = (await got.Body?.transformToByteArray()) ?? null;
    } catch (e) {
      if (e instanceof NoSuchKey) return;
      throw e;
    }
    if (!tar?.length) return;
    const tarPath = dataTarPath();
    await writeAbs(id, endpoint, tarPath, tar);
    const exclude = litestream
      ? ` --exclude='./.app.db-litestream'` +
        ` --transform='s|^\\./app\\.db$|./app.db.tar-fallback|'` +
        ` --transform='s|^\\./app\\.db-wal$|./app.db.tar-fallback-wal|'` +
        ` --transform='s|^\\./app\\.db-shm$|./app.db.tar-fallback-shm|'` +
        ` --transform='s|^\\./app\\.db-journal$|./app.db.tar-fallback-journal|'`
      : "";
    const r = await execRaw(
      id,
      endpoint,
      `mkdir -p ${shq(DATA_DIR)} && cd ${shq(DATA_DIR)} && tar -xf ${shq(tarPath)}${exclude}; rc=$?; rm -f ${shq(tarPath)}; exit $rc`,
      180,
    );
    if (r.code !== 0) throw new Error(`data hydrate extract failed: ${r.stderr.slice(0, 200)}`);
  }
  return { snapshotData, hydrateData };
}

export type AwsLitestreamOps = ReturnType<typeof awsLitestreamOps>;
export type AwsDataSnapshots = ReturnType<typeof awsDataSnapshots>;
