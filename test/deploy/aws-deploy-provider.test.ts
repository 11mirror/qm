import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { AwsApiError } from "../../src/sandbox/aws-microvm-api.ts";
import {
  fakeApi,
  fakeDaemon,
  provider,
  deployment,
  localSnapshot,
  version,
  ID,
  written,
  store,
  clearBodies,
} from "../support/fake-aws-deploy.ts";

beforeEach(clearBodies);

test("apply: launches a MicroVM, writes the snapshot into /app, starts the app, returns a TLS endpoint", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl, execs, writes } = fakeDaemon();
  const d = deployment(ID);
  const endpoint = await provider(api, fetchImpl).apply(d, version(localSnapshot("index.html", "<h1>hi</h1>")));

  assert.equal(counts.run, 1, "one MicroVM launched");
  assert.match(endpoint.host, /^mvm-1\.lambda-microvm\.us-west-2\.on\.aws$/);
  assert.equal(endpoint.port, 443);
  assert.equal(endpoint.tls, true, "the MicroVM endpoint is dialed over TLS");
  assert.equal(endpoint.httpVersion, "2", "MicroVM ingress requests share a multiplexed HTTP/2 session");
  assert.equal(
    endpoint.proxyHeaders?.["X-aws-proxy-port"],
    "8081",
    "ingress forwards to the app port, not the daemon port",
  );
  assert.match(endpoint.proxyHeaders?.["X-aws-proxy-auth"] ?? "", /^tok-mvm-1-/);
  assert.ok(written(writes, "/app/index.html"), "snapshot file written into /app");
  assert.ok(written(writes, "/app/.qm-ready"), "ready marker written");
  assert.ok(
    execs.some((c) => c.includes("setsid") && c.includes("PORT=8081") && c.includes("node server.js")),
    "app started on its own port, detached",
  );
});

test("apply: env framework keys are authoritative — PORT/HOME are set by the runtime, published env still applies", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const d = deployment(ID);
  await provider(api, fetchImpl).apply(
    d,
    version(localSnapshot("server.js", "x"), { env: { HOME: "/tmp/evil", PORT: "3000", API_KEY: "secret" } }),
  );
  const start = execs.find((c) => c.includes("setsid"))!;
  assert.ok(start.includes("export HOME='/root'"), "HOME points at the resident-auth root");
  assert.ok(start.includes("export PORT=8081"), "PORT is the framework app port");
  assert.ok(start.includes("export API_KEY='secret'"), "published env still applies");
});

test("apply (git bundle): checks the commit out via git, writes home, no file-by-file app writes", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs, writes } = fakeDaemon();
  const d = deployment(ID, "mysite");
  const endpoint = await provider(api, fetchImpl).apply(
    d,
    version(localSnapshot(".aws/credentials", "[default]"), {
      commit: "a".repeat(40),
      homeDir: localSnapshot(".ssh/id", "KEY"),
    }),
    Buffer.from("bundle"),
  );
  assert.ok(
    execs.some((c) => c.includes("git fetch --force") && c.includes("refs/deploy-commits/")),
    "app tree pulled from the git bundle",
  );
  assert.ok(!written(writes, "/app/server.js"), "app files are not written one-by-one when a bundle is present");
  assert.ok(written(writes, "/root/.ssh/id"), "resident-auth home written into /root");
  assert.equal(endpoint.publicUrl, "https://mysite.apps.example.com/", "the URL carries no capability token");
});

test("apply (relaunch): a missing ephemeral snapshot/home dir is tolerated — app restored from the git bundle, no ENOENT", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon();
  const d = deployment(ID);
  const ver = version("/data/deployments/does-not-exist", {
    commit: "a".repeat(40),
    homeDir: "/data/deployments/also-gone",
  });
  const endpoint = await provider(api, fetchImpl).apply(d, ver, Buffer.from("bundle"));
  assert.equal(endpoint.tls, true, "endpoint returned despite the missing local dirs");
  assert.ok(
    execs.some((c) => c.includes("git fetch --force")),
    "app tree restored from the git bundle",
  );
});

