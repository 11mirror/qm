import { createTurnSandboxes, type TurnSandboxContext } from "../../src/core/orchestrator/sandboxes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxResources, type SandboxResource } from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import { legacySandboxId } from "../../src/sandbox/sandbox-resource-upgrade.ts";
import type { BackendSandbox } from "../../src/sandbox/sandbox.ts";
import { fixture } from "../support/sandbox-resources.ts";

test("blank sandbox identities coexist and default changes never copy files or redirect existing handles", async () => {
  const { resources, router, layers } = fixture();
  const old = await router.provision(layers);
  await router.writeFile(old, "secret", "old disk");
  const first = await resources.create("alice", "personal:alice", "local", "build");
  const second = await resources.create("alice", "personal:alice", "local", "analysis");
  const a = await router.provision(layers, { sandboxId: first.id });
  const b = await router.provision(layers, { sandboxId: second.id });
  assert.notEqual(a.id, b.id);
  assert.equal(await router.readFile(a, "secret"), null);
  await router.writeFile(a, "output", "A");
  await resources.setDefault("alice", "personal:alice", first.id);
  assert.equal((await router.provision(layers)).id, a.id);
  await resources.setDefault("alice", "personal:alice", second.id);
  assert.equal((await router.provision(layers)).id, b.id);
  assert.equal((await router.run(a, "pwd")).stdout, a.id);
  assert.equal(await router.readFile(a, "output"), "A");
  assert.equal(await router.readFile(b, "output"), null);
  assert.equal(await router.readFile(old, "secret"), "old disk");
  assert.equal(a.scopeId, "personal:alice");
  assert.equal(a.resourceId, first.id);
});

test("provisioning a running computer does not wait behind a long-running command on it", async () => {
  const { resources, router, layers } = fixture();
  const handle = await router.provision(layers);
  const command = Promise.withResolvers<void>();
  const running = resources.use(handle.resourceId!, () => command.promise);

  assert.equal((await router.provision(layers)).id, handle.id);
  command.resolve();
  await running;
});

test("an explicit sandbox id must name a real sandbox, and creating one leaves the default provider", async () => {
  const { backend, options } = fixture();
  const modal: BackendSandbox = { ...backend, profile: { ...backend.profile, backend: "modal" } };
  const backends = { local: backend, modal };
  const resources = createSandboxResources({ ...options, backends });
  const router = createSandboxRouter({ backends, defaultBackend: "local", resources });
  await resources.create("alice", "personal:alice", "modal", "Worker");
  await assert.rejects(
    router.provision([{ scopeId: "personal:alice", mode: "rw", mountPath: "" }], { sandboxId: "" }),
    /sandbox not found/,
  );
  assert.equal((await router.profileFor!("personal:alice")).backend, "local");
});

test("unset defaults remain unset durably while explicit execution remains usable", async () => {
  const { resources, router, layers, defaults } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", null);
  assert.equal((await defaults.get("personal:alice"))?.sandboxId, null);
  await assert.rejects(
    router.provision(layers),
    /sandbox list, create, set_default, then retry before reporting blocked/,
  );
  const explicit = await router.provision(layers, { sandboxId: record.id });
  assert.equal(explicit.resourceId, record.id);
  const listed = await resources.list("alice", "personal:alice");
  assert.equal(listed.defaultSandboxId, null);
  assert.equal(listed.defaultMode, "none");
  assert.equal(await resources.resolve("personal:new"), null);
});

test("legacy adoption is deterministic and reconnects the existing backing identity", async () => {
  const { resources, router, layers, records, backend } = fixture();
  const old = await backend.provision(layers);
  await backend.writeFile(old, "file", "keep");
  const lists = await Promise.all(Array.from({ length: 8 }, () => resources.list("alice", "personal:alice")));
  const id = lists[0]!.defaultSandboxId!;
  assert.equal(id, legacySandboxId("personal:alice", "local"));
  assert.ok(lists.every((list) => list.defaultSandboxId === id));
  assert.equal((await records.all()).length, 1);
  assert.equal((await records.get(id))?.backingScopeId, "personal:alice");
  const adopted = await router.provision(layers);
  assert.equal(adopted.resourceId, id);
  assert.equal(await router.readFile(adopted, "file"), "keep");
});

