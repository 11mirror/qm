import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { NoSuchKey } from "@aws-sdk/client-s3";
import { type StoredDeployBody } from "../../src/deploy/aws-deploy-provider.ts";
import { testMap } from "../support/test-database.ts";
import {
  fakeApi,
  fakeDaemon,
  provider,
  deployment,
  localSnapshot,
  version,
  ID,
  written,
} from "../support/fake-aws-deploy.ts";

function fakeS3(objects: Map<string, Uint8Array> = new Map()) {
  const calls: string[] = [];
  const s3 = {
    async send(cmd: { constructor: { name: string }; input: { Key?: string; Body?: Uint8Array } }) {
      const kind = cmd.constructor.name;
      const key = cmd.input.Key!;
      calls.push(`${kind}:${key}`);
      if (kind === "PutObjectCommand") objects.set(key, cmd.input.Body!);
      if (kind === "DeleteObjectCommand") objects.delete(key);
      if (kind === "GetObjectCommand") {
        const bytes = objects.get(key);
        if (!bytes) throw new NoSuchKey({ message: "no such key", $metadata: {} });
        return { Body: { transformToByteArray: async () => bytes } };
      }
      if (kind === "ListObjectsV2Command") {
        const prefix = (cmd.input as { Prefix?: string }).Prefix ?? "";
        return {
          Contents: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ Key: k })),
          IsTruncated: false,
        };
      }
      if (kind === "DeleteObjectsCommand") {
        for (const o of (cmd.input as unknown as { Delete: { Objects: Array<{ Key: string }> } }).Delete.Objects)
          objects.delete(o.Key);
      }
      return {};
    },
  };
  return { s3: s3 as unknown as Pick<import("@aws-sdk/client-s3").S3Client, "send">, objects, calls };
}

function fakeSts() {
  const assumes: Array<{ policy: string; role: string }> = [];
  const sts = {
    async send(cmd: { input: { RoleArn?: string; Policy?: string } }) {
      assumes.push({ policy: cmd.input.Policy ?? "", role: cmd.input.RoleArn ?? "" });
      return {
        Credentials: {
          AccessKeyId: `AKIA${assumes.length}`,
          SecretAccessKey: "sk",
          SessionToken: "tok",
          Expiration: new Date(),
        },
      };
    },
  };
  return { sts: sts as unknown as Pick<import("@aws-sdk/client-sts").STSClient, "send">, assumes };
}

test("profile: scale-to-zero is platform-managed and versions apply from git bundles", () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl);
  assert.equal(p.profile.managedScaleToZero, true);
  assert.equal(p.profile.appliesGitBundle, true);
});

test("app data: a fresh body hydrates /data from the S3 snapshot before the app starts", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs, writes } = fakeDaemon();
  const { s3, objects } = fakeS3(new Map([[`deploy-data/${ID}.tar`, Buffer.from("TARBYTES")]]));
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), { dataBucket: "bkt", s3 });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));

  assert.ok(
    writes.some((w) => w.path.startsWith("/tmp/qm-data-")),
    "snapshot tar shipped into the body",
  );
  const extractAt = execs.findIndex((c) => c.includes("tar -xf") && c.includes("/data"));
  const startAt = execs.findIndex((c) => c.includes("setsid"));
  assert.ok(extractAt >= 0, "snapshot extracted into /data");
  assert.ok(extractAt < startAt, "hydrate happens before the app starts");
  assert.ok(
    execs.some((c) => c.includes("export DATA_DIR='/data'")),
    "app is told where durable state lives",
  );
  assert.equal(objects.size, 1, "snapshot untouched by hydrate");
});

test("app data: rotating a body past the 8h window snapshots /data to S3 before terminating it", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({
    readB64: (p) => (p.startsWith("/tmp/qm-data-") ? Buffer.from("NEWTAR").toString("base64") : ""),
  });
  const { s3, objects } = fakeS3();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });

  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.equal(counts.terminate, 1, "stale body terminated");
  assert.deepEqual(
    Buffer.from(objects.get(`deploy-data/${ID}.tar`)!).toString(),
    "NEWTAR",
    "its /data landed in S3 first",
  );
});

test("app data: an empty /data is never uploaded — a fresh body can't clobber a good snapshot", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("exit 3") ? 3 : 0) });
  const { s3, calls } = fakeS3(new Map([[`deploy-data/${ID}.tar`, Buffer.from("PRECIOUS")]]));
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });

  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.ok(!calls.some((c) => c.startsWith("PutObjectCommand")), "no upload for an empty /data");
});