test("resolveEndpoint (warm): a running, fresh body is reused — no relaunch — with a refreshed token", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  const first = await p.apply(d, version(localSnapshot("a", "1")));
  const runsAfterApply = counts.run;

  const resolved = await p.resolveEndpoint!(d, d.versions[0] ?? version("/unused"));
  assert.ok(resolved, "warm body resolves");
  assert.equal(counts.run, runsAfterApply, "no new MicroVM launched on a warm reach");
  assert.equal(resolved!.host, first.host, "same body endpoint");
  assert.equal(resolved!.tls, true);
});

test("resolveEndpoint (suspended): resumes the body and serves it warm", async () => {
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const stored = (await store.get(ID))!;
  vms.get(stored.microvmId)!.state = "SUSPENDED";

  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(resolved, "suspended body resolves after resume");
  assert.equal(counts.resume, 1, "the suspended body was resumed");
  assert.equal(counts.run, 1, "no relaunch — same body");
});

test("apply: an idle app stays suspended for its whole lifetime instead of being terminated after an hour", async () => {
  const { api, launches } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl);
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.idlePolicy?.maxIdleDurationSeconds, 900, "still suspends after 15 idle minutes");
  assert.equal(
    launches[0]!.idlePolicy?.suspendedDurationSeconds,
    launches[0]!.maximumDurationInSeconds,
    "a suspended body survives until its maximum lifetime",
  );
});

test("apply: an explicit suspended-duration setting still wins", async () => {
  const { api, launches } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store, { suspendedDurationSeconds: 600 });
  await p.apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.equal(launches[0]!.idlePolicy?.suspendedDurationSeconds, 600);
});

test("rotation: the replacement body is launched before the old one is terminated, and the old one stays resumable until then", async () => {
  const { api, vms } = fakeApi();
  const order: string[] = [];
  const realRun = api.runMicrovm.bind(api);
  const realTerminate = api.terminate.bind(api);
  api.runMicrovm = async (input) => {
    const r = await realRun(input);
    order.push(`run ${r.microvmId}`);
    return r;
  };
  api.terminate = async (id) => {
    order.push(`terminate ${id}`);
    return realTerminate(id);
  };
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  const placed = await p.apply(d, version(localSnapshot("a", "1")));
  const first = (await store.get(ID))!;
  assert.ok(placed.renewAt! > Date.now() + 6 * 3600_000, "renewal is due an hour before the 8h lifetime");
  await store.put(ID, { ...first, createdAtMs: Date.now() - 7 * 3600_000 - 60_000 });
  vms.get(first.microvmId)!.state = "SUSPENDED";
  const due = await p.resolveEndpoint(d, version("/unused"));
  assert.ok(due, "visits still reach the old body meanwhile");
  assert.ok(due.renewAt! <= Date.now(), "the endpoint reports the placement as due for renewal");

  const renewed = await p.apply(d, version(localSnapshot("a", "1")));
  const second = (await store.get(ID))!;
  assert.notEqual(second.microvmId, first.microvmId);
  assert.deepEqual(order.slice(-2), [`run ${second.microvmId}`, `terminate ${first.microvmId}`]);
  assert.ok(renewed.renewAt! > Date.now());
});

test("rotation: a replacement left behind by a crash mid-rotation is terminated on the next attempt", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const first = (await store.get(ID))!;
  vms.set("mvm-orphan", { state: "RUNNING", endpoint: "mvm-orphan.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, { ...first, replacementMicrovmId: "mvm-orphan" });

  await p.apply(d, version(localSnapshot("a", "1")));
  assert.equal(vms.get("mvm-orphan")!.state, "TERMINATED");
  const after = (await store.get(ID))!;
  assert.equal(after.microvmId, first.microvmId);
  assert.equal(after.replacementMicrovmId, undefined);
});

test("resolveEndpoint: reaches within the cache window skip the control plane", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));

  const first = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(first, "first resolve verifies against the control plane");
  const describesAfterFirst = counts.describe;
  const again = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(again, "cached resolve still serves the endpoint");
  assert.equal(again!.host, first!.host);
  assert.equal(counts.describe, describesAfterFirst, "a fresh verdict is reused without re-asking the control plane");
});

