import assert from "node:assert/strict";
import { tenant } from "../../src/tenant.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import { sandboxScopeName } from "../../src/sandbox/exec-sandbox-base.ts";
import {
  createLocalSandbox,
  localContainerName,
  localNetworkName,
  localVolumeName,
  LOCAL_BODIES,
} from "../../src/sandbox/local-sandbox.ts";
import { supportsProcessSessions } from "../../src/sandbox/sandbox.ts";
import { createSmolmachinesSandbox, SMOLMACHINES_BODIES } from "../../src/sandbox/smolmachines-sandbox.ts";
import { createSpritesSandbox, SPRITES_BODIES } from "../../src/sandbox/sprites-sandbox.ts";
import { scopeId } from "../../src/types.ts";
import { sleep } from "../../src/util/async.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { installFakeDocker, type FakeDocker } from "../support/fake-docker.ts";
import { installFakeSmolmachines } from "../support/fake-smolmachines.ts";
import { installFakeSprites } from "../support/fake-sprites.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { testAdvisoryLock, testSandboxBodies } from "../support/test-database.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "cli/templates/aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    ...singleProcessDeps(),
    tenantConfig: () => ({ orgId: tenant().orgId }),
    store: testSandboxBodies(LOCAL_BODIES),
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a label-inspection error does not misreport an existing image as missing", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.labelInspectFails = true;
  const sb = makeSandbox(fake);
  const handle = await sb.provision(rw(scopeId("personal", "attested-image")));
  await sb.teardown(handle, { destroy: true });
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, {
    ...singleProcessDeps(),
    tenantConfig: () => ({ orgId: tenant().orgId }),
    store: testSandboxBodies(LOCAL_BODIES),
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
  });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});

test("a replacement core reattaches to an already-running sandbox", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const layers = rw(scopeId("personal", "U39"));
  const first = await makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl }).provision(layers);
  const connection = `${localNetworkName(first.id)}|qm-test-core`;
  assert.equal(fake.connections.has(connection), true);
  fake.connections.delete(connection);
  const replacement = makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl });
  const second = await replacement.provision(layers);
  assert.equal(second.id, first.id);
  assert.equal(fake.connections.has(connection), true);
  await replacement.teardown(second, { destroy: true });
});

test("containerized core joins each sandbox network and reaches the daemon by container name", async () => {
  const fake = installFakeDocker(daemonPort);
  const seen: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const sb = makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl });
  const h = await sb.provision(rw(scopeId("personal", "U40")));
  const args = fake.containers.get(h.id)!.args;
  assert.equal(args.includes("-p"), false);
  assert.equal(fake.connections.has(`${localNetworkName(h.id)}|qm-test-core`), true);
  assert.ok(seen.includes(`http://${h.id}:8080/health`));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.connections.has(`${localNetworkName(h.id)}|qm-test-core`), false);
});

test("core attachment trusts the core's actual networks, not docker's connect error", async () => {
  const fake = installFakeDocker(daemonPort);
  const fetchImpl: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/health")) return Promise.resolve(new Response("", { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ code: 0, stdout: "", stderr: "", timedOut: false })));
  };
  const layers = rw(scopeId("personal", "U42"));
  const sb = makeSandbox(fake, { coreContainer: "qm-test-core", fetchImpl });
  const first = await sb.provision(layers);
  const again = await sb.provision(layers);
  assert.equal(again.id, first.id);
  fake.connections.delete(`${localNetworkName(first.id)}|qm-test-core`);
  const refusing = makeSandbox(fake, {
    coreContainer: "qm-test-core",
    fetchImpl,
    dockerExec: async (args: string[]) =>
      args[1] === "connect" ? { code: 1, stdout: "", stderr: "endpoint already exists" } : fake.dockerExec(args),
  });
  await assert.rejects(refusing.provision(layers), /network connect .* failed: endpoint already exists/);
});

const workspace = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "destroy-scope-")));

test("Local scope deletion removes deterministic resources without provisioning, tolerates absence and propagates failures", async () => {
  const calls: string[][] = [];
  let fail = false;
  const sandbox = createLocalSandbox(workspace(), {
    ...singleProcessDeps(),
    tenantConfig: () => ({ orgId: tenant().orgId }),
    store: testSandboxBodies(LOCAL_BODIES),
    dockerExec: async (args) => {
      calls.push(args);
      return fail ? { code: 1, stdout: "", stderr: "daemon unavailable" } : { code: 0, stdout: "", stderr: "" };
    },
  });
  await sandbox.destroyScope!("missing");
  assert.deepEqual(calls, [
    ["rm", "-f", localContainerName("missing")],
    ["network", "rm", "-f", localNetworkName(localContainerName("missing"))],
    ["volume", "rm", "-f", localVolumeName("missing")],
  ]);
  fail = true;
  await assert.rejects(sandbox.destroyScope!("missing"), /daemon unavailable/);
  assert.equal(calls.length, 4);
});