test("app data: a warm reach past the snapshot interval snapshots /data and stamps the pointer", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon({
    readB64: (p) => (p.startsWith("/tmp/qm-data-") ? Buffer.from("LIVE").toString("base64") : ""),
  });
  const { s3, objects } = fakeS3();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, snapshotIntervalMs: 0 });
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const before = (await store.get(ID))!.lastSnapshotMs!;

  await new Promise((r) => setTimeout(r, 5));
  await p.resolveEndpoint!(d, version("/unused"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    (await store.get(ID))!.lastSnapshotMs! > before,
    "pointer stamped so concurrent reaches don't stack snapshots",
  );
  assert.ok(objects.has(`deploy-data/${ID}.tar`), "the reach-path snapshot landed in S3");
});

test("app data: a failed rotate snapshot defers the rotation — the stale body keeps serving instead of losing its /data", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const { s3 } = fakeS3();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });

  const e = await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.equal(vms.get("mvm-old")!.state, "RUNNING", "the stale body is not terminated when its data can't be saved");
  assert.equal(counts.run, 1, "a replacement was launched ahead of the snapshot");
  assert.equal(vms.get("mvm-1")!.state, "TERMINATED", "and discarded instead of leaked");
  assert.equal(e.host, "mvm-old.lambda-microvm.us-west-2.on.aws", "the stale body keeps serving");
});

test("app data: a failed hydrate terminates the fresh body instead of leaking it", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("tar -xf") ? 1 : 0) });
  const { s3 } = fakeS3(new Map([[`deploy-data/${ID}.tar`, Buffer.from("TAR")]]));
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), { dataBucket: "bkt", s3 });
  await assert.rejects(p.apply(deployment(ID), version(localSnapshot("a", "1"))), /hydrate extract failed/);
  assert.equal(counts.terminate, 1, "the un-pointered body is terminated, not leaked to the 8h cap");
});

test("app data: an over-cap /data fails the snapshot, so rotation defers and the old body keeps its data", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("wc -c") ? 4 : 0) });
  const { s3, calls } = fakeS3();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });
  const e = await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.ok(!calls.some((c) => c.startsWith("PutObjectCommand")), "no upload for an oversized /data");
  assert.equal(vms.get("mvm-old")!.state, "RUNNING", "the old body is not terminated with unsaved data");
  assert.equal(e.host, "mvm-old.lambda-microvm.us-west-2.on.aws", "the old body keeps serving");
  assert.ok((await store.get(ID))!.rotateNotBeforeMs! > Date.now(), "rotation deferred");
});

test("app data: a deferred rotation serves the stale body from resolveEndpoint instead of forcing re-apply per reach", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const { s3 } = fakeS3();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3 });
  const d = deployment(ID);
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
    lastSnapshotMs: Date.now(),
  });

  await p.apply(d, version(localSnapshot("a", "1")));
  assert.ok((await store.get(ID))!.rotateNotBeforeMs! > Date.now(), "deferral stamped");
  const runsAfterDeferral = counts.run;
  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(resolved, "stale-but-deferred body keeps serving");
  assert.ok(resolved.renewAt! > Date.now(), "renewal is pushed past the deferral");
  assert.equal(counts.run, runsAfterDeferral, "no replacement launched during the deferral");
});

test("litestream: shadow-WAL dir is excluded from both snapshot and hydrate", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon({
    readB64: (p) => (p.startsWith("/tmp/qm-data-") ? Buffer.from("T").toString("base64") : ""),
  });
  const { s3 } = fakeS3(new Map([[`deploy-data/${ID}.tar`, Buffer.from("TAR")]]));
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  const snap = execs.find((c) => c.includes("tar -cf"));
  const extract = execs.find((c) => c.includes("tar -xf"));
  assert.ok(snap!.includes("--exclude='./.app.db-litestream'"), "snapshot excludes the shadow dir");
  assert.ok(extract!.includes("--exclude='./.app.db-litestream'"), "hydrate excludes the shadow dir");
});

test("litestream: the start script verifies replica auth and daemon liveness", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), {
    dataBucket: "bkt",
    s3,
    sts,
    dataRoleArn: "arn:aws:iam::1:role/data",
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  const start = execs.find((c) => c.includes("litestream replicate"))!;
  assert.ok(
    start.includes("litestream snapshots") && start.includes("exit 23"),
    "S3 reach/auth verified before the replica is trusted",
  );
  assert.ok(start.includes("/proc/") && start.includes("exit 22"), "daemon liveness verified after start");
});

