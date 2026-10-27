import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type App, type AppDeps } from "../src/api/app.ts";
import { postInstructions } from "../src/api/routes/surface-config.ts";
import { type ApiCtx, respond } from "../src/api/routes/route.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { type PersistedInstructions, type ScopedConfigStore } from "../src/resolution/config-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { type AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { failTableWrites, testAdvisoryLock, testConfigStore, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const ORG = "default-org";
const OWNER = "owner";
const PRIV_MEMBER = "priv-member";
const GROUP_MEMBER = "group-member";
const PUB_MEMBER = "pub-member";
const OUTSIDER = "outsider";

const PRIV = "C-priv";
const PUB = "C-pub";
const GROUP = "G1";
const privScope = scopeId("channel", PRIV);
const pubScope = scopeId("channel", PUB);
const groupScope = scopeId("group", GROUP);

const privMembers = new Set([OWNER, PRIV_MEMBER]);
const pubMembers = new Set([OWNER, PUB_MEMBER]);
const groupMembers = new Set([OWNER, GROUP_MEMBER]);

function makeDeps(overrides: { config?: ScopedConfigStore; advisoryLock?: AdvisoryLock } = {}) {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const crons = createCronStore(testDatabaseUrl(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const webhooks = createWebhookStore(testDatabaseUrl());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const config = overrides.config ?? testConfigStore(ORG);
  const auditLog = createPostgresAuditLog(testDatabaseUrl());
  const identity = {
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
  };
  const directory = {
    listChannelsFor: async () => [] as { channelId: string; name: string; isPrivate?: boolean }[],
    channelMember: async (c: string, p: string) =>
      (c === PRIV && privMembers.has(p)) || (c === PUB && pubMembers.has(p)),
    groupMember: async (g: string, p: string) => g === GROUP && groupMembers.has(p),
    channelPrivacy: async (c: string): Promise<boolean | undefined> => {
      if (c === PRIV) return true;
      if (c === PUB) return false;
      return undefined;
    },
  };
  const sessions = {
    listByParticipant: async () => [] as { scopeId: string }[],
    participantScopes: async () => [] as { scopeId: string }[],
  };
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const deployRows: Deployment[] = [];
  const deploy = { listDeployments: async () => deployRows };
  return {
    files,
    crons,
    webhooks,
    acl,
    config,
    auditLog,
    identity,
    directory,
    sessions,
    skills,
    deploy,
    advisoryLock: overrides.advisoryLock ?? testAdvisoryLock(),
  };
}

function makeApp(): App {
  return createApp(makeDeps() as unknown as AppDeps);
}

test("managesScope: private-channel + group-DM members manage; public-channel + non-members do not", async () => {
  const app = makeApp();
  assert.equal(await app.managesScope(OWNER, privScope), true, "creator (a member) manages a private channel");
  assert.equal(await app.managesScope(PRIV_MEMBER, privScope), true, "a private-channel member manages");
  assert.equal(await app.managesScope(OUTSIDER, privScope), false, "a non-member does not");
  assert.equal(await app.managesScope(GROUP_MEMBER, groupScope), true, "a group-DM member manages");
  assert.equal(await app.managesScope(OUTSIDER, groupScope), false, "a non-member does not");
  assert.equal(await app.managesScope(PUB_MEMBER, pubScope), false, "a PUBLIC-channel member does NOT manage");
  assert.equal(
    await app.managesScope(OWNER, pubScope),
    false,
    "even a member is not a scope-manager of a public channel",
  );
  assert.equal(await app.managesScope(OWNER, scopeId("personal", OWNER)), true);
  assert.equal(await app.managesScope(OUTSIDER, scopeId("personal", OWNER)), false);
});

test("skills: a private-channel member may edit + delete a shared skill; provenance is preserved", async () => {
  const deps = makeDeps();
  const planted = await deps.skills.create({
    scopeId: privScope,
    manifest: { name: "triage", description: "d", requiredCapabilities: [], body: "# b" },
    createdBy: OWNER,
  });
  await deps.skills.review(planted.id, "system:test", []);
  await deps.skills.publish(planted.id);
  const app = createApp(deps as unknown as AppDeps);
  const edited = await app.updateOwnedSkill(planted.id, PRIV_MEMBER, { description: "d2" }, { liveActor: true });
  assert.ok(edited && edited !== "trigger_blocked", "a private-channel member edits the scope's skill");
  assert.equal((edited as { createdBy: string }).createdBy, OWNER, "createdBy is never rewritten on a member edit");
  assert.equal(await app.deleteOwnedSkill({ principalId: PRIV_MEMBER, id: planted.id, liveActor: true }), "deleted");
});

test("skills: a member editing a normal shared skill auto-republishes it (stays live)", async () => {
  const deps = makeDeps();
  const planted = await deps.skills.create({
    scopeId: privScope,
    manifest: { name: "live", description: "d", requiredCapabilities: [], body: "# b" },
    createdBy: OWNER,
  });
  await deps.skills.review(planted.id, "system:test", []);
  await deps.skills.publish(planted.id);
  const app = createApp(deps as unknown as AppDeps);
  const edited = await app.updateOwnedSkill(planted.id, PRIV_MEMBER, { description: "d2" }, { liveActor: true });
  assert.ok(edited && edited !== "trigger_blocked", "a private-channel member edits the scope's skill");
  assert.equal(
    (edited as { status: string }).status,
    "published",
    "a normal shared-skill edit re-reviews+publishes so it stays live",
  );
  assert.equal(
    (await deps.skills.resolve("live", [privScope])).skill?.id,
    planted.id,
    "still resolvable after the edit",
  );
});

test("skills: a member CANNOT resurrect an admin-archived shared skill via an inline edit", async () => {
  const deps = makeDeps();
  const planted = await deps.skills.create({
    scopeId: privScope,
    manifest: { name: "killed", description: "d", requiredCapabilities: [], body: "# b" },
    createdBy: OWNER,
  });
  await deps.skills.review(planted.id, "system:test", []);
  await deps.skills.publish(planted.id);
  await deps.skills.archive(planted.id);
  const app = createApp(deps as unknown as AppDeps);
  assert.equal(
    await app.updateOwnedSkill(planted.id, PRIV_MEMBER, { description: "resurrect" }, { liveActor: true }),
    null,
    "an archived skill is not a member's to edit",
  );
  const after = await deps.skills.get(planted.id);
  assert.equal(after!.status, "archived", "the admin removal is NOT undone — the skill stays archived");
  assert.equal(after!.manifest.description, "d", "the archived skill's manifest is left untouched");
  assert.equal((await deps.skills.resolve("killed", [privScope])).skill, null, "still does not resolve/materialize");
});

test("skills: a PUBLIC-channel member may NOT edit or delete a shared skill", async () => {
  const deps = makeDeps();
  const planted = await deps.skills.create({
    scopeId: pubScope,
    manifest: { name: "pub", description: "d", requiredCapabilities: [], body: "# b" },
    createdBy: OWNER,
  });
  const app = createApp(deps as unknown as AppDeps);
  assert.equal(
    await app.updateOwnedSkill(planted.id, PUB_MEMBER, { description: "no" }),
    null,
    "public-channel member cannot edit",
  );
  assert.equal(
    await app.deleteOwnedSkill({ principalId: PUB_MEMBER, id: planted.id }),
    "forbidden",
    "public-channel member cannot delete",
  );
});

test("skills: a non-member may not edit or delete a shared scope's skill", async () => {
  const deps = makeDeps();
  const planted = await deps.skills.create({
    scopeId: privScope,
    manifest: { name: "owned", description: "d", requiredCapabilities: [], body: "# b" },
    createdBy: OWNER,
  });
  const app = createApp(deps as unknown as AppDeps);
  assert.equal(await app.updateOwnedSkill(planted.id, OUTSIDER, { description: "no" }), null, "outsider cannot edit");
  assert.equal(
    await app.deleteOwnedSkill({ principalId: OUTSIDER, id: planted.id }),
    "forbidden",
    "outsider cannot delete",
  );
});

test("SOUL: a private-channel or group member may edit; a public-channel member and a non-member may not", async () => {
  const app = makeApp();
  assert.equal(await app.managesScope(PRIV_MEMBER, privScope), true, "private member may set the floor");
  assert.equal(await app.managesScope(GROUP_MEMBER, groupScope), true, "group member may set the floor");
  assert.equal(await app.managesScope(PUB_MEMBER, pubScope), false, "public member may NOT set the floor");
  assert.equal(await app.managesScope(OUTSIDER, privScope), false, "a non-member may NOT");
  assert.ok((await app.updateInstructions(privScope, "be terse", PRIV_MEMBER, { allowSharedScope: true })) > 0);
  assert.ok((await app.updateInstructions(groupScope, "be kind", GROUP_MEMBER, { allowSharedScope: true })) > 0);
  await assert.rejects(() => app.updateInstructions(privScope, "x", PRIV_MEMBER), /not authorized/);
});

test("SOUL: shared-lock writers refresh fleet state before assigning the next version", async () => {
  const databaseUrl = testDatabaseUrl();
  const lock = testAdvisoryLock();
  const leftConfig = testConfigStore(ORG, { databaseUrl });
  const rightConfig = testConfigStore(ORG, { databaseUrl });
  const left = createApp(makeDeps({ config: leftConfig, advisoryLock: lock }) as unknown as AppDeps);
  const right = createApp(makeDeps({ config: rightConfig, advisoryLock: lock }) as unknown as AppDeps);

  assert.equal(await left.updateInstructions(privScope, "left", PRIV_MEMBER, { allowSharedScope: true }), 1);
  assert.equal(rightConfig.instructionsVersion(privScope), 0, "the second core starts with a stale cache");
  assert.equal(await right.updateInstructions(privScope, "right", PRIV_MEMBER, { allowSharedScope: true }), 2);
  assert.deepEqual(
    await createPgPool(databaseUrl).q("SELECT version, content FROM soul_configs WHERE scope_id = $1", [privScope]),
    [{ version: "2", content: "right" }],
  );
});

test("SOUL: a durable write failure rejects and restores the live cache", async () => {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore(ORG, { databaseUrl });
  const app = createApp(makeDeps({ config }) as unknown as AppDeps);
  assert.equal(await app.updateInstructions(privScope, "durable", PRIV_MEMBER, { allowSharedScope: true }), 1);
  await failTableWrites(databaseUrl, "soul_configs");
  await assert.rejects(
    () => app.updateInstructions(privScope, "cache only", PRIV_MEMBER, { allowSharedScope: true }),
    /forced durable write failure/,
  );
  assert.equal(config.getInstructions(privScope), "durable");
  assert.equal(config.instructionsVersion(privScope), 1);
});

test("SOUL: the HTTP route reports durable storage failures as 500", async () => {
  const databaseUrl = testDatabaseUrl();
  await failTableWrites(databaseUrl, "soul_configs");
  const config = testConfigStore(ORG, { databaseUrl });
  const app = createApp(makeDeps({ config }) as unknown as AppDeps);
  const out: { status?: number; body?: { error?: string } } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  await respond(postInstructions, {
    res,
    app,
    body: { content: "cannot persist" },
    capability: { actorId: PRIV_MEMBER, scopeId: privScope },
  } as unknown as ApiCtx);
  assert.equal(out.status, 500);
  assert.equal(out.body?.error, "instructions_update_failed");
});

test("SOUL: the HTTP route reports a write to someone else's personal SOUL as a 403 denial", async () => {
  const app = createApp(makeDeps() as unknown as AppDeps);
  const out: { status?: number; body?: { error?: string } } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end(data?: string) {
      out.body = data ? JSON.parse(data) : undefined;
    },
  };
  await respond(postInstructions, {
    res,
    app,
    body: { scopeId: scopeId("personal", OWNER), content: "not yours", actorId: OUTSIDER },
  } as unknown as ApiCtx);
  assert.equal(out.status, 403);
  assert.equal(out.body?.error, "instructions_update_denied");
});

test("SOUL: failed persistence keeps the pre-write cache", async () => {
  const databaseUrl = testDatabaseUrl();
  const prior: PersistedInstructions = {
    scopeId: privScope,
    content: "durable prior",
    version: 7,
    updatedAt: 70,
    updatedBy: OWNER,
    history: [{ scopeId: privScope, content: "durable prior", version: 7, updatedAt: 70, updatedBy: OWNER }],
  };
  const config = testConfigStore(ORG, { databaseUrl });
  await config.restoreInstructionsSnapshot(privScope, prior);
  await failTableWrites(databaseUrl, "soul_configs");
  const app = createApp(makeDeps({ config }) as unknown as AppDeps);
  const out: { status?: number } = {};
  const res = {
    getHeader() {},
    writeHead(status: number) {
      out.status = status;
    },
    end() {},
  };

  await respond(postInstructions, {
    res,
    app,
    body: { content: "rejected cache value" },
    capability: { actorId: PRIV_MEMBER, scopeId: privScope },
  } as unknown as ApiCtx);

  assert.equal(out.status, 500);
  assert.equal(config.getInstructions(privScope), prior.content);
  assert.equal(config.instructionsVersion(privScope), prior.version);
  assert.deepEqual(config.instructionsHistory(privScope), prior.history);
});

test("crons: owner and a private-channel member manage; a public-channel member and a non-member do not", async () => {
  const deps = makeDeps();
  const cron = await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "summarize",
    owner: OWNER,
    createdBy: OWNER,
    ownerScopeId: privScope,
  });
  const app = createApp(deps as unknown as AppDeps);
  assert.equal(await app.managesScope(OWNER, cron.ownerScopeId), true, "the creator (a member) manages");
  assert.equal(await app.managesScope(PRIV_MEMBER, cron.ownerScopeId), true, "a private-channel member manages");
  assert.equal(await app.managesScope(OUTSIDER, cron.ownerScopeId), false, "a non-member does not");

  const pubCron = await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "pub",
    owner: OWNER,
    createdBy: OWNER,
    ownerScopeId: pubScope,
  });
  assert.equal(
    await app.managesScope(PUB_MEMBER, pubCron.ownerScopeId),
    false,
    "a PUBLIC-channel member does NOT manage the scope's cron",
  );

  const myCron = await deps.crons.create({
    schedule: { everyMs: 60_000 },
    action: "mine",
    owner: OWNER,
    createdBy: OWNER,
    ownerScopeId: scopeId("personal", OWNER),
  });
  assert.equal(await app.managesScope(OWNER, myCron.ownerScopeId), true);
  assert.equal(
    await app.managesScope(PRIV_MEMBER, myCron.ownerScopeId),
    false,
    "a teammate cannot manage my personal cron",
  );
});
