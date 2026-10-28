import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuperserveSandbox, type StoredSuperserveSandbox } from "../../src/sandbox/superserve-sandbox.ts";
import { createSdkSuperserveClient } from "../../src/sandbox/superserve-client.ts";
import type { SandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createNoopAdvisoryLock } from "../support/in-process-stores.ts";
import { scopeId } from "../../src/types.ts";

function httpSandbox(t: TestContext) {
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  let machine: Record<string, unknown> | undefined;
  let ignoresNetwork = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === "/sandboxes") {
      if (method === "GET") return Response.json(machine ? [machine] : []);
      machine = { ...body, id: "box-1", status: "active", access_token: "access", created_at: "2026-01-01T00:00:00Z" };
      return Response.json(machine);
    }
    if (url.pathname.endsWith("/activate")) {
      machine!.status = "active";
      return Response.json(machine);
    }
    if (url.pathname.endsWith("/pause")) machine!.status = "paused";
    if (url.pathname.startsWith("/sandboxes/") && method === "PATCH") {
      if (!ignoresNetwork) Object.assign(machine!, body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/sandboxes/") && method === "DELETE") machine = undefined;
    if (url.pathname === "/exec/stream") return new Response('data: {"stdout":"ok","finished":true,"exit_code":0}\n\n');
    if (url.pathname === "/files" && method === "GET") return new Response("bytes");
    return new Response(null, { status: 204 });
  });
  return {
    calls,
    machine: () => machine,
    ignoreNetwork: () => {
      ignoresNetwork = true;
    },
  };
}

function setup(t: TestContext, egressProxyUrl?: string) {
  const api = httpSandbox(t);
  const rows = new Map<string, StoredSuperserveSandbox>();
  const merge = async (key: string, value: Partial<StoredSuperserveSandbox>) => {
    rows.set(key, { ...rows.get(key), ...value });
  };
  const store: SandboxBodies<StoredSuperserveSandbox> = {
    get: async (key) => rows.get(key) ?? null,
    delete: async (key) => rows.delete(key),
    entries: async () => [...rows],
    update: merge,
    upsert: merge,
  };
  const make = () =>
    createSuperserveSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "super-ws-"))), {
      template: "qm-agent",
      store,
      client: createSdkSuperserveClient({ apiKey: "key", baseUrl: "https://superserve.example" }),
      advisoryLock: createNoopAdvisoryLock(),
      tenantConfig: () => ({ sandboxNamePrefix: "qm-test" }),
      ...(egressProxyUrl ? { egressProxyUrl } : {}),
    });
  const scope = scopeId("personal", "person");
  const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
  return { ...api, rows, make, scope, layers };
}

test("Superserve obeys shared provision, exec, files, pause, restart and destroy contracts over HTTP", async (t) => {
  const fixture = setup(t);
  const sandbox = fixture.make();
  const handle = await sandbox.provision(fixture.layers);
  assert.equal(handle.coldStart, true);
  const create = fixture.calls.find((c) => c.path === "/sandboxes" && c.method === "POST")!;
  assert.equal(create.body.name, handle.id);
  assert.equal(create.body.from_template, "qm-agent");
  assert.equal(create.body.preview_access, "private");
  assert.equal(create.body.auto_delete_seconds, 30 * 86400);
  assert.equal((await sandbox.run(handle, "echo hello")).stdout, "ok");
  await sandbox.writeFile(handle, "hello.txt", "bytes");
  assert.equal(await sandbox.readFile(handle, "hello.txt"), "bytes");
  await sandbox.teardown(handle);
  assert.equal(fixture.machine()!.status, "paused");
  const resumed = await fixture.make().provision(fixture.layers);
  assert.equal(resumed.id, handle.id);
  assert.equal(resumed.coldStart, false);
  await sandbox.restartComputer!(fixture.scope);
  await sandbox.destroyScope!(fixture.scope);
  assert.equal(fixture.machine(), undefined);
  assert.equal(fixture.rows.size, 0);
});

test("Superserve keep-warm and scratch lifetime remain provider policy while cleanup is shared", async (t) => {
  const fixture = setup(t);
  const sandbox = fixture.make();
  const handle = await sandbox.provision(fixture.layers);
  await sandbox.teardown(handle, { keepWarm: true });
  assert.ok(fixture.calls.some((c) => c.method === "PATCH" && c.body.timeout_seconds === 3600));
  const scratch = await sandbox.provision(fixture.layers, { scratch: { key: "scratch-key" } });
  const create = fixture.calls.findLast((c) => c.path === "/sandboxes" && c.method === "POST")!;
  assert.equal(create.body.auto_delete_seconds, 86400);
  await sandbox.teardown(scratch);
  assert.ok(fixture.calls.some((c) => c.method === "DELETE"));
});

test("Superserve template mismatch fails closed without deleting resident files", async (t) => {
  const fixture = setup(t);
  await fixture.make().provision(fixture.layers);
  fixture.machine()!.metadata = { qm_scope: fixture.machine()!.name, qm_template: "other" };
  await assert.rejects(fixture.make().provision(fixture.layers), /another template/);
  assert.equal(
    fixture.calls.some((c) => c.method === "DELETE"),
    false,
  );
});

test("Superserve refuses an unverified egress policy", async (t) => {
  const fixture = setup(t, "http://proxy.example:8080");
  await fixture.make().provision(fixture.layers);
  fixture.machine()!.network = { allow_out: ["*"], deny_out: [] };
  fixture.ignoreNetwork();
  await assert.rejects(fixture.make().provision(fixture.layers), /egress policy/);
  assert.equal(
    fixture.calls.some((c) => c.method === "DELETE"),
    false,
  );
});