test("scope ACL protects inventory and target access and prevents cross-scope default credential relocation", async () => {
  const { resources } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await assert.rejects(resources.access("bob", record.id), /permission/);
  await assert.rejects(resources.list("bob", "personal:alice"), /permission/);
  await assert.rejects(resources.create("bob", "personal:alice", "local"), /permission/);
  await assert.rejects(resources.setDefault("bob", "personal:alice", record.id), /permission/);
  await assert.rejects(resources.setDefault("admin", "personal:bob", record.id), /belong to this scope/);
  assert.equal((await resources.access("admin", record.id)).id, record.id);
});

test("status and restart resolve the selected backing machine rather than legacy scope", async () => {
  const { resources, router, provisioned } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", record.id);
  assert.equal((await router.computerStatus!("personal:alice")).machine, record.backingScopeId);
  await router.restartComputer!("personal:alice");
  assert.deepEqual(provisioned, [record.backingScopeId, `restart:${record.backingScopeId}`]);
});

test("listing an untouched scope never invents a legacy machine", async () => {
  const { resources, provisioned } = fixture(undefined, []);
  assert.deepEqual(await resources.list("alice", "personal:alice"), {
    sandboxes: [],
    defaultSandboxId: null,
    defaultMode: "none",
    providers: [{ name: "local", actions: ["create", "status", "restart", "retire"] }],
  });
  assert.deepEqual(provisioned, []);
  await assert.rejects(resources.create("alice", "personal:alice", "__proto__"), /unavailable/);
  await assert.rejects(resources.create("alice", "personal:alice", "toString"), /unavailable/);
});

