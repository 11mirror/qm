import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN, json, md, makeFixtureRepo, start, registerPack, gitIn } from "../../support/skill-pack-repos.ts";

test("re-import archives removed/renamed/now-ineligible skills and keeps unchanged ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-recon-"));
  const g = gitIn(dir);
  const writeSkill = (name: string, scope = "company"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: d\nscope: ${scope}`));
  };
  g("init", "-q");
  for (const n of ["recon-keep", "recon-del", "recon-ren", "recon-flip"]) writeSkill(n);
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await registerPack(s.base, { url: dir });
    const id = reg.pack.id as string;
    const imp1 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp1.imported.sort(), ["recon-del", "recon-flip", "recon-keep", "recon-ren"]);

    rmSync(join(dir, "skills", "recon-del"), { recursive: true, force: true });
    rmSync(join(dir, "skills", "recon-ren"), { recursive: true, force: true });
    writeSkill("recon-ren2");
    writeFileSync(
      join(dir, "skills", "recon-flip", "SKILL.md"),
      md("name: recon-flip\ndescription: d\nscope: personal"),
    );
    g("add", "-A");
    g("commit", "-q", "-m", "mutate");

    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp2.imported, ["recon-ren2"], "the renamed-to (new) skill imports");
    assert.deepEqual(
      imp2.archived.sort(),
      ["recon-del", "recon-flip", "recon-ren"],
      "deleted + renamed-from + now-personal are archived",
    );

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const published = skills.skills
      .filter((k: any) => k.status === "published")
      .map((k: any) => k.name)
      .sort();
    assert.ok(published.includes("recon-keep") && published.includes("recon-ren2"), "unchanged + renamed-to survive");
    assert.ok(
      !["recon-del", "recon-ren", "recon-flip"].some((n) => published.includes(n)),
      "removed/renamed-from/now-personal are gone",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("sync refreshes IMPORTED skills (update + archive) but does NOT add un-imported ones; PATCH flips syncMode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-sync-"));
  const g = gitIn(dir);
  const writeSkill = (name: string, desc = "d"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: ${desc}\nscope: company`));
  };
  g("init", "-q");
  writeSkill("sync-a");
  writeSkill("sync-keep");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await registerPack(s.base, { url: dir });
    const id = reg.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    const patched = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}`, {
        method: "PATCH",
        headers: ADMIN,
        body: JSON.stringify({ syncMode: "tracked" }),
      }),
    );
    assert.equal(patched.pack.syncMode, "tracked");

    writeSkill("sync-new");
    writeSkill("sync-a", "CHANGED");
    rmSync(join(dir, "skills", "sync-keep"), { recursive: true, force: true });
    g("add", "-A");
    g("commit", "-q", "-m", "evolve");

    const synced = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, { method: "POST", headers: ADMIN, body: "{}" }),
    );
    assert.deepEqual(synced.updated, ["sync-a"], "a changed imported skill is updated");
    assert.deepEqual(synced.archived, ["sync-keep"], "an imported skill removed upstream is archived");
    assert.ok(!synced.imported.includes("sync-new"), "sync does NOT add a skill that was never imported");

    const afterSync = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(afterSync.packs[0].lastImport.counts.imported, 0, "sync adds nothing new");
    assert.equal(afterSync.packs[0].lastImport.counts.updated, 1, "the changed imported skill counts as updated");
    assert.equal(afterSync.packs[0].lastImport.counts.archived, 1, "the removed imported skill counts as archived");

    const published = (
      await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }))
    ).skills
      .filter((k: any) => k.status === "published")
      .map((k: any) => k.name);
    assert.ok(published.includes("sync-a"), "the updated skill stays live");
    assert.ok(!published.includes("sync-keep"), "the removed-upstream skill is archived");
    assert.ok(!published.includes("sync-new"), "the new upstream skill is NOT auto-added by sync");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a single imported skill can be un-indexed (archived) via DELETE /admin/skills/:id", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    let skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const alpha = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.equal(alpha.status, "published");

    const del = await fetch(`${s.base}/v1/admin/skills/${alpha.id}?scope=org:default-org`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);

    skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const after = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.ok(!after || after.status === "archived", "the un-indexed skill is no longer published");
    assert.equal(
      skills.skills.find((k: any) => k.name === "reg-beta")?.status,
      "published",
      "sibling skill is untouched",
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("an admin can replace an archived seeded org skill with a same-named pack skill", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const seeded = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "reg-alpha", description: "bundled default", requiredCapabilities: [], body: "bundled" },
      createdBy: "system:skills-seed",
    });
    await s.built.skills.review(seeded.id, "system:skills-seed", []);
    await s.built.skills.publish(seeded.id);

    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;
    const before = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    const blocked = before.candidates.find((c: any) => c.upstreamName === "reg-alpha");
    assert.equal(blocked?.eligible, false);
    assert.equal(blocked.excludeReason, "collision");
    const blockedImport = await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: ["reg-alpha"] }),
    });
    assert.equal(blockedImport.status, 200);
    assert.deepEqual((await json(blockedImport)).imported, []);
    assert.equal((await s.built.skills.resolve("reg-alpha", ["org:default-org"])).skill?.id, seeded.id);

    const archived = await fetch(`${s.base}/v1/admin/skills/${seeded.id}?scope=org:default-org`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(archived.status, 200);
    assert.equal((await s.built.skills.get(seeded.id))?.status, "archived");

    const after = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.equal(
      after.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.eligible,
      true,
      "archiving the bundled default frees its name for a replacement",
    );
    const imported = await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: ["reg-alpha"] }),
    });
    assert.equal(imported.status, 200);
    assert.deepEqual((await json(imported)).imported, ["reg-alpha"]);
    assert.equal((await s.built.skills.get(seeded.id))?.status, "archived");
    const replacement = (await s.built.skills.resolve("reg-alpha", ["org:default-org"])).skill;
    assert.ok(replacement);
    assert.notEqual(replacement.id, seeded.id);
    assert.equal(replacement.createdBy, `pack:${id}`);
    assert.equal(replacement.scopeId, "org:default-org");
    assert.equal(replacement.manifest.description, "a");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("remove then re-register the same repo re-imports cleanly (no stuck-archived records)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg1 = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const imp1 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg1.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp1.imported.sort(), ["reg-alpha", "reg-beta"]);
    const del = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg1.pack.id}`, { method: "DELETE", headers: ADMIN }),
    );
    assert.equal(del.removed, 2);

    const reg2 = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg2.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(
      imp2.imported.sort(),
      ["reg-alpha", "reg-beta"],
      "re-add re-imports (delete-on-remove cleared the tombstones)",
    );
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.equal(
      skills.skills.filter((k: any) => k.name === "reg-alpha" && k.status === "published").length,
      1,
      "exactly one published reg-alpha (no tombstone)",
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("skill-pack routes are admin-only and audited", async () => {
  const s = start();
  try {
    assert.equal(
      (await fetch(`${s.base}/v1/admin/skill-packs`, { headers: { "x-admin-actor": "nobody@default-org" } })).status,
      403,
    );
    await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN });
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "skill_packs.read"));
  } finally {
    await s.close();
  }
});

