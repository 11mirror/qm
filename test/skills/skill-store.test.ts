import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { encodeRef, skillRef, parseRef } from "../../src/acl/resource-ref.ts";
import type { Config } from "../../src/config.ts";
import { filterConnectorSkills } from "../../src/core/orchestrator/turn-helpers.ts";
import { principalEntitledToScope } from "../../src/resolution/context-filter.ts";
import {
  createSkillStore,
  type SkillManifest,
  type SkillStore,
  type SkillResolution,
} from "../../src/skills/skill-store.ts";
import { scopeId, type ScopeId, type Principal } from "../../src/types.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";

function freshApp() {
  const config: Config = testConfig({ orgId: "acme", seedSkills: false });
  return buildApp(config);
}

async function publish(
  skills: ReturnType<typeof buildApp>["skills"],
  scope: ScopeId,
  name: string,
  description: string,
) {
  const sk = await skills.create({
    scopeId: scope,
    manifest: { name, description, requiredCapabilities: [], body: `# ${name}\n${description}` },
    createdBy: "author",
  });
  await skills.review(sk.id, "reviewer-1", []);
  return skills.publish(sk.id);
}

test("listVisibleSkills returns a principal's personal + org skills with scope labels", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
  await publish(skills, scopeId("org", "default-org"), "deploy-bot", "ship the bot to prod");

  const visible = await app.listVisibleSkills("U1");
  const byName = new Map(visible.map((r) => [r.skill!.manifest.name, r]));
  assert.equal(byName.get("make-digest")!.skill!.scopeId, scopeId("personal", "U1"));
  assert.equal(byName.get("deploy-bot")!.skill!.scopeId, scopeId("org", "default-org"));
});

test("a personal skill shadows a same-named org skill (most-specific wins, shadow surfaced)", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("org", "default-org"), "notes", "the org-wide notes skill");
  await publish(skills, scopeId("personal", "U1"), "notes", "U1's own notes skill");

  const visible = await app.listVisibleSkills("U1");
  const notes = visible.filter((r) => r.skill!.manifest.name === "notes");
  assert.equal(notes.length, 1, "one winner per name");
  assert.equal(notes[0]!.skill!.scopeId, scopeId("personal", "U1"), "personal wins over org");
  assert.equal(notes[0]!.shadowed.length, 1, "the org skill it shadows is surfaced");
  assert.equal(notes[0]!.shadowed[0]!.scopeId, scopeId("org", "default-org"));
});

test("another principal does not see U1's personal skill (scope boundary)", async () => {
  const { app, skills } = freshApp();
  await publish(skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");

  const visible = await app.listVisibleSkills("U2");
  assert.ok(!visible.some((r) => r.skill!.manifest.name === "make-digest"));
});

test("an unpublished (draft/reviewed) skill is not visible", async () => {
  const { app, skills } = freshApp();
  const draft = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "wip", description: "not ready", requiredCapabilities: [], body: "# wip" },
    createdBy: "U1",
  });
  await skills.review(draft.id, "reviewer-1", []);

  const visible = await app.listVisibleSkills("U1");
  assert.ok(!visible.some((r) => r.skill!.manifest.name === "wip"));
});

test("visibleFor resolves many skills across scopes with personal shadowing", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });

  const org = scopeId("org", "visible-org");
  const personal = scopeId("personal", "U1");
  for (let i = 0; i < 200; i++) {
    const scope = i % 2 === 0 ? org : personal;
    const sk = await skills.create({
      scopeId: scope,
      manifest: { name: `skill-${i}`, description: `skill ${i}`, requiredCapabilities: [], body: `# skill-${i}` },
      createdBy: "author",
    });
    await skills.review(sk.id, "reviewer-1", []);
    await skills.publish(sk.id);
  }
  const shadowing = await skills.create({
    scopeId: personal,
    manifest: { name: "skill-0", description: "personal override", requiredCapabilities: [], body: "# skill-0" },
    createdBy: "U1",
  });
  await skills.review(shadowing.id, "reviewer-1", []);
  await skills.publish(shadowing.id);

  const visible = await skills.visibleFor([personal, org]);
  assert.equal(visible.length, 200);
  const shadowed = visible.find((r) => r.skill!.manifest.name === "skill-0")!;
  assert.equal(shadowed.skill!.scopeId, personal);
  assert.equal(shadowed.shadowed.length, 1);
  assert.equal(shadowed.shadowed[0]!.scopeId, org);
});

const org = scopeId("org", "archive-org");
const manifest = { name: "demo", description: "d", requiredCapabilities: [], body: "# Demo" };

async function published() {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const s = await skills.create({ scopeId: org, manifest, createdBy: "pack:src1" });
  await skills.review(s.id, "system:pack-reviewer", []);
  await skills.publish(s.id);
  return { skills, id: s.id };
}

