import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createPostgresAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { materializeSkillTree } from "../../src/skills/materialize.ts";
import { installSeedSkills, parseSeedSkill, upsertSeedSkill } from "../../src/skills/seed.ts";
import { createSkillStore, safeSkillFilePath, type SkillStore } from "../../src/skills/skill-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { buildApp } from "../support/build-app.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";
import { testConfig } from "../support/test-config.ts";

test("seed skill parser reads the repo frontmatter subset", () => {
  const manifest = parseSeedSkill(`---
name: demo
description: demo skill
requiredCapabilities:
  - egress:example.com
  - command:demo
---

# Demo

Run the thing.
`);
  assert.equal(manifest.name, "demo");
  assert.equal(manifest.description, "demo skill");
  assert.deepEqual(manifest.requiredCapabilities, ["egress:example.com", "command:demo"]);
  assert.match(manifest.body, /^# Demo/);
});

test("installSeedSkills publishes the repository starter catalog into org scope", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "seed-org");
  const result = await installSeedSkills(skills, { dir: "skills-seed", scopeId: org });
  assert.deepEqual(result.skipped, []);
  assert.ok(result.installed.includes("cloud-cli"));
  assert.ok(result.installed.includes("composio"));
  assert.ok(result.installed.includes("google-workspace"));
  assert.ok(result.installed.includes("google-drive-sheets"));
  assert.ok(result.installed.includes("github-gitlab"));
  assert.ok(result.installed.includes("send"));
  const github = (await skills.listInScopes([org])).find((s) => s.manifest.name === "github-gitlab")!;
  assert.equal(
    github.manifest.files?.find((file) => file.path === "scripts/watch-ci.mjs")?.content,
    readFileSync("skills-seed/github-gitlab/scripts/watch-ci.mjs", "utf8"),
  );
  assert.ok(result.installed.includes("taste-skill"));
  assert.ok(result.installed.includes("use-shared-credential"));

  const published = (await skills.listInScopes([org])).filter((s) => s.status === "published");
  assert.equal(published.length, result.installed.length);
  const rerun = await installSeedSkills(skills, { dir: "skills-seed", scopeId: org });
  assert.deepEqual(rerun.skipped.sort(), result.installed.sort());
  assert.deepEqual(rerun.updated, []);
});

test("every licence shipped with a seed skill is MIT, and no tracked source carries Apache licence text", () => {
  const seedDir = "skills-seed";
  const licences: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      if (statSync(child).isDirectory()) walk(child);
      else if (/^(licen[cs]e|notice)\b/i.test(name)) licences.push(child);
    }
  };
  walk(seedDir);

  for (const path of licences) {
    const text = readFileSync(path, "utf8");
    assert.match(text, /MIT License/, `${path} must be MIT — a seed skill may only vendor MIT-compatible material`);
  }

  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const offenders = tracked.filter((path) => {
    if (path.endsWith("package-lock.json") || path === "test/skills/seed.test.ts") return false;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    return text.includes(["Apache", " License"].join(""));
  });
  assert.deepEqual(offenders, [], "Apache-licensed material must not be vendored into this MIT repository");
});