test("litestream: replicators are found by what they are running, so a lost pid file cannot leave two on one replica", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), {
    dataBucket: "bkt",
    s3,
    sts,
    dataRoleArn: "arn:aws:iam::1:role/data",
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  const start = execs.find((c) => c.includes("litestream replicate"))!;
  assert.ok(start.includes('"$p/cmdline"'), "survivors are discovered by what they are running, not a pid file");
  assert.match(start, /litestream\|\*\/litestream/, "argv[0] identifies a replicator and never the reaping shell");
  assert.ok(
    start.indexOf("kill -TERM") < start.indexOf("litestream replicate -config"),
    "every running replicator is reaped before a new one starts",
  );
  assert.match(start, /ls_pids \| wc -l/, "exactly one replicator may be running once the script returns");
  assert.ok(
    start.indexOf("exit 25") < start.indexOf("litestream replicate -config"),
    "a survivor that outlived SIGKILL aborts before a second replicator can start on the same replica",
  );
  for (const cmd of execs) {
    assert.ok(!cmd.includes("qm-litestream.pid"), "no path a rename can orphan decides who is replicating");
  }
});

test("every script the provider hands the exec daemon parses under the shell that will run it", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), {
    dataBucket: "bkt",
    s3,
    sts,
    dataRoleArn: "arn:aws:iam::1:role/data",
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.ok(execs.length > 0, "the apply emitted scripts to check");
  const shell = spawnSync("/bin/bash", ["-c", "true"]).status === 0 ? "/bin/bash" : "/bin/sh";
  for (const cmd of execs) {
    const parsed = spawnSync(shell, ["-n"], { input: cmd, encoding: "utf8" });
    assert.equal(parsed.status, 0, `unparseable script: ${parsed.stderr}\n${cmd}`);
  }
});

test("litestream: a failed start un-pointers and terminates the body so reaches can't hit a dead app", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("litestream replicate") ? 22 : 0) });
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  await assert.rejects(p.apply(deployment(ID), version(localSnapshot("a", "1"))), /litestream start failed/);
  assert.equal(await store.get(ID), null, "pointer cleared");
  assert.equal(counts.terminate, 1, "body terminated");
});

test("app data: destroy tears down the runtime but preserves durable data — archive → restore round-trips", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const { s3, objects } = fakeS3(
    new Map([
      [`deploy-data/${ID}.tar`, Buffer.from("X")],
      [`deploy-data/${ID}/litestream/generations/x/wal/0.wal.lz4`, Buffer.from("W")],
    ]),
  );
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  await p.destroy(d);
  assert.equal(counts.terminate, 1, "runtime torn down");
  assert.equal(await store.get(ID), null, "pointer cleared");
  assert.equal(objects.size, 2, "tar and replica both survive destroy");
});

test("litestream: apply stages prefix-scoped creds + config, restores before the app starts, stamps the pointer", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs, writes } = fakeDaemon();
  const { s3 } = fakeS3();
  const { sts, assumes } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));

  assert.equal(assumes.length, 1);
  assert.equal(assumes[0]!.role, "arn:aws:iam::1:role/data");
  assert.ok(
    assumes[0]!.policy.includes(`deploy-data/${ID}/litestream/*`),
    "session policy pinned to this app's replica prefix",
  );
  assert.ok(written(writes, "/etc/qm-litestream.env"), "creds staged");
  const cfg = writes.find((w) => w.path === "/etc/qm-litestream.yml");
  assert.ok(
    Buffer.from(cfg!.b64, "base64").toString().includes(`path: deploy-data/${ID}/litestream`),
    "replica path in config",
  );
  const restoreAt = execs.findIndex((c) => c.includes("litestream restore"));
  const appAt = execs.findIndex((c) => c.includes("node server.js"));
  assert.ok(restoreAt >= 0 && restoreAt < appAt, "restore runs before the app starts");
  assert.ok(execs[restoreAt]!.includes("-if-db-not-exists"), "an existing live db is never clobbered by the replica");
  assert.ok((await store.get(ID))!.dataCredsAtMs! > 0, "cred mint time stamped for the reach-path refresh");
});

test("litestream: a warm reach with stale creds re-mints and bounces litestream", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const { s3 } = fakeS3();
  const { sts, assumes } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  await store.put(ID, { ...(await store.get(ID))!, dataCredsAtMs: 1, lastSnapshotMs: Date.now() });

  const before = execs.length;
  await p.resolveEndpoint!(d, version("/unused"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(assumes.length, 2, "fresh creds minted on the reach path");
  assert.ok(
    execs.slice(before).some((c) => c.includes("litestream replicate")),
    "litestream bounced onto the new creds",
  );
});

test("litestream: the tar snapshot excludes app.db so the replica owns the database", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon({
    readB64: (p) => (p.startsWith("/tmp/qm-data-") ? Buffer.from("T").toString("base64") : ""),
  });
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  const snap = execs.find((c) => c.includes("tar -cf") && c.includes("--exclude"));
  assert.ok(snap, "rotate snapshot ran with exclusions");
  assert.ok(
    snap!.includes("--exclude='./app.db'") && snap!.includes("--exclude='./app.db-*'"),
    "app.db and its journals excluded from the tar",
  );
});