test("archive stops a skill resolving but keeps the record", async () => {
  const { skills, id } = await published();
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
  assert.equal((await skills.visibleFor([org])).length, 1);

  const archived = await skills.archive(id);
  assert.equal(archived.status, "archived");
  assert.equal((await skills.resolve("demo", [org])).skill, null);
  assert.equal((await skills.visibleFor([org])).length, 0);
  assert.equal((await skills.get(id))!.status, "archived");
});

test("archive is idempotent", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  const again = await skills.archive(id);
  assert.equal(again.status, "archived");
});

test("an archived skill can be re-published (resurrection on re-import)", async () => {
  const { skills, id } = await published();
  await skills.archive(id);
  await skills.publish(id);
  assert.equal((await skills.resolve("demo", [org])).skill?.id, id);
});

test("create carries pack provenance", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const s = await skills.create({
    scopeId: org,
    manifest,
    createdBy: "pack:src1",
    pack: { packId: "src1", commit: "abc123", upstreamName: "demo" },
  });
  assert.deepEqual(s.pack, { packId: "src1", commit: "abc123", upstreamName: "demo" });
});

test("recordUse sets lastUsedAt without touching version/updatedAt", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const s = await skills.create({ scopeId: org, manifest, createdBy: "alice" });
  assert.equal(s.lastUsedAt, undefined);
  await skills.recordUse(s.id, 12345);
  const after = (await skills.get(s.id))!;
  assert.equal(after.lastUsedAt, 12345);
  assert.equal(after.version, s.version);
  assert.equal(after.updatedAt, s.updatedAt);
});

test("recordUse on an unknown id is a no-op", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  await skills.recordUse("nope");
  assert.equal(await skills.get("nope"), null);
});

const ORG = scopeId("org", "autoload-org");
const JOSH = scopeId("personal", "josh");
const ERIC = scopeId("personal", "eric");
const P = (id: string, teamIds: string[] = []): Principal => ({ id, type: "internal", teamIds });

const skillGrantAutoloadManifest = (name: string): SkillManifest => ({
  name,
  description: "d",
  requiredCapabilities: [],
  body: `# ${name}`,
});

async function publishedSkill(store: SkillStore, scope: ScopeId, name: string) {
  const s = await store.create({ scopeId: scope, manifest: skillGrantAutoloadManifest(name), createdBy: "josh" });
  await store.review(s.id, "reviewer", []);
  return store.publish(s.id);
}

