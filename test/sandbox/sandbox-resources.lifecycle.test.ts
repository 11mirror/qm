import { createBackgroundBroker } from "../../src/connectors/background-exec-broker.ts";
import { supportsProcessSessions } from "../../src/sandbox/sandbox.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../../src/core/orchestrator/sandboxes.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSandboxResources } from "../../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../../src/sandbox/sandbox-routing.ts";
import { legacySandboxBackendForScope } from "../../src/sandbox/sandbox-resource-upgrade.ts";
import { createMemoryRunStore } from "../../src/runs/memory-run-store.ts";
import type { BackendSandbox } from "../../src/sandbox/sandbox.ts";
import { createPostgresProcessRegistry } from "../../src/processes/process-registry.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { fixture } from "../support/sandbox-resources.ts";

test("unsupported retirement is hidden and refuses before inventory mutation", async () => {
  const { resources, records } = fixture((backend) => {
    delete backend.destroyScope;
  });
  const record = await resources.create("alice", "personal:alice", "local");
  const before = await records.get(record.id);
  const list = await resources.list("alice", "personal:alice");
  assert.ok(!list.providers[0]!.actions.includes("retire"));
  assert.ok(!list.sandboxes.find((r) => r.id === record.id)!.availableActions!.includes("retire"));
  await assert.rejects(resources.retire("alice", record.id), /retirement unavailable/);
  assert.deepEqual(await records.get(record.id), before);
});

test("failed retirement stays unroutable and retries cleanup by backing scope after a core restart", async () => {
  const { resources, backend, records, options } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  backend.destroyScope = async () => {
    throw new Error("provider unavailable");
  };
  await assert.rejects(resources.retire("alice", record.id), /provider unavailable/);
  assert.equal((await records.get(record.id))?.cleanupPending, true);
  assert.equal((await records.get(record.id))?.state, "retired");
  await assert.rejects(resources.setDefault("alice", "personal:alice", record.id), /retired/);
  assert.deepEqual(
    (await resources.list("alice", "personal:alice")).sandboxes.find((r) => r.id === record.id)?.availableActions,
    ["retire"],
  );
  const destroyed: string[] = [];
  backend.destroyScope = async (scope) => {
    destroyed.push(scope);
  };
  backend.provision = async () => {
    throw new Error("must not restore");
  };
  const restarted = createSandboxResources(options);
  await restarted.retire("alice", record.id);
  assert.deepEqual(destroyed, [record.backingScopeId]);
  assert.equal((await records.get(record.id))?.cleanupPending, false);
  assert.equal((await records.get(record.id))?.error, undefined);
});

test("a pending retirement without an error remains retryable after a crash", async () => {
  const { resources, records, options, backend } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await records.put(record.id, { ...record, state: "retired", cleanupPending: true });
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  await createSandboxResources(options).retire("alice", record.id);
  assert.equal(destroyed, true);
  assert.equal((await records.get(record.id))?.cleanupPending, false);
});

test("retirement preserves core live-work and owning-scope guards before direct deletion", async () => {
  const { resources, records, options, backend } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  const guarded = createSandboxResources({
    ...options,
    beforeRetire: async () => {
      throw new Error("live background work");
    },
  });
  await assert.rejects(guarded.retire("mallory", record.id), /permission/);
  await assert.rejects(guarded.retire("alice", record.id), /live background work/);
  assert.equal(destroyed, false);
  assert.equal((await records.get(record.id))?.state, "ready");
});

test("retirement waits for background startup to commit its live registry row", async () => {
  const { options, backend, layers } = fixture((sandbox) => {
    sandbox.profile.processSessions = true;
    sandbox.startProcess = async () => ({ processId: "job" });
    sandbox.readProcess = async () => ({ chunks: "", cursor: 0, status: { state: "running" } });
    sandbox.writeStdin = async () => {};
    sandbox.signalProcess = async () => {};
    sandbox.listProcesses = async () => [];
  });
  const registry = createPostgresProcessRegistry(testDatabaseUrl());
  const resources = createSandboxResources({
    ...options,
    beforeRetire: async (record) => {
      if ((await registry.liveByScope(record.ownerScopeId)).some((r) => r.sandboxId === record.id))
        throw new Error("live background work");
    },
  });
  const router = createSandboxRouter({ resources, backends: { local: backend }, defaultBackend: "local" });
  assert.ok(supportsProcessSessions(router));
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entering = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const register = registry.register.bind(registry);
  registry.register = async (row) => {
    entering.resolve();
    await release.promise;
    return register(row);
  };
  const broker = createBackgroundBroker({ sandbox: router, registry, scopeId: "personal:alice", pollMs: 0 });
  const starting = broker.start(handle, "sleep 60", "Run background tests");
  await entering.promise;
  let destroyed = false;
  backend.destroyScope = async () => {
    destroyed = true;
  };
  const retiring = assert.rejects(resources.retire("alice", record.id), /live background work/);
  release.resolve();
  await Promise.all([starting, retiring]);
  assert.equal(destroyed, false);
  assert.equal((await registry.get("job"))?.sandboxId, record.id);
});