function writeSeedSkill(dir: string, name: string, description: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

function writeSeedAsset(dir: string, name: string, relPath: string, content: string): void {
  const abs = join(dir, name, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

test("installSeedSkills re-seeds a changed manifest over its own prior install, never over another author's", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "default-org");
  const dir = mkdtempSync(join(tmpdir(), "seed-update-"));
  writeSeedSkill(dir, "demo", "old description", "# Demo v1");

  await installSeedSkills(skills, { dir, scopeId: org });
  writeSeedSkill(dir, "demo", "new description", "# Demo v2");
  const result = await installSeedSkills(skills, { dir, scopeId: org });
  assert.deepEqual(result, { installed: [], updated: ["demo"], skipped: [] });

  const skill = (await skills.list()).find((s) => s.manifest.name === "demo")!;
  assert.equal(skill.status, "published");
  assert.equal(skill.version, 2);
  assert.equal(skill.manifest.description, "new description");

  const stranded = await skills.create({
    scopeId: org,
    manifest: { name: "stuck", description: "stranded", requiredCapabilities: [], body: "# Stuck" },
    createdBy: "system:skills-seed",
  });
  const strandedDir = mkdtempSync(join(tmpdir(), "seed-stranded-"));
  writeSeedSkill(strandedDir, "stuck", "stranded", "# Stuck");
  const repaired = await installSeedSkills(skills, { dir: strandedDir, scopeId: org });
  assert.deepEqual(repaired, { installed: [], updated: ["stuck"], skipped: [] });
  assert.equal((await skills.get(stranded.id))!.status, "published");

  const userDir = mkdtempSync(join(tmpdir(), "seed-user-"));
  writeSeedSkill(userDir, "mine", "user authored", "# Mine");
  const mine = await skills.create({
    scopeId: org,
    manifest: { name: "mine", description: "user authored", requiredCapabilities: [], body: "# Mine" },
    createdBy: "user:carol",
  });
  await skills.review(mine.id, "reviewer:r1", []);
  await skills.publish(mine.id);
  writeSeedSkill(userDir, "mine", "catalog tries to take over", "# Catalog");
  const guarded = await installSeedSkills(skills, { dir: userDir, scopeId: org });
  assert.deepEqual(guarded, { installed: [], updated: [], skipped: ["mine"] });
  assert.equal((await skills.get(mine.id))!.manifest.description, "user authored");
});

test("installSeedSkills leaves an admin-archived catalog skill archived when asked to", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "default-org");
  const dir = mkdtempSync(join(tmpdir(), "seed-archived-"));
  writeSeedSkill(dir, "retired", "old catalog skill", "# Retired v1");
  await installSeedSkills(skills, { dir, scopeId: org, respectArchived: true });
  const installed = (await skills.list()).find((s) => s.manifest.name === "retired")!;
  await skills.archive(installed.id);

  const again = await installSeedSkills(skills, { dir, scopeId: org, respectArchived: true });
  assert.deepEqual(again, { installed: [], updated: [], skipped: ["retired"] });
  writeSeedSkill(dir, "retired", "catalog changed upstream", "# Retired v2");
  const changed = await installSeedSkills(skills, { dir, scopeId: org, respectArchived: true });
  assert.deepEqual(changed, { installed: [], updated: [], skipped: ["retired"] });
  const kept = (await skills.list()).filter((s) => s.manifest.name === "retired");
  assert.equal(kept.length, 1, "no replacement record is created beside the archived one");
  assert.equal(kept[0]!.status, "archived");

  const republished = await installSeedSkills(skills, { dir, scopeId: org });
  assert.deepEqual(republished, { installed: [], updated: ["retired"], skipped: [] });
  assert.equal((await skills.get(installed.id))!.status, "published");
});

test("concurrent upserts of the same scope+name serialize into one record (no duplicate creates)", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "default-org");
  const upsert = (body: string) =>
    upsertSeedSkill(skills, {
      scopeId: org,
      manifest: { name: "racy", description: "raced", requiredCapabilities: [], body },
      createdBy: "system:skills-seed",
      reviewer: "system:skills-reviewer",
    });
  const outcomes = await Promise.all([upsert("# A"), upsert("# B"), upsert("# C")]);
  assert.equal(outcomes.filter((o) => o === "installed").length, 1);
  const records = (await skills.list()).filter((s) => s.scopeId === org && s.manifest.name === "racy");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.status, "published");
});

test("a fresh app advertises and materializes only admin-enabled connector skills", async () => {
  const config = testConfig({});
  const built = buildApp(config);
  await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
  await built.config.setConnectorClient(scopeId("org", "default-org"), "google", {
    clientId: "google-client",
    clientSecret: "google-secret",
  });
  const { app } = built;
  const actor = { externalId: "U1" };
  const sys = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-skills" },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(sys.reply ?? "", /google-workspace/);
  assert.match(sys.reply ?? "", /google-drive-sheets/);
  assert.match(sys.reply ?? "", /github-gitlab/);
  assert.doesNotMatch(sys.reply ?? "", /\*\*dropbox\*\*|\*\*linear\*\*|\*\*zoom\*\*/);

  const channelSys = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "channel", channelRef: "C1", threadRef: "channel:C1:seeded-skills", audience: [actor] },
    text: "!sysprompt",
  } as TurnRequest);
  assert.match(channelSys.reply ?? "", /google-workspace/);
  assert.match(channelSys.reply ?? "", /google-drive-sheets/);
  assert.doesNotMatch(channelSys.reply ?? "", /\*\*dropbox\*\*|\*\*linear\*\*|\*\*zoom\*\*/);

  const read = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-skills-read" },
    text: "!skill google-workspace",
  } as TurnRequest);
  assert.match(read.reply ?? "", /Google Workspace/);
  assert.match(read.reply ?? "", /\/v1\/credentials\/http\/www\.googleapis\.com/);
  assert.match(read.reply ?? "", /x-agent-capability: \$AGENT_CREDENTIAL_TOKEN/);

  const drive = await app.turn({
    origin: { kind: "direct" },
    surface: "test",
    actor,
    conversation: { kind: "dm", threadRef: "dm:U1:seeded-drive-read" },
    text: "!skill google-drive-sheets",
  } as TurnRequest);
  assert.match(drive.reply ?? "", /Google Drive \/ Docs \/ Sheets \/ Slides/);
  assert.match(drive.reply ?? "", /sheets\.googleapis\.com/);
});