const packSkillsIn = async (base: string, scope: string, packId: string): Promise<string[]> =>
  (await json(await fetch(`${base}/v1/admin/skills?scope=${encodeURIComponent(scope)}`, { headers: ADMIN }))).skills
    .filter((k: any) => k.status === "published" && k.ownerScopeId === scope && k.pack?.id === packId)
    .map((k: any) => k.name)
    .sort();

test("imports a pack into MULTIPLE scopes at once; catalog reports per-scope; importedCount is distinct", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;

    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
      }),
    );
    assert.equal(imp.imported.length, 4, "2 eligible skills × 2 scopes = 4 installs");

    assert.deepEqual(await packSkillsIn(s.base, "org:default-org", id), ["reg-alpha", "reg-beta"]);
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", id), ["reg-alpha", "reg-beta"]);

    const cat = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.deepEqual(cat.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.importedScopes.sort(), [
      "org:default-org",
      "personal:admin-alice",
    ]);

    const list = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(list.packs[0].importedCount, 2, "distinct skills imported, not per-scope records");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("re-importing into ONE scope archives only that scope's deselected skills, not another scope's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-scoped-"));
  const g = gitIn(dir);
  const writeSkill = (name: string): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: d\nscope: company`));
  };
  g("init", "-q");
  writeSkill("scoped-a");
  writeSkill("scoped-b");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await registerPack(s.base, { url: dir });
    const id = reg.pack.id as string;

    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
    });

    const imp2 = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: ["scoped-a"], scopeIds: ["personal:admin-alice"] }),
      }),
    );
    assert.deepEqual(imp2.archived, ["scoped-b"], "alice's deselected skill is archived");

    assert.deepEqual(
      await packSkillsIn(s.base, "org:default-org", id),
      ["scoped-a", "scoped-b"],
      "the OTHER scope's skills are untouched",
    );
    assert.deepEqual(
      await packSkillsIn(s.base, "personal:admin-alice", id),
      ["scoped-a"],
      "only the re-imported skill remains in the targeted scope",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("sync refreshes EVERY scope the pack was imported into", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-syncmulti-"));
  const g = gitIn(dir);
  const writeSkill = (name: string, desc = "d"): void => {
    mkdirSync(join(dir, "skills", name), { recursive: true });
    writeFileSync(join(dir, "skills", name, "SKILL.md"), md(`name: ${name}\ndescription: ${desc}\nscope: company`));
  };
  g("init", "-q");
  writeSkill("ms-a");
  writeSkill("ms-keep");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const reg = await registerPack(s.base, { url: dir });
    const id = reg.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["org:default-org", "personal:admin-alice"] }),
    });

    writeSkill("ms-a", "CHANGED");
    rmSync(join(dir, "skills", "ms-keep"), { recursive: true, force: true });
    g("add", "-A");
    g("commit", "-q", "-m", "evolve");

    const synced = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/sync`, { method: "POST", headers: ADMIN, body: "{}" }),
    );
    assert.deepEqual(synced.updated.sort(), ["ms-a", "ms-a"], "the changed skill is updated in BOTH imported scopes");
    assert.deepEqual(
      synced.archived.sort(),
      ["ms-keep", "ms-keep"],
      "the removed skill is archived in BOTH imported scopes",
    );
    assert.equal(synced.imported.length, 0, "sync adds nothing new");

    assert.deepEqual(await packSkillsIn(s.base, "org:default-org", id), ["ms-a"]);
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", id), ["ms-a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});