test("failed background registration kills its process and releases the resource lock", async () => {
  const { resources, router, backend, layers } = fixture((sandbox) => {
    sandbox.profile.processSessions = true;
    sandbox.startProcess = async () => ({ processId: "unregistered" });
    sandbox.readProcess = async () => ({ chunks: "", cursor: 0, status: { state: "running" } });
    sandbox.writeStdin = async () => {};
    sandbox.signalProcess = async () => {};
    sandbox.listProcesses = async () => [];
  });
  assert.ok(supportsProcessSessions(router));
  const record = await resources.create("alice", "personal:alice", "local");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const registry = createPostgresProcessRegistry(testDatabaseUrl());
  registry.register = async () => {
    throw new Error("registry unavailable");
  };
  const signals: string[] = [];
  backend.signalProcess = async (_handle, id, signal) => {
    signals.push(`${id}:${signal}`);
  };
  const broker = createBackgroundBroker({ sandbox: router, registry, scopeId: "personal:alice", pollMs: 0 });
  await assert.rejects(broker.start(handle, "sleep 60", "Run background tests"), /registry unavailable/);
  assert.deepEqual(signals, ["unregistered:KILL"]);
  await resources.retire("alice", record.id);
  assert.equal((await resources.get(record.id)).cleanupPending, false);
});

test("resource activation honors scope defaults and preserves explicit legacy provider routes", async () => {
  const { options, routes, backend, upgrade } = fixture(undefined, [
    "personal:alice",
    "channel:room",
    "personal:existing",
  ]);
  await routes.put("personal:existing", { backend: "e2b" });
  const scopeDefaults = { personal: "modal", channel: "sprites" } as const;
  const resources = createSandboxResources({
    ...options,
    upgrade: upgrade({
      availableBackends: ["e2b", "modal", "sprites"],
      legacyBackend: (scope) => legacySandboxBackendForScope(scope, "sprites", scopeDefaults),
    }),
    backends: { modal: backend, sprites: backend, e2b: backend },
    defaultBackend: "sprites",
  });
  assert.equal((await resources.resolve("personal:alice"))?.backend, "modal");
  assert.equal((await resources.resolve("channel:room"))?.backend, "sprites");
  assert.equal((await resources.resolve("personal:existing"))?.backend, "e2b");
  assert.equal(await resources.resolve("personal:new"), null);
  assert.equal(resources.defaultBackend(), "sprites");
  assert.equal(legacySandboxBackendForScope("org", "sprites", scopeDefaults), "sprites");
});

for (const [kind, waiting] of [
  ["modal", "command"],
  ["modal", "checkpoint"],
  ["sprites", "command"],
  ["sprites", "checkpoint"],
] as const) {
  test(`${kind} ${waiting} allows other tools while restart waits`, { timeout: 10000 }, async () => {
    const { options, backend, layers } = fixture();
    const resources = createSandboxResources({ ...options, backends: { [kind]: backend }, defaultBackend: kind });
    const router = createSandboxRouter({ backends: { [kind]: backend }, defaultBackend: kind, resources });
    const record = await resources.create("alice", "personal:alice", kind);
    await resources.setDefault("alice", "personal:alice", record.id);
    const handle = await router.provision(layers);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    backend.teardown = hold;
    backend.run = async (_handle, command) => {
      if (command === "long") await hold();
      return { stdout: command, stderr: "", code: 0, timedOut: false };
    };
    const long = waiting === "command" ? router.run(handle, "long") : router.teardown(handle);
    let restarted = false;
    backend.restartComputer = async () => {
      restarted = true;
    };
    let restarting: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const result = await Promise.race([
        router.run(handle, "responsive"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ordinary tool was serialized")), 1000);
        }),
      ]);
      assert.equal(result.stdout, "responsive");
      assert.equal((await resources.status("alice", record.id)).guestResponsive, true);
      restarting =
        waiting === "command" ? resources.restart("alice", record.id) : router.restartComputer!("personal:alice");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(restarted, false);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await long;
      await restarting;
    }
    assert.equal(restarted, true);
    await resources.setDefault("alice", "personal:alice", null);
    await resources.retire("alice", record.id);
    await assert.rejects(router.run(handle, "retired"), /retired/);
  });
}