test("turn default changes invalidate cached provisioning while explicit calls dedupe and cleanup each computer once", async () => {
  const { resources, router, layers, backend } = fixture();
  const released: string[] = [];
  backend.teardown = async (handle) => {
    released.push(handle.id);
  };
  const a = await resources.create("alice", "personal:alice", "local");
  const b = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", a.id);
  const turn = createTurnSandboxes({
    deps: { sandbox: router, sandboxResources: resources },
    input: { origin: { kind: "user" } },
    actor: { id: "alice", type: "internal" },
    session: { id: "s" },
    resolution: { layers },
    scopeId: "personal:alice",
    memoryScopeId: "personal:alice",
    transferId: "t",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    connectorEnv: { AGENT_API_TOKEN: "scope-token" },
    ownerAuthAvailable: false,
    visibleSkills: [],
    visibleSkillsForTurn: async () => [],
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const old = await turn.provision();
  await resources.setDefault("alice", "personal:alice", b.id);
  turn.invalidateProvision();
  const next = await turn.provision();
  assert.notEqual(old.id, next.id);
  assert.equal((await router.run(old, "still old")).stdout, old.id);
  const [x, y] = await Promise.all([turn.provisionResource(a.id), turn.provisionResource(a.id)]);
  assert.equal(x, y);
  await turn.reclaimBox();
  assert.deepEqual(released.sort(), [a.backingScopeId, b.backingScopeId].sort());
});

test("retirement refuses the default, waits for an active command, and prevents future execution", async () => {
  const { resources, router, backend, layers } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", record.id);
  await assert.rejects(resources.retire("alice", record.id), /default/);
  const handle = await router.provision(layers);
  await resources.setDefault("alice", "personal:alice", null);
  let finish!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  backend.run = async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  const command = router.run(handle, "work");
  await running;
  const retiring = resources.retire("alice", record.id);
  assert.equal(destroyed, false);
  finish();
  await command;
  await retiring;
  assert.equal(destroyed, true);
  await assert.rejects(router.run(handle, "no resurrection"), /retired/);
  await assert.rejects(resources.setDefault("alice", "personal:alice", record.id), /retired/);
});

test("every handle operation rejects retirement before reaching a backend that could revive the machine", async () => {
  let backendCalls = 0;
  const hit = async (): Promise<never> => {
    backendCalls++;
    throw new Error("backend reached");
  };
  const { resources, router, layers } = fixture((backend) => {
    backend.profile.processSessions = true;
    backend.startProcess = hit;
    backend.readProcess = hit;
    backend.writeStdin = hit;
    backend.signalProcess = hit;
    backend.listProcesses = async () => [];
    backend.exportFiles = hit;
    backend.stageIn = hit;
    backend.stageOut = hit;
    backend.importFiles = hit;
  });
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  await resources.retire("alice", record.id);
  const operations: Array<() => Promise<unknown>> = [
    () => router.run(handle, "work"),
    () => router.readFile(handle, "file"),
    () => router.readFileBytes(handle, "file"),
    () => router.writeFile(handle, "file", "data"),
    () => router.writeFileBytes(handle, "file", new Uint8Array()),
    () => router.listDir(handle, "."),
    () => router.removeDir(handle, "dir"),
    () => router.teardown(handle),
    () => router.startProcess!(handle, "work"),
    () => router.readProcess!(handle, "process"),
    () => router.writeStdin!(handle, "process", "input"),
    () => router.signalProcess!(handle, "process", "TERM"),
    () => router.listProcesses!(handle),
    () => router.exportFiles!(handle),
    () => router.stageIn!(handle, "file", "blob"),
    () => router.stageOut!(handle, "file"),
    () => router.importFiles!(handle, []),
    () => resources.status("alice", record.id),
    () => resources.restart("alice", record.id),
  ];
  for (const operation of operations) await assert.rejects(operation(), /retired/);
  assert.equal(backendCalls, 0);
});

for (const fail of [false, true])
  test(`retirement waits for outstanding creation ${fail ? "failure" : "success"} and remains terminal`, async () => {
    const { resources, records, backend } = fixture();
    const provision = backend.provision;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    backend.provision = async (layers, options) => {
      if (first) {
        first = false;
        entered();
        await gate;
        if (fail) throw new Error("create failed");
      }
      return provision(layers, options);
    };
    const creating = resources.create("alice", "personal:alice", "local");
    const completed = creating.then(
      () => undefined,
      (error) => {
        assert.match(String(error), /create failed/);
      },
    );
    await started;
    const record = (await records.all())[0]!;
    let retired = false;
    const retiring = resources.retire("alice", record.id).then(() => {
      retired = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retired, false);
    assert.equal((await records.get(record.id))?.state, "provisioning");
    release();
    await Promise.all([completed, retiring]);
    assert.equal((await records.get(record.id))?.state, "retired");
    await assert.rejects(
      resources.use(record.id, async () => {}),
      /retired/,
    );
  });

test("activation preserves routes, cold identities and explicit nulls without calling a provider", async () => {
  const { options, records, defaults, routes, marker, provisioned, upgrade } = fixture(undefined, []);
  await routes.put("personal:routed", { backend: "modal" });
  await defaults.put("personal:unset", { sandboxId: null });
  const managed: SandboxResource = {
    id: "managed",
    backend: "local",
    ownerScopeId: "personal:selected",
    backingScopeId: "sandbox-managed",
    name: "managed",
    createdBy: "selected",
    createdAt: "2026-01-01",
    legacy: false,
    state: "ready",
  };
  await records.put(managed.id, managed);
  await defaults.put(managed.ownerScopeId, { sandboxId: managed.id });
  const resources = createSandboxResources({
    ...options,
    upgrade: upgrade({
      availableBackends: ["local", "modal"],
      legacyScopes: async () => ["personal:old-session", "personal:unset"],
      legacySandboxes: async () => [
        { scopeId: "personal:routed", backend: "modal", machineId: "sb-old" },
        { scopeId: "personal:routed", backend: "e2b", machineId: "e2b-cold" },
        { scopeId: "sandbox-managed", backend: "local", machineId: "managed-machine" },
      ],
    }),
  });
  const routed = await resources.resolve("personal:routed");
  assert.equal(routed?.backend, "modal");
  assert.equal(routed?.backingScopeId, "personal:routed");
  assert.equal(routed?.machineId, "sb-old");
  assert.equal(routed?.state, "unverified");
  assert.equal((await resources.resolve("personal:old-session"))?.machineId, undefined);
  assert.equal(await resources.resolve("personal:unset"), null);
  assert.equal((await resources.resolve(managed.ownerScopeId))?.id, "managed");
  assert.equal(await resources.resolve("personal:new-after-activation"), null);
  assert.ok(await marker.get("explicit-defaults"));
  const inventory = await resources.list("admin", "personal:routed");
  assert.ok(inventory.sandboxes.some((r) => r.backend === "e2b" && r.machineId === "e2b-cold"));
  assert.ok(!inventory.sandboxes.some((r) => r.legacy && r.backingScopeId === "sandbox-managed"));
  assert.deepEqual(inventory.sandboxes.find((r) => r.id === routed!.id)?.availableActions, []);
  assert.deepEqual(provisioned, []);
  assert.equal((await routes.get("personal:routed"))?.backend, "modal");
  await routes.put("personal:later", { backend: "local" });
  const restarted = createSandboxResources(options);
  assert.equal(await restarted.resolve("personal:later"), null);
  assert.equal((await restarted.resolve("personal:routed"))?.id, routed?.id);
});

test("activation retries partial durable writes without losing defaults or creating machines", async () => {
  const { options, defaults, marker, records, provisioned } = fixture(undefined, ["personal:first", "personal:second"]);
  const put = defaults.putIfAbsent;
  let fail = true;
  defaults.putIfAbsent = async (id, value) => {
    if (id === "personal:second" && fail) throw new Error("database interrupted");
    return put(id, value);
  };
  const resources = createSandboxResources(options);
  await assert.rejects(resources.resolve("personal:first"), /database interrupted/);
  assert.equal(await marker.get("explicit-defaults"), null);
  const first = await defaults.get("personal:first");
  await defaults.put("personal:first", { sandboxId: null });
  fail = false;
  await Promise.all([resources.resolve("personal:first"), resources.resolve("personal:second")]);
  assert.ok(first?.sandboxId);
  assert.equal(await resources.resolve("personal:first"), null);
  assert.equal((await records.all()).length, 2);
  assert.ok(await marker.get("explicit-defaults"));
  assert.deepEqual(provisioned, []);
});

test("boot activation freezes legacy scope adoption before a new session arrives", async () => {
  const known = ["personal:old"];
  const { options, defaults, provisioned } = fixture(undefined, known);
  const resources = createSandboxResources(options);
  await resources.initialize();
  known.push("personal:new-session");
  assert.equal(await resources.resolve("personal:new-session"), null);
  assert.equal(await defaults.get("personal:new-session"), null);
  assert.ok((await resources.resolve("personal:old"))?.id);
  assert.deepEqual(provisioned, []);
});

test("retirement deletes an inferred missing computer without provisioning, status or restore", async () => {
  const { resources, backend, provisioned } = fixture();
  await resources.initialize();
  const record = await resources.resolve("personal:alice");
  assert.equal(record?.state, "unverified");
  await resources.setDefault("alice", "personal:alice", null);
  const destroyed: string[] = [];
  backend.provision = async () => {
    throw new Error("must not restore");
  };
  backend.computerStatus = async () => {
    throw new Error("must not probe");
  };
  backend.destroyScope = async (scope) => {
    destroyed.push(scope);
  };
  await resources.retire("alice", record!.id);
  await resources.retire("alice", record!.id);
  assert.deepEqual(destroyed, ["personal:alice"]);
  assert.deepEqual(provisioned, []);
});