test("resolveEndpoint: an app in use is served from cache and re-checked in the background, not on the visit", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const first = await p.resolveEndpoint!(d, version("/unused"));
  const describes = counts.describe;

  t.mock.timers.tick(60_000);
  const hot = await p.resolveEndpoint!(d, version("/unused"));
  assert.equal(hot!.host, first!.host, "the visit is answered from cache");
  for (let i = 0; i < 400 && counts.describe === describes; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(counts.describe, describes + 1, "a background re-check refreshed the verdict");

  const moved = { ...d, endpoint: { host: "elsewhere.on.aws", port: 443 } };
  await p.resolveEndpoint!(moved, version("/unused"));
  assert.equal(counts.describe, describes + 2, "a placement changed by another core is re-checked before serving");
});

test("resolveEndpoint: after the idle window the visit waits for a real check, since the machine may be suspended", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { api, counts, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  await p.resolveEndpoint!(d, version("/unused"));
  const body = (await store.get(ID))!;
  vms.get(body.microvmId)!.state = "SUSPENDED";

  t.mock.timers.tick(15 * 60_000);
  const resumesBefore = counts.resume;
  assert.ok(await p.resolveEndpoint!(d, version("/unused")));
  assert.equal(counts.resume, resumesBefore + 1, "the suspended machine is resumed before the visit is served");
});

test("resolveEndpoint: concurrent misses coalesce into one control-plane pass", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const describesAfterApply = counts.describe;

  const [a, b, c] = await Promise.all([
    p.resolveEndpoint!(d, version("/unused")),
    p.resolveEndpoint!(d, version("/unused")),
    p.resolveEndpoint!(d, version("/unused")),
  ]);
  assert.ok(a && b && c);
  assert.equal(
    counts.describe,
    describesAfterApply + 1,
    "three simultaneous misses share one describe, reused by ensureRunning",
  );
});

test("resolveEndpoint: a control-plane 5xx serves the stored endpoint rather than failing the reach", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const stored = (await store.get(ID))!;
  api.tryGetMicrovm = async () => {
    throw new AwsApiError("bad gateway", 502);
  };
  api.getMicrovm = async () => {
    throw new AwsApiError("bad gateway", 502);
  };

  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(resolved, "a control-plane flap must not kill the reach");
  assert.equal(resolved!.host, stored.endpoint, "the stored body endpoint is served optimistically");
});

test("resolveEndpoint: a control-plane 429 serves the stored endpoint like a 5xx", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const stored = (await store.get(ID))!;
  api.tryGetMicrovm = async () => {
    throw new AwsApiError("throttled", 429);
  };

  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.ok(resolved, "a throttled control plane must not kill the reach");
  assert.equal(resolved!.host, stored.endpoint);
});

test("resolveEndpoint: a resolve racing a body swap neither caches the old endpoint nor drops the new pointer", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const first = (await store.get(ID))!;

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const realTryGet = api.tryGetMicrovm.bind(api);
  let stalls = 1;
  api.tryGetMicrovm = async (id) => {
    if (stalls-- > 0) await gate;
    return realTryGet(id);
  };

  const racing = p.resolveEndpoint!(d, version("/unused"));
  vms.get(first.microvmId)!.state = "TERMINATED";
  await p.apply(d, version(localSnapshot("a", "2")));
  const fresh = (await store.get(ID))!;
  assert.notEqual(fresh.microvmId, first.microvmId, "the swap launched a replacement body");
  release();
  await racing;

  assert.ok(await store.get(ID), "the stale resolve must not drop the replacement body's pointer");
  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.equal(resolved!.host, fresh.endpoint, "reaches after the swap serve the replacement body");
});