test("Modal provisioning and destructive cleanup wait for active operations", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const resources = createSandboxResources({ ...options, backends: { modal: backend }, defaultBackend: "modal" });
  const router = createSandboxRouter({ backends: { modal: backend }, defaultBackend: "modal", resources });
  const record = await resources.create("alice", "personal:alice", "modal");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  backend.run = async () => {
    entered.resolve();
    await release.promise;
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  const running = router.run(handle, "long");
  await entered.promise;
  let provisioned = false;
  let destroyed = false;
  backend.provision = async () => {
    provisioned = true;
    return handle;
  };
  backend.teardown = async () => {
    destroyed = true;
  };
  const provision = router.provision(layers, { sandboxId: record.id });
  const teardown = router.teardown(handle, { destroy: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(provisioned, false);
    assert.equal(destroyed, false);
  } finally {
    release.resolve();
    await Promise.all([running, provision, teardown]);
  }
  assert.equal(provisioned, true);
  assert.equal(destroyed, true);
});

test("concurrent commands on one Sprites computer run together", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const resources = createSandboxResources({ ...options, backends: { sprites: backend }, defaultBackend: "sprites" });
  const router = createSandboxRouter({ backends: { sprites: backend }, defaultBackend: "sprites", resources });
  const record = await resources.create("alice", "personal:alice", "sprites");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const release = Promise.withResolvers<void>();
  let running = 0;
  let peak = 0;
  backend.run = async (_handle, command) => {
    peak = Math.max(peak, ++running);
    if (peak === 3) release.resolve();
    await release.promise;
    running--;
    return { stdout: command, stderr: "", code: 0, timedOut: false };
  };
  const results = await Promise.all(["a", "b", "c"].map((command) => router.run(handle, command)));
  assert.deepEqual(
    results.map((result) => result.stdout),
    ["a", "b", "c"],
  );
  assert.equal(peak, 3);
});

test("parking teardown waits for active commands on the computer", { timeout: 10000 }, async () => {
  const { options, backend, layers } = fixture();
  const parking: BackendSandbox = { ...backend, profile: { ...backend.profile, parksOnTeardown: true } };
  const resources = createSandboxResources({ ...options, backends: { e2b: parking }, defaultBackend: "e2b" });
  const router = createSandboxRouter({ backends: { e2b: parking }, defaultBackend: "e2b", resources });
  const record = await resources.create("alice", "personal:alice", "e2b");
  const handle = await router.provision(layers, { sandboxId: record.id });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  parking.run = async () => {
    entered.resolve();
    await release.promise;
    return { stdout: "done", stderr: "", code: 0, timedOut: false };
  };
  let parked = false;
  parking.teardown = async () => {
    parked = true;
  };
  const running = router.run(handle, "long");
  await entered.promise;
  const teardown = router.teardown(handle);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(parked, false);
  } finally {
    release.resolve();
    await Promise.all([running, teardown]);
  }
  assert.equal(parked, true);
});

test("a verified live turn can create only its own new scope computer without directory mutations", async () => {
  const { resources, router } = fixture(undefined, []);
  const scope = "channel:external-slack:T1:policy:C1";
  await resources.initialize();
  assert.equal(await resources.resolve(scope), null);
  await assert.rejects(resources.create("alice", scope, "local"), /permission/);
  let current = true;
  const turn = resources.forTurn({ actorId: "alice", scopeId: scope, isCurrent: async () => current });
  const computer = await turn.create("alice", scope, "local", "external work");
  await turn.setDefault("alice", scope, computer.id);
  const handle = await router.provision([{ scopeId: scope, mode: "rw", mountPath: "" }]);
  assert.equal(handle.scopeId, scope);
  await router.writeFile(handle, "result", "safe-output");
  assert.equal(await router.readFile(handle, "result"), "safe-output");
  await assert.rejects(turn.create("bob", scope, "local"), /permission/);
  await assert.rejects(turn.create("alice", "personal:bob", "local"), /permission/);
  current = false;
  await assert.rejects(turn.access("alice", computer.id), /permission/);
  await assert.rejects(turn.setDefault("alice", scope, computer.id), /permission/);
});

test("legacy import refuses an unavailable selected provider before writing any adoption state", async () => {
  const { options, upgrade, records, defaults, marker } = fixture();
  const resources = createSandboxResources({ ...options, upgrade: upgrade({ availableBackends: [] }) });
  await assert.rejects(resources.initialize(), /personal:alice: backend local is not configured/);
  assert.deepEqual(await records.all(), []);
  assert.deepEqual(await defaults.all(), []);
  assert.equal(await marker.get("explicit-defaults"), null);
  await createSandboxResources(options).initialize();
  assert.ok((await defaults.get("personal:alice"))?.sandboxId);
});

