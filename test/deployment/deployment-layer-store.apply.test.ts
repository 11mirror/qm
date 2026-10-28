import test from "node:test";
import assert from "node:assert/strict";
import {
  DeploymentLayerPersistedError,
  DeploymentLayerValidationError,
  type StoredDeploymentLayer,
} from "../../src/deployment/deployment-layer-store.ts";
import { emptyDeploymentLayer } from "../../src/deployment/load-layer.ts";
import type { AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { computeBundleHash, createSkillBundleStore } from "../../src/skills/skill-bundle-store.ts";
import { fixture, org, readLayer } from "../support/deployment-layer.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { tool, skill } from "../support/deployment-layer.ts";

test("concurrent writes serialize into monotonic durable versions", async () => {
  const { layer } = fixture();
  const runtime = emptyDeploymentLayer();
  const store = layer({
    runtime,
  });
  await store.put({ contract: 1, tools: [tool("v1")], skills: [] }, "one");
  const [two, three] = await Promise.all([
    store.put({ contract: 1, tools: [tool("v2")], skills: [] }, "two"),
    store.put({ contract: 1, tools: [tool("v3")], skills: [] }, "three"),
  ]);
  assert.deepEqual([two.version, three.version], [2, 3]);
  assert.equal((await store.get())?.version, 3);
  assert.deepEqual(runtime.advertisedTools, ["v3"]);
});

test("two stores serialize the durable head and shared skill projection under one fleet lock", async () => {
  const { databaseUrl, skills, layer } = fixture();
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const serial = {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await fn();
      } finally {
        active--;
        release();
      }
    },
  };
  const advisoryLock: AdvisoryLock = {
    withLock: serial.withLock,
    withSharedLock: serial.withLock,
    tryWithLock: serial.withLock,
  };

  const firstRuntime = emptyDeploymentLayer();
  const secondRuntime = emptyDeploymentLayer();
  const first = layer({ runtime: firstRuntime, advisoryLock });
  const second = layer({
    runtime: secondRuntime,
    advisoryLock,
  });
  const v1 = first.put(
    {
      contract: 1,
      tools: [tool("v1")],
      skills: [{ path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: V1.\n---\nv1\n" }],
    },
    "one",
  );
  const v2 = second.put(
    {
      contract: 1,
      tools: [tool("v2")],
      skills: [{ path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: V2.\n---\nv2\n" }],
    },
    "two",
  );
  const [one, two] = await Promise.all([v1, v2]);

  assert.equal(maxActive, 1);
  assert.deepEqual([one.version, two.version], [1, 2]);
  assert.equal((await readLayer(databaseUrl))?.contentHash, two.contentHash);
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "v2\n");
  assert.deepEqual(secondRuntime.advertisedTools, ["v2"]);
  await first.get();
  assert.deepEqual(firstRuntime.advertisedTools, ["v2"], "a stale instance re-reads the fleet head before projecting");
});

test("a failed multi-skill apply rolls every deployment-owned skill back before reporting degraded", async () => {
  const { databaseUrl, skills: baseSkills, layer } = fixture();
  let failB = false;
  const skills = {
    ...baseSkills,
    create: async (input: Parameters<typeof baseSkills.create>[0]) => {
      if (failB && input.manifest.name === "b") throw new Error("b write failed");
      return baseSkills.create(input);
    },
  };
  const runtime = emptyDeploymentLayer();
  const store = layer({
    runtime,
    skills,
    retryDelaysMs: [],
  });
  await store.put(
    {
      contract: 1,
      tools: [tool("old tools")],
      skills: [
        { path: "skills/a/SKILL.md", content: "---\nname: a\ndescription: Old A.\n---\nold a\n" },
        {
          path: "skills/removed/SKILL.md",
          content: "---\nname: removed\ndescription: Kept on failure.\n---\nold removed\n",
        },
      ],
    },
    "one",
  );
  failB = true;
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [tool("new tools")],
        skills: [
          { path: "skills/a/SKILL.md", content: "---\nname: a\ndescription: New A.\n---\nnew a\n" },
          { path: "skills/b/SKILL.md", content: "---\nname: b\ndescription: B.\n---\nb\n" },
        ],
      },
      "two",
    ),
    (error: unknown) => error instanceof DeploymentLayerPersistedError && /b write failed/.test(error.message),
  );

  assert.equal((await skills.resolve("a", [org])).skill?.manifest.body, "old a\n");
  assert.equal((await skills.resolve("removed", [org])).skill?.manifest.body, "old removed\n");
  assert.equal((await skills.resolve("b", [org])).skill, null);
  assert.deepEqual(runtime.advertisedTools, ["old tools"]);
  const head = await readLayer(databaseUrl);
  assert.ok(head);
  assert.equal(await store.isApplied(head.contentHash), false);
});