function fakeSandbox() {
  const files = new Map<string, string>();
  const sandbox = {
    async readFile(_h: SandboxHandle, rel: string) {
      return files.has(rel) ? files.get(rel)! : null;
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, data);
    },
    async removeDir(_h: SandboxHandle, rel: string) {
      for (const k of files.keys()) if (k === rel || k.startsWith(`${rel}/`)) files.delete(k);
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

test("a bundled skill round-trips seed → store → materialize, assets land beside SKILL.md", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "default-org");
  const dir = mkdtempSync(join(tmpdir(), "seed-tree-"));
  writeSeedSkill(dir, "tooled", "a skill with helpers", "# Tooled\n\nRun scripts/hello.py.");
  writeSeedAsset(dir, "tooled", "scripts/hello.py", "print('hi')\n");
  writeSeedAsset(dir, "tooled", "references/notes.md", "# notes\n");
  writeSeedSkill(dir, "plain", "no helpers", "# Plain");

  const result = await installSeedSkills(skills, { dir, scopeId: org });
  assert.deepEqual(result.installed.sort(), ["plain", "tooled"]);

  const tooled = (await skills.list()).find((s) => s.manifest.name === "tooled")!;
  assert.deepEqual((tooled.manifest.files ?? []).map((f) => f.path).sort(), [
    "references/notes.md",
    "scripts/hello.py",
  ]);
  assert.equal((await skills.list()).find((s) => s.manifest.name === "plain")!.manifest.files?.length, 0);

  const { sandbox, files } = fakeSandbox();
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };
  const resolved = await skills.resolve("tooled", [org]);
  await materializeSkillTree(sandbox, handle, "skills", resolved);
  assert.equal(files.get("skills/tooled/SKILL.md"), tooled.manifest.body);
  assert.equal(files.get("skills/tooled/scripts/hello.py"), "print('hi')\n");
  assert.equal(files.get("skills/tooled/references/notes.md"), "# notes\n");
});

test("safeSkillFilePath rejects traversal / absolute / dot segments", () => {
  assert.equal(safeSkillFilePath("scripts/foo.py"), "scripts/foo.py");
  assert.equal(safeSkillFilePath("./refs/x.md"), "refs/x.md");
  for (const bad of ["../escape", "scripts/../../etc/passwd", "/abs/path", "a/./b", "a/../b", ""]) {
    assert.throws(() => safeSkillFilePath(bad), /invalid skill file path/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("installSeedSkills re-seeds when only a bundled asset changes", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const org = scopeId("org", "default-org");
  const dir = mkdtempSync(join(tmpdir(), "seed-asset-change-"));
  writeSeedSkill(dir, "tooled", "helpers", "# Tooled");
  writeSeedAsset(dir, "tooled", "scripts/hello.py", "v1\n");
  await installSeedSkills(skills, { dir, scopeId: org });

  writeSeedAsset(dir, "tooled", "scripts/hello.py", "v2\n");
  const rerun = await installSeedSkills(skills, { dir, scopeId: org });
  assert.deepEqual(rerun, { installed: [], updated: ["tooled"], skipped: [] });
  const tooled = (await skills.list()).find((s) => s.manifest.name === "tooled")!;
  assert.equal(tooled.manifest.files?.find((f) => f.path === "scripts/hello.py")?.content, "v2\n");
});

const SEED_DIR = join(process.cwd(), "skills-seed");

function seedSkillFiles(): string[] {
  if (!existsSync(SEED_DIR)) return [];
  return readdirSync(SEED_DIR)
    .map((entry) => join(SEED_DIR, entry, "SKILL.md"))
    .filter((p) => existsSync(p) && statSync(p).isFile());
}

test("every seed SKILL.md parses with a name, description, and body", () => {
  const files = seedSkillFiles();
  assert.ok(files.length > 0, `expected at least one seed SKILL.md under ${SEED_DIR}`);
  for (const path of files) {
    const m = parseSeedSkill(readFileSync(path, "utf8"));
    assert.ok(m.name && m.description && m.body.trim(), `${path} is missing a required field`);
  }
});

test("admin and cloud skills distinguish system administration from resource ownership", () => {
  for (const name of ["admin", "cloud-cli"]) {
    const { body } = parseSeedSkill(readFileSync(join(SEED_DIR, name, "SKILL.md"), "utf8"));
    assert.match(body, /including resources owned by other users/);
    assert.match(body, /credential grants, provider permissions, explicit restrictions, and mutation approvals/);
    assert.match(body, /not impersonation or circumvention/);
  }
});

const hello = async (store: SkillStore) => (await store.list()).filter((s) => s.manifest.name === "hello");

const sharedLock = (databaseUrl: string) => createPostgresAdvisoryLock(createPgPool(databaseUrl));

const slowReads = (store: SkillStore): SkillStore => ({
  ...store,
  async listInScopes(scopeIds) {
    const rows = await store.listInScopes(scopeIds);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return rows;
  },
});

test("two servers seeding the same catalog at boot install each skill once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-xsrv-"));
  mkdirSync(join(dir, "hello"));
  writeFileSync(join(dir, "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello.\n---\nSay hello.\n");
  const databaseUrl = testDatabaseUrl();
  const left = slowReads(createSkillStore({ databaseUrl, advisoryLock: sharedLock(databaseUrl) }));
  const right = slowReads(createSkillStore({ databaseUrl, advisoryLock: sharedLock(databaseUrl) }));
  const org = scopeId("org", "default-org");

  const seedModule = "../../src/skills/seed.ts";
  type Seed = typeof import("../../src/skills/seed.ts");
  const leftServer = (await import(`${seedModule}?server=left`)) as Seed;
  const rightServer = (await import(`${seedModule}?server=right`)) as Seed;
  await Promise.all([
    leftServer.installSeedSkills(left, { dir, scopeId: org }),
    rightServer.installSeedSkills(right, { dir, scopeId: org }),
  ]);

  const rows = await hello(left);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "published");
});