test("resolveEndpoint: destroy invalidates a hot resolve cache", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  assert.ok(await p.resolveEndpoint!(d, version("/unused")), "resolve populates the cache");

  await p.destroy(d);
  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.equal(resolved, null, "a destroyed deployment must not serve a cached endpoint");
});

test("resolveEndpoint: an app whose process and supervisor are both gone returns null, and the re-apply reuses the body", async () => {
  const { api, counts } = fakeApi();
  const appGoneProbe = (cmd: string): boolean => cmd.includes("qm-app.pid") && cmd.includes("exit 99");
  const { fetchImpl, execs } = fakeDaemon({ execCode: (cmd) => (appGoneProbe(cmd) ? 99 : 0) });
  const p = provider(api, fetchImpl);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));

  assert.equal(await p.resolveEndpoint!(d, version("/unused")), null, "a dead app is not served as a live endpoint");
  await p.apply(d, version(localSnapshot("a", "1")));
  assert.equal(counts.run, 1, "the running body is reused, only the app is restarted");
  assert.equal(execs.filter(appStartScript).length, 2, "the app was started again");
});

test("resolveEndpoint (gone): a terminated body returns null (signal to re-apply) and clears the pointer", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  const stored = (await store.get(ID))!;
  vms.get(stored.microvmId)!.state = "TERMINATED";

  const resolved = await p.resolveEndpoint!(d, version("/unused"));
  assert.equal(resolved, null, "a dead body resolves to null so the caller re-applies from git");
  assert.equal(await store.get(ID), null, "the dead body pointer is cleared");
});

test("resolveEndpoint (near the 8h cap): a stale-but-alive body keeps serving and reports itself due for renewal", async () => {
  const { api, vms } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  vms.set("mvm-old", { state: "RUNNING", endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws" });
  await store.put(ID, {
    deploymentId: ID,
    microvmId: "mvm-old",
    endpoint: "mvm-old.lambda-microvm.us-west-2.on.aws",
    createdAtMs: 0,
  });

  const resolved = await p.resolveEndpoint(d, version("/unused"));
  assert.ok(resolved, "the old body still serves visits");
  assert.ok(resolved.renewAt! <= Date.now(), "the endpoint asks the caller to renew the placement");
});

const readinessProbe = (cmd: string): boolean => cmd.includes("127.0.0.1:8081") && cmd.includes("exit 1");

test("apply: an app that never binds its port fails the deploy instead of publishing a dead endpoint", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon({ execCode: (cmd) => (readinessProbe(cmd) ? 1 : 0) });
  const p = provider(api, fetchImpl);
  await assert.rejects(
    () => p.apply(deployment(ID), version(localSnapshot("index.html", "<h1>hi</h1>"))),
    /never listened on port 8081/,
    "a silent bind failure surfaces as a failed apply, not a running deployment",
  );
});

test("apply: a failed readiness probe reports the entrypoint's own output as the reason", async () => {
  const { api } = fakeApi();
  const crash = "Error: ENOENT: no such file or directory, open '/app/dist/index.html'";
  const { fetchImpl } = fakeDaemon({
    execCode: (cmd) => (readinessProbe(cmd) ? 1 : 0),
    execStdout: (cmd) => (cmd.includes("/tmp/qm-app.log") ? crash : ""),
  });
  const p = provider(api, fetchImpl);
  await assert.rejects(
    () => p.apply(deployment(ID), version(localSnapshot("index.html", "<h1>hi</h1>"))),
    (e: Error) => e.message.includes(crash),
    "the app log is the only record of why it died, so the failure carries it",
  );
});

const appStartScript = (cmd: string): boolean => cmd.includes("setsid sh -c") && cmd.includes("/tmp/qm-app.pid");

test("apply: a port still held by a process the PID file lost fails the deploy — it never publishes on top of it", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon({ execCode: (cmd) => (appStartScript(cmd) ? 97 : 0) });
  const p = provider(api, fetchImpl);
  await assert.rejects(
    () => p.apply(deployment(ID), version(localSnapshot("index.html", "<h1>v2</h1>"))),
    /still held by a process this body cannot account for/,
    "a restart that could not happen must fail, never report success on the old process's reply",
  );
  const start = execs.find(appStartScript)!;
  assert.match(start, /exit 97/, "the start script refuses to launch while the port is still answering");
  assert.ok(
    start.indexOf("exit 97") < start.indexOf("setsid sh -c"),
    "the port-free gate runs before the new process is launched",
  );
});