test("Local scope deletion fails a refused core disconnect only while the core is still attached", async () => {
  const fake = installFakeDocker(0);
  const network = localNetworkName(localContainerName("scope"));
  const sandbox = createLocalSandbox(workspace(), {
    ...singleProcessDeps(),
    tenantConfig: () => ({ orgId: tenant().orgId }),
    store: testSandboxBodies(LOCAL_BODIES),
    coreContainer: "qm-core",
    dockerExec: async (args) =>
      args[1] === "disconnect" ? { code: 1, stdout: "", stderr: "is not connected" } : fake.dockerExec(args),
  });
  fake.connections.add(`other-net|qm-core`);
  await sandbox.destroyScope!("scope");
  fake.networks.add(network);
  fake.connections.add(`${network}|qm-core`);
  await assert.rejects(sandbox.destroyScope!("scope"), /network disconnect .*: is not connected/);
  assert.equal(fake.networks.has(network), true);
});

test("Sprites scope deletion sends only DELETE, retries provider errors, and accepts missing bodies", async () => {
  const fake = installFakeSprites();
  try {
    const sandbox = createSpritesSandbox(workspace(), {
      store: testSandboxBodies(SPRITES_BODIES),
      advisoryLock: testAdvisoryLock(),
      token: "test",
      baseUrl: fake.baseUrl,
    });
    await sandbox.provision([{ scopeId: "scope", mountPath: "", mode: "rw" }]);
    fake.calls.length = 0;
    fake.refuseDelete(503);
    await assert.rejects(sandbox.destroyScope!("scope"), /503/);
    assert.equal(fake.names().length, 1);
    fake.refuseDelete();
    await sandbox.destroyScope!("scope");
    assert.deepEqual(fake.names(), []);
    await sandbox.destroyScope!("scope");
    assert.deepEqual(
      fake.calls.map((c) => `${c.method} ${c.path}`),
      Array(6).fill(`DELETE /v1/sprites/${sandboxScopeName("qm", "scope")}`),
    );
  } finally {
    fake.cleanup();
  }
});

for (const [name, create, resource] of [["Smolmachines", createSmolmachinesSandbox, "machines"]] as const) {
  test(`${name} scope deletion finds existing bodies without booting and propagates transient deletion errors`, async () => {
    const calls: string[] = [];
    let status = 503;
    let exists = true;
    const sandbox = create(workspace(), {
      ...singleProcessDeps(),
      tenantConfig: () => ({ orgId: tenant().orgId }),
      store: testSandboxBodies(SMOLMACHINES_BODIES),
      token: "test",
      fetchImpl: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(`${init?.method} ${path}`);
        if (init?.method === "GET") {
          const rows = exists ? [{ id: "existing", name: sandboxScopeName("qm", "scope"), status: "stopped" }] : [];
          return Response.json(rows);
        }
        return new Response(null, { status, headers: { "retry-after": "0" } });
      },
    });
    await assert.rejects(sandbox.destroyScope!("scope"), /503/);
    status = 204;
    await sandbox.destroyScope!("scope");
    exists = false;
    await sandbox.destroyScope!("scope");
    assert.deepEqual(calls, [
      `GET /v1/${resource}`,
      ...Array(4).fill(`DELETE /v1/${resource}/existing`),
      `GET /v1/${resource}`,
      `DELETE /v1/${resource}/existing`,
      `GET /v1/${resource}`,
    ]);
  });
}

test("Local deletion retries remaining disk cleanup after partial failure without creating a container", async () => {
  const calls: string[][] = [];
  let volumeBusy = true;
  const sandbox = createLocalSandbox(workspace(), {
    ...singleProcessDeps(),
    tenantConfig: () => ({ orgId: tenant().orgId }),
    store: testSandboxBodies(LOCAL_BODIES),
    dockerExec: async (args) => {
      calls.push(args);
      return args[0] === "volume" && volumeBusy
        ? { code: 1, stdout: "", stderr: "volume is in use" }
        : { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(sandbox.destroyScope!("scope"), /volume is in use/);
  volumeBusy = false;
  await sandbox.destroyScope!("scope");
  assert.deepEqual(calls.slice(0, 3), calls.slice(3));
  assert.equal(calls.length, 6);
  assert.equal(calls.at(-1)?.at(-1), localVolumeName("scope"));
});

for (const [name, create, install] of [["Smolmachines", createSmolmachinesSandbox, installFakeSmolmachines]] as const) {
  test(`${name} stale adapter deletes another adapter's replacement for the same scope`, async () => {
    const fake = install();
    try {
      const options = { ...singleProcessDeps(), token: "test-token", fetchImpl: fake.fetchImpl };
      const a = create(workspace(), { ...options, store: testSandboxBodies(SMOLMACHINES_BODIES) });
      const b = create(workspace(), { ...options, store: testSandboxBodies(SMOLMACHINES_BODIES) });
      const layers = [{ scopeId: "replaced", mountPath: "", mode: "rw" as const }];
      await a.provision(layers);
      await b.destroyScope!("replaced");
      await b.provision(layers);
      assert.equal(fake.names().length, 1);
      const callsBefore = fake.calls.length;
      await a.destroyScope!("replaced");
      assert.deepEqual(fake.names(), []);
      assert.deepEqual(
        fake.calls.slice(callsBefore).map((call) => call.method),
        ["GET", "DELETE"],
      );
      await a.destroyScope!("replaced");
      assert.deepEqual(fake.names(), []);
    } finally {
      fake.cleanup();
    }
  });
}