test("import rejects malformed scopeIds with a 400", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const bad = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["not-a-scope"] }),
    });
    assert.equal(bad.status, 400);
    assert.match((await json(bad)).message, /scopeIds/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a pack skill whose name collides with a native skill in ANOTHER scope still imports into its own scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-xscope-"));
  const g = gitIn(dir);
  mkdirSync(join(dir, "skills", "shared-name"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "shared-name", "SKILL.md"),
    md("name: shared-name\ndescription: from pack\nscope: company"),
  );
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  const s = start();
  try {
    const nat = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "shared-name", description: "native", requiredCapabilities: [], body: "x" },
      createdBy: "system:native",
    });
    await s.built.skills.review(nat.id, "system:native", []);
    await s.built.skills.publish(nat.id);

    const reg = await registerPack(s.base, { url: dir });
    const imp = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all", scopeIds: ["personal:admin-alice"] }),
    });
    assert.equal(imp.status, 200, "org's same-named native skill must not clobber-block a sub-scope import");
    assert.deepEqual((await json(imp)).imported, ["shared-name"], "the pack skill imports into its own scope");
    assert.deepEqual(await packSkillsIn(s.base, "personal:admin-alice", reg.pack.id), ["shared-name"]);
    const orgNative = (
      await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }))
    ).skills.find((k: any) => k.name === "shared-name" && k.ownerScopeId === "org:default-org");
    assert.equal(orgNative?.status, "published", "the org native skill is untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await s.close();
  }
});