test("an admin archive racing another server's changed seed update leaves the skill archived", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seed-archive-xsrv-"));
  const databaseUrl = testDatabaseUrl();
  const seedWriting = Promise.withResolvers<void>();
  const releaseSeed = Promise.withResolvers<void>();
  const archiveLockEntered = Promise.withResolvers<void>();
  const archiveLock = sharedLock(databaseUrl);
  const leftStore = createSkillStore({ databaseUrl, advisoryLock: sharedLock(databaseUrl) });
  const left: SkillStore = {
    ...leftStore,
    async update(id, manifest) {
      if (manifest.body === "Updated instructions.\n") {
        seedWriting.resolve();
        await releaseSeed.promise;
      }
      return leftStore.update(id, manifest);
    },
  };
  const right = createSkillStore({
    databaseUrl,
    advisoryLock: {
      ...archiveLock,
      withLock(key, fn) {
        archiveLockEntered.resolve();
        return archiveLock.withLock(key, fn);
      },
    },
  });
  const org = scopeId("org", "default-org");
  const options = { dir, scopeId: org, respectArchived: true };
  const pending: Promise<unknown>[] = [];
  try {
    mkdirSync(join(dir, "hello"));
    const path = join(dir, "hello", "SKILL.md");
    writeFileSync(path, "---\nname: hello\ndescription: Say hello.\n---\nOriginal instructions.\n");
    await installSeedSkills(left, options);
    const original = (await right.resolve("hello", [org])).skill!;
    assert.ok(original);
    writeFileSync(path, "---\nname: hello\ndescription: Say hello.\n---\nUpdated instructions.\n");

    const seeding = installSeedSkills(left, options);
    pending.push(seeding);
    await Promise.race([
      seedWriting.promise,
      seeding.then(() => assert.fail("the changed seed did not reach the write barrier")),
    ]);
    const archiving = right.archive(original.id);
    pending.push(archiving);
    await Promise.race([archiving, archiveLockEntered.promise]);
    releaseSeed.resolve();
    await Promise.all([seeding, archiving]);

    const rows = await hello(right);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, original.id);
    assert.equal(rows[0]!.status, "archived");
    assert.equal(rows[0]!.manifest.body, "Updated instructions.\n");
    assert.equal(rows[0]!.version, original.version + 1);
    assert.equal((await left.resolve("hello", [org])).skill, null);
    assert.equal((await right.resolve("hello", [org])).skill, null);
  } finally {
    releaseSeed.resolve();
    await Promise.allSettled(pending);
    rmSync(dir, { recursive: true, force: true });
  }
});