test("litestream: hydrate never extracts a legacy tar'd app.db — a stale db would bury the replica generation", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const { s3 } = fakeS3(new Map([[`deploy-data/${ID}.tar`, Buffer.from("LEGACY-TAR-WITH-DB")]]));
  const { sts } = fakeSts();
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), {
    dataBucket: "bkt",
    s3,
    sts,
    dataRoleArn: "arn:aws:iam::1:role/data",
  });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  const extract = execs.find((c) => c.includes("tar -xf"));
  assert.ok(
    extract!.includes("app.db.tar-fallback"),
    "tar'd app.db diverted to the fallback path, never extracted in place",
  );
  assert.ok(
    extract!.includes("app.db.tar-fallback-wal"),
    "WAL journal diverted alongside the db — committed writes must travel with it",
  );
});

test("litestream: a failed restore aborts materialize instead of starting the app on an empty db", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("litestream restore") ? 21 : 0) });
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const p = provider(api, fetchImpl, testMap<StoredDeployBody>(), {
    dataBucket: "bkt",
    s3,
    sts,
    dataRoleArn: "arn:aws:iam::1:role/data",
  });
  await assert.rejects(
    p.apply(deployment(ID), version(localSnapshot("a", "1"))),
    /litestream start failed \(code 21\)/,
  );
});

test("litestream: a reused body on a binary-less image is marked for rotation, not terminated, and the memo stays clean", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("command -v litestream") ? 24 : 0) });
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  vms.set("mvm-live", { state: "RUNNING", endpoint: "mvm-live.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-live",
    endpoint: "mvm-live.lambda-microvm.us-west-2.on.aws",
    createdAtMs: Date.now(),
  });

  await assert.rejects(p.apply(deployment(ID), version(localSnapshot("a", "1"))), /binaries missing/);
  assert.equal(counts.terminate, 0, "the serving body is not terminated");
  const cur = (await store.get(ID))!;
  assert.equal(cur.microvmId, "mvm-live", "pointer intact");
  assert.equal(cur.createdAtMs, 0, "marked stale so the next touch rotates onto the current image");
});

test("litestream: a reused body's failed refresh (non-24) defers rotation with an STS backoff", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (cmd.includes("litestream replicate") ? 22 : 0) });
  const { s3 } = fakeS3();
  const { sts } = fakeSts();
  const store = testMap<StoredDeployBody>();
  const p = provider(api, fetchImpl, store, { dataBucket: "bkt", s3, sts, dataRoleArn: "arn:aws:iam::1:role/data" });
  vms.set("mvm-live", { state: "RUNNING", endpoint: "mvm-live.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-live",
    endpoint: "mvm-live.lambda-microvm.us-west-2.on.aws",
    createdAtMs: Date.now(),
  });

  await assert.rejects(p.apply(deployment(ID), version(localSnapshot("a", "1"))), /litestream start failed/);
  assert.equal(counts.terminate, 0, "the serving body is not terminated");
  const cur = (await store.get(ID))!;
  assert.ok(cur.rotateNotBeforeMs! > Date.now(), "rotation backed off");
  const nextRetryMs = cur.dataCredsAtMs! + 45 * 60_000 - Date.now();
  assert.ok(
    nextRetryMs > 0 && nextRetryMs < 2 * 60_000,
    "replicator re-bounce scheduled soon but NOT per-reach (STS backoff)",
  );
});

test("app data: $DATA_DIR is only advertised to the app when persistence is actually wired", async () => {
  const { api } = fakeApi();
  const off = fakeDaemon();
  await provider(api, off.fetchImpl).apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.ok(!off.execs.some((c) => c.includes("export DATA_DIR")), "no bucket → no $DATA_DIR promise");

  const on = fakeDaemon();
  const { s3 } = fakeS3();
  await provider(api, on.fetchImpl, testMap<StoredDeployBody>(), { dataBucket: "bkt", s3 }).apply(
    deployment(ID),
    version(localSnapshot("a", "1")),
  );
  assert.ok(
    on.execs.some((c) => c.includes("export DATA_DIR='/data'")),
    "bucket configured → $DATA_DIR exported",
  );
});

test("public subdomain: the URL is bare — reach is decided by core's ingress ACL, never a token", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const d = deployment(ID, "mysite");
  const e = await provider(api, fetchImpl).apply(d, version(localSnapshot("a", "1")));
  assert.equal(e.publicUrl, "https://mysite.apps.example.com/");
});

test("profile: advertises the durable dataDir only when persistence is wired", () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const { s3 } = fakeS3();
  assert.equal(provider(api, fetchImpl).profile.dataDir, undefined, "no bucket → no durable-data contract");
  assert.equal(
    provider(api, fetchImpl, testMap<StoredDeployBody>(), { dataBucket: "bkt", s3 }).profile.dataDir,
    "/data",
  );
});