test("apply: a reused body whose port stays held fails the deploy — it never lands on stale code", async () => {
  const { api } = fakeApi();
  let wedged = false;
  const { fetchImpl } = fakeDaemon({
    execCode: (cmd, url) => (wedged && appStartScript(cmd) && url.includes("mvm-1") ? 97 : 0),
  });
  const p = provider(api, fetchImpl);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "v1")));

  wedged = true;
  await assert.rejects(
    () => p.apply(d, version(localSnapshot("a", "v2"), { version: 2 })),
    /still held by a process this body cannot account for/,
    "a body already running the old code must not be reported as carrying the new version",
  );
});

test("apply: the readiness gate fails when the launched process dies instead of accepting whatever holds the port", async () => {
  const { api } = fakeApi();
  const { fetchImpl, execs } = fakeDaemon({ execCode: (cmd) => (readinessProbe(cmd) ? 98 : 0) });
  const p = provider(api, fetchImpl);
  await assert.rejects(
    () => p.apply(deployment(ID), version(localSnapshot("a", "1"))),
    /entrypoint exited without binding port 8081/,
  );
  assert.match(
    execs.find(readinessProbe)!,
    /alive "\$pid"/,
    "readiness tracks the process this deploy launched, not just the port",
  );
});

test("apply: a healthy app still publishes — the readiness gate does not fire on a bound port", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const endpoint = await provider(api, fetchImpl).apply(deployment(ID), version(localSnapshot("a", "1")));
  assert.equal(endpoint.proxyHeaders?.["X-aws-proxy-port"], "8081");
});

test("apply: a version whose snapshot is missing on this instance fails instead of publishing an empty app", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  await assert.rejects(p.apply(deployment(ID), version("/nonexistent/qm-snapshot")), /ENOENT/);
});

test("apply: a 4xx launch error (bad image or config) fails at once instead of being retried", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  api.runMicrovm = async () => {
    counts.run++;
    throw new AwsApiError("validation failed", 400);
  };
  const p = provider(api, fetchImpl, store);
  await assert.rejects(p.apply(deployment(ID), version(localSnapshot("a", "1"))), /validation failed/);
  assert.equal(counts.run, 1);
});

test("destroy: terminates the body and clears its pointer", async () => {
  const { api, counts } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  await p.destroy(d);
  assert.equal(counts.terminate, 1, "the body is terminated");
  assert.equal(await store.get(ID), null, "the pointer is cleared");
});

test("destroy: a failed terminate fails the destroy and keeps the pointer for a retry", async () => {
  const { api } = fakeApi();
  const { fetchImpl } = fakeDaemon();
  const p = provider(api, fetchImpl, store);
  const d = deployment(ID);
  await p.apply(d, version(localSnapshot("a", "1")));
  api.terminate = async () => {
    throw new AwsApiError("bad gateway", 502);
  };
  await assert.rejects(p.destroy(d), /bad gateway/);
  assert.ok(await store.get(ID), "the pointer survives so cleanup can be retried");
  api.terminate = async () => {
    throw new AwsApiError("not found", 404);
  };
  await p.destroy(d);
  assert.equal(await store.get(ID), null, "an already-gone body clears the pointer");
});