test("applied status detects and repairs deployment-skill drift", async () => {
  const { skills, layer } = fixture();
  const store = layer();
  const record = await store.put({ contract: 1, tools: [], skills: skill }, "api");
  const deployed = (await skills.resolve("acme", [org])).skill!;
  await skills.archive(deployed.id);

  assert.equal(
    await store.isApplied(record.contentHash),
    false,
    "an externally archived skill invalidates applied status",
  );
  await store.get();
  assert.equal(await store.isApplied(record.contentHash), true);
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "Run the acme tool.\n");
});

test("a later hydrate reconciles a persisted layer audit exactly once", async () => {
  const { databaseUrl, layer } = fixture();
  const record = await layer().put({ contract: 1, tools: [tool("persisted before crash")], skills: [] }, "source-cli");
  const audit = createPostgresAuditLog(databaseUrl);
  const auditPersisted = (stored: StoredDeploymentLayer) =>
    audit.recordOnce!(`deployment-layer:${org}:${stored.version}`, {
      at: stored.updatedAt,
      principalId: stored.updatedBy,
      action: "deployment_layer.updated",
      resource: stored.contentHash,
      scopeLabel: org,
    });
  const recovered = layer({
    auditPersisted,
  });
  await recovered.hydrate();
  await recovered.hydrate();

  const events = await audit.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.resource, record.contentHash);
  assert.equal(events[0]?.principalId, "source-cli");
});

test("a failed audit remains recoverable after a later revision replaces the durable head", async () => {
  const { databaseUrl, layer } = fixture();
  const audited: number[] = [];
  let auditAvailable = false;
  const store = layer({
    retryDelaysMs: [],
    auditPersisted: async (record) => {
      if (!auditAvailable) throw new Error("audit unavailable");
      if (!audited.includes(record.version)) audited.push(record.version);
    },
  });

  await assert.rejects(
    store.put({ contract: 1, tools: [], skills: [] }, "one"),
    (error: unknown) => error instanceof DeploymentLayerPersistedError && error.record.version === 1,
  );
  auditAvailable = true;
  const second = await store.put({ contract: 1, tools: [tool("v2")], skills: [] }, "two");
  await store.hydrate();

  assert.equal(second.version, 2);
  assert.deepEqual(audited, [1, 2]);
  assert.deepEqual((await readLayer(databaseUrl))?.pendingAudits, []);
});

test("a foreign same-name skill rejects the PUT before anything persists", async () => {
  const { databaseUrl, skills, layer } = fixture();
  await skills.create({
    scopeId: org,
    manifest: { name: "acme", description: "user authored", requiredCapabilities: [], body: "mine" },
    createdBy: "user:alice",
  });
  const store = layer();
  await assert.rejects(
    store.put({ contract: 1, tools: [], skills: skill }, "test"),
    (e: unknown) => e instanceof DeploymentLayerValidationError && /created by user:alice/.test((e as Error).message),
  );
  assert.ok(!(await readLayer(databaseUrl)), "the colliding layer was never persisted");
});

test("deployment skill names cannot contain path separators", async () => {
  const { databaseUrl, layer } = fixture();
  const store = layer();
  const markdown = (name: string) => `---\nname: ${name}\ndescription: Test.\n---\n${name}\n`;

  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [{ path: "skills/one/SKILL.md", content: markdown("foo/bar") }],
      },
      "test",
    ),
    (error: unknown) => error instanceof DeploymentLayerValidationError && /skill name must/.test(error.message),
  );
  assert.equal(await readLayer(databaseUrl), null);
});

test("a deployment skill cannot materialize over an active pack's shared bundle", async () => {
  const { databaseUrl, skills, layer } = fixture();
  const skillBundles = createSkillBundleStore(databaseUrl);
  const packed = await skills.create({
    scopeId: org,
    manifest: { name: "packed", description: "Packed skill.", requiredCapabilities: [], body: "packed" },
    createdBy: "pack:one",
    pack: { packId: "one", commit: "abc", upstreamName: "packed" },
  });
  await skills.review(packed.id, "system:pack-reviewer", []);
  await skills.publish(packed.id);
  const files = [{ path: "skills/acme/helpers/run.ts", content: "from pack" }];
  await skillBundles.put({ packId: "one", commit: "abc", files, hash: computeBundleHash(files) });
  const store = layer({
    skillBundles,
  });

  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [...skill, { path: "skills/acme/helpers/run.ts", content: "from deployment" }],
      },
      "test",
    ),
    (error: unknown) =>
      error instanceof DeploymentLayerValidationError &&
      /skills\/acme\/helpers\/run\.ts, already claimed by pack:one/.test(error.message),
  );
  assert.equal(await readLayer(databaseUrl), null);
});

