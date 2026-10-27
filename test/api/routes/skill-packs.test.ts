import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ADMIN,
  json,
  md,
  makeFixtureRepo,
  makeRepoWithSharedLib,
  makeRepoWithLayerCollision,
  start,
  registerPack,
  GIT_ENV,
} from "../../support/skill-pack-repos.ts";

test("register → browse → import → list → remove a git skill pack (org scope)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;
    assert.ok(id);
    assert.equal(reg.pack.targetScopeId, "org:default-org");
    assert.equal(reg.pack.syncMode, "pinned");
    assert.equal(
      reg.pack.available,
      2,
      "registration scans the repo so the available (eligible) count shows immediately",
    );

    const cat = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.equal(cat.counts.eligible, 2);
    assert.equal(cat.counts.scope, 1);
    assert.ok(!cat.candidates.some((c: any) => c.upstreamName === "reg-secret"));
    assert.ok(
      !cat.candidates.some((c: any) => (c.importedScopes || []).length),
      "nothing is imported anywhere before importing",
    );

    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp.imported.sort(), ["reg-alpha", "reg-beta"]);

    const cat2 = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}/catalog`, { headers: ADMIN }));
    assert.deepEqual(
      cat2.candidates.find((c: any) => c.upstreamName === "reg-alpha")?.importedScopes,
      ["org:default-org"],
      "an imported skill reports the scope it landed in on re-browse",
    );

    const bundle = await s.built.skillBundles.get(id);
    assert.deepEqual(
      (bundle?.files ?? []).map((f) => f.path).sort(),
      ["lib/shared.mjs", "skills/_conventions/quality.md"],
      "shared files bundled; per-skill scripts + trusted/* excluded",
    );

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    const alpha = skills.skills.find((k: any) => k.name === "reg-alpha");
    assert.ok(alpha, "imported skill is listed");
    assert.equal(alpha.status, "published");
    assert.equal(alpha.ownerScopeId, "org:default-org");

    const list = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.equal(list.packs.length, 1);
    assert.equal(list.packs[0].lastImport.status, "ok");
    assert.equal(list.packs[0].importedCount, 2, "2 skills currently imported from this pack");
    assert.equal(list.packs[0].lastImport.counts.eligible, 2, "available (eligible) count is on lastImport.counts");

    const del = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN }));
    assert.equal(del.removed, 2);
    assert.equal((await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }))).packs.length, 0);
    assert.equal(await s.built.skillBundles.get(id), null, "removing the pack deletes its shared bundle too");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("pack removal and re-import identify pack skills by their pack record, not their creator label", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;
    const lookalike = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "reg-alpha", description: "native", body: "native body", requiredCapabilities: [] },
      createdBy: `pack:${id}`,
    });
    await s.built.skills.review(lookalike.id, "admin-alice@default-org", []);
    await s.built.skills.publish(lookalike.id);

    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: ["reg-alpha", "reg-beta"] }),
      }),
    );
    assert.deepEqual(imp.imported, ["reg-beta"]);
    assert.equal((await s.built.skills.get(lookalike.id))?.manifest.body, "native body", "import leaves it alone");

    const del = await json(await fetch(`${s.base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN }));
    assert.equal(del.removed, 1);
    assert.equal((await s.built.skills.get(lookalike.id))?.status, "published", "pack removal leaves it alone");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("register works with only a url (defaults to the repo's default branch)", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, config: { exclude: ["trusted/*"] } });
    assert.ok(reg.pack.id);
    assert.equal(reg.pack.ref, "");
    const imp = await json(
      await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
        method: "POST",
        headers: ADMIN,
        body: JSON.stringify({ selected: "all" }),
      }),
    );
    assert.deepEqual(imp.imported.sort(), ["reg-alpha", "reg-beta"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("a legacy published skill with an unsafe name does not block unrelated pack reconciliation", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const legacy = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "legacy-safe", description: "legacy", requiredCapabilities: [], body: "legacy" },
      createdBy: "legacy-import",
    });
    await s.built.skills.review(legacy.id, "reviewer", []);
    await s.built.skills.publish(legacy.id);
    legacy.manifest.name = "Legacy Skill";

    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha });
    const imported = await fetch(`${s.base}/v1/admin/skill-packs/${reg.pack.id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: ["reg-alpha"] }),
    });
    assert.equal(imported.status, 200);
    assert.deepEqual((await json(imported)).imported, ["reg-alpha"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("supporting files are namespaced per pack, so same paths never clobber", async () => {
  const a = makeRepoWithSharedLib("col-alpha");
  const b = makeRepoWithSharedLib("col-beta");
  const s = start();
  try {
    const regA = await registerPack(s.base, { url: a.dir, ref: a.sha });
    const idA = regA.pack.id as string;
    await fetch(`${s.base}/v1/admin/skill-packs/${idA}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    const regB = await registerPack(s.base, { url: b.dir, ref: b.sha });
    const idB = regB.pack.id as string;
    const impB = await fetch(`${s.base}/v1/admin/skill-packs/${idB}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });

    assert.equal(impB.status, 200);

    assert.equal(
      (await s.built.skillBundles.get(idA))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
      'export const who = "col-alpha";',
    );
    assert.equal(
      (await s.built.skillBundles.get(idB))?.files.find((f) => f.path === "lib/shared.mjs")?.content,
      'export const who = "col-beta";',
    );
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.ok(skills.skills.some((k: any) => k.name === "col-beta"));
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("pack reconciliation and deployment-layer replacement serialize their materialization claims", async () => {
  const repo = makeRepoWithLayerCollision();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha });
    const id = reg.pack.id as string;
    const originalPut = s.built.skillBundles.put.bind(s.built.skillBundles);
    let entered!: () => void;
    let release!: () => void;
    const bundleEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundleRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.built.skillBundles.put = async (bundle) => {
      entered();
      await bundleRelease;
      await originalPut(bundle);
    };

    const importing = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await bundleEntered;
    const replacing = s.built.deploymentLayerStore.put(
      {
        contract: 1,
        tools: [],
        skills: [
          { path: "skills/layer-owned/SKILL.md", content: md("name: layer-owned\ndescription: deployment") },
          { path: "skills/layer-owned/helper.txt", content: "from deployment" },
        ],
      },
      "test",
    );
    release();

    assert.equal((await importing).status, 200);
    await assert.rejects(replacing, /skills\/layer-owned\/helper\.txt, already claimed by pack:/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("pack removal waits for an in-flight reconciliation and leaves no orphan records", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, ref: repo.sha, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;
    const originalPut = s.built.skillBundles.put.bind(s.built.skillBundles);
    let entered!: () => void;
    let release!: () => void;
    const bundleEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const bundleRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.built.skillBundles.put = async (bundle) => {
      entered();
      await bundleRelease;
      await originalPut(bundle);
    };

    const importing = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await bundleEntered;
    let removed = false;
    const removing = fetch(`${s.base}/v1/admin/skill-packs/${id}`, { method: "DELETE", headers: ADMIN }).then(
      (response) => {
        removed = true;
        return response;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(removed, false);
    release();

    assert.equal((await importing).status, 200);
    assert.equal((await removing).status, 200);
    assert.equal(await s.built.skillBundles.get(id), null);
    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ADMIN }));
    assert.ok(!skills.skills.some((skill: any) => skill.createdBy === `pack:${id}`));
    const packs = await json(await fetch(`${s.base}/v1/admin/skill-packs`, { headers: ADMIN }));
    assert.ok(!packs.packs.some((pack: any) => pack.id === id));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});

test("an older tracked-pack fetch cannot roll back a newer reconciliation", async () => {
  const repo = makeFixtureRepo();
  const s = start();
  try {
    const reg = await registerPack(s.base, { url: repo.dir, config: { exclude: ["trusted/*"] } });
    const id = reg.pack.id as string;
    const originalFetch = s.built.skillFetcher.fetch.bind(s.built.skillFetcher);
    let entered!: () => void;
    let release!: () => void;
    const oldFetchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const oldFetchRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    s.built.skillFetcher.fetch = async (pack) => {
      const fetched = await originalFetch(pack);
      if (first) {
        first = false;
        entered();
        await oldFetchRelease;
      }
      return fetched;
    };

    const older = fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    await oldFetchEntered;

    writeFileSync(
      join(repo.dir, "skills", "reg-alpha", "SKILL.md"),
      md("name: reg-alpha\ndescription: newest\nscope: company"),
    );
    execFileSync("git", ["add", "-A"], { cwd: repo.dir, env: GIT_ENV, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "newer"], { cwd: repo.dir, env: GIT_ENV, stdio: "ignore" });
    const newestCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo.dir,
      env: GIT_ENV,
      encoding: "utf8",
    }).trim();

    const newer = await fetch(`${s.base}/v1/admin/skill-packs/${id}/import`, {
      method: "POST",
      headers: ADMIN,
      body: JSON.stringify({ selected: "all" }),
    });
    assert.equal(newer.status, 200);
    release();

    const stale = await older;
    assert.equal(stale.status, 500);
    assert.equal((await json(stale)).message, "internal server error");
    assert.equal((await s.built.skillBundles.get(id))?.commit, newestCommit);
    const stored = (await s.built.skills.list()).find(
      (skill) => skill.createdBy === `pack:${id}` && skill.manifest.name === "reg-alpha",
    );
    assert.equal(stored?.manifest.description, "newest");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
    await s.close();
  }
});