test("legacy import does not validate obsolete provider choices after explicit selection or clearing", async () => {
  const { options, upgrade, defaults, marker } = fixture(undefined, ["personal:cleared", "personal:selected"]);
  await defaults.put("personal:cleared", { sandboxId: null });
  await defaults.put("personal:selected", { sandboxId: "newer-computer" });
  await createSandboxResources({ ...options, upgrade: upgrade({ availableBackends: [] }) }).initialize();
  assert.deepEqual(await defaults.get("personal:cleared"), { sandboxId: null });
  assert.deepEqual(await defaults.get("personal:selected"), { sandboxId: "newer-computer" });
  assert.ok(await marker.get("explicit-defaults"));
});

test("a computer stays held until its last live run releases it, and ended runs stop counting", async () => {
  const { resources } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.hold(record.id, "a");
  await resources.hold(record.id, "b");
  await resources.hold(record.id, "b");
  const live = new Set(["a", "b"]);
  const isLive = async (runId: string) => live.has(runId);
  assert.equal(await resources.release(record.id, "a", isLive), true);
  live.delete("b");
  assert.equal(await resources.release(record.id, undefined, isLive), false);
  assert.deepEqual((await resources.get(record.id)).holders, []);
  const listed = (await resources.list("alice", "personal:alice")).sandboxes.find((s) => s.id === record.id);
  assert.equal(listed?.holders, undefined);
});

test("two concurrent turns on one parking computer: only the last turn to finish parks it", async () => {
  const { options, backend, layers } = fixture();
  const parking: BackendSandbox = { ...backend, profile: { ...backend.profile, parksOnTeardown: true } };
  const resources = createSandboxResources({ ...options, backends: { e2b: parking }, defaultBackend: "e2b" });
  const router = createSandboxRouter({ backends: { e2b: parking }, defaultBackend: "e2b", resources });
  const record = await resources.create("alice", "personal:alice", "e2b");
  await resources.setDefault("alice", "personal:alice", record.id);
  const teardowns: unknown[] = [];
  parking.teardown = async (_handle, opts) => {
    teardowns.push(opts ?? {});
  };
  const { runs } = createMemoryRunStore();
  const start = async (sessionId: string) => {
    await runs.enqueue({ sessionId, request: { origin: { kind: "direct" }, text: "x" } as never });
    return (await runs.claim("worker", 60_000))!;
  };
  const turn = (runId: string, sessionId: string) =>
    createTurnSandboxes({
      deps: { sandbox: router, sandboxResources: resources, runs },
      input: { origin: { kind: "user" }, runId },
      actor: { id: "alice", type: "internal" },
      session: { id: sessionId },
      resolution: { layers },
      scopeId: "personal:alice",
      memoryScopeId: "personal:alice",
      transferId: runId,
      turnSessionDir: `turn/${sessionId}`,
      turnFilesDir: `turn/${sessionId}/${runId}`,
      connectorEnv: {},
      ownerAuthAvailable: false,
      visibleSkills: [],
      visibleSkillsForTurn: async () => [],
      emitGapWork: () => {},
      perf: { credsMs: 0 },
    } as unknown as TurnSandboxContext);
  const a = await start("sa");
  const b = await start("sb");
  const first = turn(a.id, "sa");
  const second = turn(b.id, "sb");
  await Promise.all([first.provision(), second.provision()]);
  await first.reclaimBox();
  await runs.complete(a.id, a.leaseToken!, { status: "ok", reply: "done" });
  assert.deepEqual(teardowns, [{ keepWarm: true }]);
  await second.reclaimBox();
  assert.deepEqual(teardowns, [{ keepWarm: true }, {}]);
  assert.deepEqual((await resources.get(record.id)).holders, []);
});

test("same-name skills from distinct sources keep their materialized assets separate", async () => {
  const { resources, router, layers } = fixture();
  const record = await resources.create("alice", "personal:alice", "local");
  await resources.setDefault("alice", "personal:alice", record.id);
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
    connectorEnv: {},
    ownerAuthAvailable: false,
    emitGapWork: () => {},
    visibleSkillsForTurn: async (sources: readonly string[] = ["org:example", "personal:alice"]) =>
      sources.map((source) => ({
        skill: {
          id: source,
          scopeId: source,
          version: 1,
          manifest: {
            name: "helper",
            body: "Run skills/helper/value.py",
            files: [{ path: "value.py", content: source }],
          },
        },
        shadowed: [],
      })),
  } as unknown as TurnSandboxContext);
  const a = await turn.useSkill("helper", "SKILL.md", undefined, "org:example");
  const b = await turn.useSkill("helper", "SKILL.md", undefined, "personal:alice");
  const again = await turn.useSkill("helper", "SKILL.md", undefined, "org:example");
  assert.notEqual(a.dir, b.dir);
  assert.equal(a.dir, again.dir);
  const handle = await turn.provision();
  assert.equal(await router.readFile(handle, `${a.dir!.replace("/workspace/", "")}/value.py`), "org:example");
  assert.equal(await router.readFile(handle, `${b.dir!.replace("/workspace/", "")}/value.py`), "personal:alice");
});