test("a foreign skill racing after validation reports the revision as persisted and degraded", async () => {
  const { databaseUrl, skills: baseSkills, layer } = fixture();
  const realList = baseSkills.list.bind(baseSkills);
  let calls = 0;
  const skills = {
    ...baseSkills,
    list: async () => {
      if (++calls === 1) return realList();
      if (calls === 2) {
        await baseSkills.create({
          scopeId: org,
          manifest: { name: "acme", description: "user authored", requiredCapabilities: [], body: "mine" },
          createdBy: "user:alice",
        });
      }
      return realList();
    },
  };
  const runtime = emptyDeploymentLayer();
  const store = layer({ runtime, skills });
  await assert.rejects(
    store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test"),
    (error: unknown) =>
      error instanceof DeploymentLayerPersistedError && /collides with an existing non-layer skill/.test(error.message),
  );
  const record = await readLayer(databaseUrl);
  assert.ok(record, "the accepted durable revision remains current");
  assert.equal(await store.isApplied(record.contentHash), false);
  assert.deepEqual(runtime.advertisedTools, [], "a failed skill projection does not expose the revision's tools");
});

test("an archived foreign skill does not block the layer; a later live collision leaves the new revision unapplied", async () => {
  const { skills, layer } = fixture();
  const archived = await skills.create({
    scopeId: org,
    manifest: { name: "acme", description: "retired", requiredCapabilities: [], body: "old" },
    createdBy: "user:alice",
  });
  await skills.review(archived.id, "user:alice", []);
  await skills.publish(archived.id);
  await skills.archive(archived.id);

  const runtime = emptyDeploymentLayer();
  const store = layer({ runtime });
  const record = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test");
  assert.equal(
    (await skills.resolve("acme", [org])).skill?.createdBy,
    "system:deployment-layer",
    "archived skills never collide",
  );

  for (const s of await skills.list()) {
    if (s.createdBy === "system:deployment-layer") await skills.delete(s.id);
  }
  const mine = await skills.create({
    scopeId: org,
    manifest: { name: "acme", description: "user authored", requiredCapabilities: [], body: "mine" },
    createdBy: "user:alice",
  });
  await skills.review(mine.id, "user:alice", []);
  await skills.publish(mine.id);
  const fresh = emptyDeploymentLayer();
  const rehydrated = layer({
    runtime: fresh,
  });
  assert.equal(
    (await rehydrated.hydrate())?.contentHash,
    record.contentHash,
    "hydrate returns the record despite the collision",
  );
  assert.deepEqual(fresh.advertisedTools, [], "the colliding revision is not partially projected");
  assert.equal(
    (await skills.resolve("acme", [org])).skill?.createdBy,
    "user:alice",
    "the user's skill was not clobbered",
  );
  await rehydrated.get();
});

test("a bundle may carry the files a tool declares under install.files, and nothing else", async () => {
  const { layer } = fixture();
  const runtime = emptyDeploymentLayer();
  const store = layer({
    runtime,
  });
  const descriptor = {
    path: "tools/acme/tool.json",
    content: JSON.stringify({
      id: "acme",
      install: { binary: "acme", files: [{ from: "acme", to: "/usr/local/bin/acme" }] },
    }),
  };
  const executable = { path: "tools/acme/acme", content: "#!/bin/sh\necho acme\n", executable: true };
  await store.put({ contract: 1, tools: [descriptor, executable], skills: [] }, "api");
  assert.deepEqual(runtime.installFiles, [
    { to: "/usr/local/bin/acme", mode: "0755", content: "#!/bin/sh\necho acme\n" },
  ]);
  await assert.rejects(
    store.put({ contract: 1, tools: [descriptor], skills: [] }, "api"),
    /declares install file acme but the bundle does not carry tools\/acme\/acme/,
  );
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [descriptor, executable, { path: "tools/acme/notes.txt", content: "stray\n" }],
        skills: [],
      },
      "api",
    ),
    /tool path must be tools\/<id>\/tool\.json: tools\/acme\/notes\.txt/,
  );
});