test("person-to-person skill grant reaches the grantee's audience", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await acl.grant({
    ownerScopeId: JOSH,
    ref: encodeRef(skillRef("s1")),
    granteeScopeId: ERIC,
    permission: "read",
    grantedBy: "josh",
  });

  const inEricsDm = await acl.sharedOfKindForAudience("skill", [P("eric")], ERIC, ORG, principalEntitledToScope);
  assert.deepEqual(
    inEricsDm.map((g) => parseRef(g.ref).id),
    ["s1"],
  );

  const together = await acl.sharedOfKindForAudience(
    "skill",
    [P("eric"), P("josh")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.equal(together.length, 1);

  const mixed = await acl.sharedOfKindForAudience(
    "skill",
    [P("eric"), P("mallory")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(mixed, []);

  const other = await acl.sharedOfKindForAudience(
    "skill",
    [P("alice")],
    scopeId("personal", "alice"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(other, []);
});

test("visibleFor includes granted skills, shadowed by scope-owned skills of the same name", async () => {
  const store = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const granted = await publishedSkill(store, JOSH, "quickbooks");
  const own = await publishedSkill(store, ERIC, "quickbooks");
  const unique = await publishedSkill(store, JOSH, "reconcile");

  const before = await store.visibleFor([ERIC, ORG]);
  assert.deepEqual(
    before.map((r) => r.skill!.id),
    [own.id],
  );

  const ref = (s: { id: string; scopeId: ReturnType<typeof scopeId> }) => ({ id: s.id, ownerScopeId: s.scopeId });

  const withGrant = await store.visibleFor([ERIC, ORG], [ref(unique)]);
  assert.deepEqual(new Set(withGrant.map((r) => r.skill!.id)), new Set([own.id, unique.id]));

  const collided = await store.visibleFor([ERIC, ORG], [ref(granted), ref(unique)]);
  const quickbooks = collided.filter((r) => r.skill!.manifest.name === "quickbooks");
  assert.equal(quickbooks.length, 1);
  assert.equal(quickbooks[0]!.skill!.id, own.id);
  assert.deepEqual(
    quickbooks[0]!.shadowed.map((s) => s.id),
    [granted.id],
  );

  const draft = await store.create({
    scopeId: JOSH,
    manifest: skillGrantAutoloadManifest("draft-skill"),
    createdBy: "josh",
  });
  const ignored = await store.visibleFor([ERIC, ORG], [ref(draft), { id: "no-such-id", ownerScopeId: JOSH }]);
  assert.deepEqual(
    ignored.map((r) => r.skill!.id),
    [own.id],
  );
});

test("a grant redundant with scope visibility does not self-shadow", async () => {
  const store = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const own = await publishedSkill(store, ERIC, "quickbooks");

  const rows = await store.visibleFor([ERIC, ORG], [{ id: own.id, ownerScopeId: ERIC }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.skill!.id, own.id);
  assert.deepEqual(rows[0]!.shadowed, []);
});

test("visibleFor resolves the asked scopes and the granted skill's owner in one call", async () => {
  const store = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const orgAlpha = await publishedSkill(store, ORG, "alpha-skill");
  for (const name of ["beta-skill", "gamma-skill"]) await publishedSkill(store, ORG, name);
  const own = await publishedSkill(store, ERIC, "alpha-skill");
  const granted = await publishedSkill(store, JOSH, "delta-skill");

  const rows = await store.visibleFor([ERIC, ORG], [{ id: granted.id, ownerScopeId: JOSH }]);

  const byName = new Map(rows.map((r) => [r.skill!.manifest.name, r]));
  assert.deepEqual([...byName.keys()].sort(), ["alpha-skill", "beta-skill", "delta-skill", "gamma-skill"]);
  assert.equal(byName.get("alpha-skill")!.skill!.id, own.id);
  assert.deepEqual(
    byName.get("alpha-skill")!.shadowed.map((s) => s.id),
    [orgAlpha.id],
  );
  assert.equal(byName.get("delta-skill")!.skill!.id, granted.id);
});

test("a grant whose claimed owner scope does not match the skill's home is ignored", async () => {
  const store = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const victim = await publishedSkill(store, JOSH, "victim-skill");

  const forged = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: ERIC }]);
  assert.deepEqual(forged, []);

  const legit = await store.visibleFor([ERIC, ORG], [{ id: victim.id, ownerScopeId: JOSH }]);
  assert.deepEqual(
    legit.map((r) => r.skill!.id),
    [victim.id],
  );
});

function skill(name: string, connector?: string): SkillResolution {
  return {
    skill: {
      id: name,
      scopeId: scopeId("org", "acme"),
      manifest: {
        name,
        description: name,
        requiredCapabilities: connector ? [`connector:${connector}`] : [],
        body: name,
      },
      status: "published",
      createdBy: "test",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
      createdAt: 1,
      updatedAt: 1,
    },
    shadowed: [],
  };
}

test("provider skills are visible only for connectors configured by the admin", () => {
  const all = [
    skill("memory"),
    skill("google-workspace", "google"),
    skill("dropbox", "dropbox"),
    skill("linear", "linear"),
    skill("x", "x"),
    skill("slack-drafts", "slack"),
    skill("zoom", "zoom"),
  ];
  assert.deepEqual(
    filterConnectorSkills(all, []).map((entry) => entry.skill?.manifest.name),
    ["memory"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["google", "linear"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "google-workspace", "linear"],
  );
  assert.deepEqual(
    filterConnectorSkills(all, ["slack"]).map((entry) => entry.skill?.manifest.name),
    ["memory", "slack-drafts"],
  );
});

test("the credential-backed Composio skill needs no dedicated OAuth configuration", () => {
  assert.deepEqual(
    filterConnectorSkills([skill("composio"), skill("google-workspace", "google")], []).map(
      (entry) => entry.skill?.manifest.name,
    ),
    ["composio"],
  );
});

test("skill mutations reject names that could escape or collide when materialized", async () => {
  const databaseUrl = testDatabaseUrl();
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl });
  const manifest = (name: string) => ({ name, description: "d", requiredCapabilities: [], body: "b" });
  for (const name of ["..", "foo/bar", "foo\\bar", "foo bar", ".hidden", "foo."]) {
    await assert.rejects(
      () => skills.create({ scopeId: scopeId("personal", "U1"), manifest: manifest(name), createdBy: "U1" }),
      /skill name must/,
    );
  }

  const legacy = await skills.create({
    scopeId: scopeId("personal", "U1"),
    manifest: manifest("safe-name"),
    createdBy: "U1",
  });
  await createPgPool(databaseUrl).q(`UPDATE skills SET manifest = $2, status = 'reviewed' WHERE id = $1`, [
    legacy.id,
    manifest("foo/bar"),
  ]);
  await assert.rejects(() => skills.publish(legacy.id), /skill name must/);
  assert.equal(
    (await skills.visibleFor([scopeId("personal", "U1")])).length,
    0,
    "legacy unsafe records never reach materialization",
  );
});
