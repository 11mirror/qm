import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { buildApp } from "./build-app.ts";
import { testConfig } from "./test-config.ts";

export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
export const gitIn =
  (dir: string) =>
  (...a: string[]): void => {
    execFileSync("git", a, { cwd: dir, env: GIT_ENV, stdio: "ignore" });
  };

export const ADMIN = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
export const json = async (r: Response): Promise<any> => r.json();
export const registerPack = async (base: string, body: unknown): Promise<any> =>
  json(await fetch(`${base}/v1/admin/skill-packs`, { method: "POST", headers: ADMIN, body: JSON.stringify(body) }));
export const md = (front: string) => `---\n${front}\n---\n# Body\ntext`;

export function makeFixtureRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-reg-fixture-"));
  const g = gitIn(dir);
  g("init", "-q");
  mkdirSync(join(dir, "skills", "reg-beta", "scripts"), { recursive: true });
  mkdirSync(join(dir, "skills", "reg-alpha"), { recursive: true });
  mkdirSync(join(dir, "skills", "reg-personal"), { recursive: true });
  mkdirSync(join(dir, "trusted", "reg-secret"), { recursive: true });
  writeFileSync(join(dir, "skills", "reg-alpha", "SKILL.md"), md("name: reg-alpha\ndescription: a\nscope: company"));
  writeFileSync(join(dir, "skills", "reg-beta", "SKILL.md"), md("name: reg-beta\ndescription: b\nscope: company"));
  writeFileSync(join(dir, "skills", "reg-beta", "scripts", "x.py"), "print(1)");
  writeFileSync(
    join(dir, "skills", "reg-personal", "SKILL.md"),
    md("name: reg-personal\ndescription: p\nscope: personal"),
  );
  writeFileSync(join(dir, "trusted", "reg-secret", "SKILL.md"), md("name: reg-secret\ndescription: s\nscope: company"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "shared.mjs"), "export const x = 1;");
  mkdirSync(join(dir, "skills", "_conventions"), { recursive: true });
  writeFileSync(join(dir, "skills", "_conventions", "quality.md"), "# quality");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: GIT_ENV }).toString().trim();
  return { dir, sha };
}

export function makeRepoWithSharedLib(skillName: string): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-col-fixture-"));
  const g = gitIn(dir);
  g("init", "-q");
  mkdirSync(join(dir, "skills", skillName), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "skills", skillName, "SKILL.md"), md(`name: ${skillName}\ndescription: d\nscope: company`));
  writeFileSync(join(dir, "lib", "shared.mjs"), `export const who = "${skillName}";`);
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: GIT_ENV }).toString().trim();
  return { dir, sha };
}

export function makeRepoWithLayerCollision(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-layer-col-fixture-"));
  const g = gitIn(dir);
  g("init", "-q");
  mkdirSync(join(dir, "skills", "pack-active"), { recursive: true });
  mkdirSync(join(dir, "skills", "layer-owned"), { recursive: true });
  writeFileSync(
    join(dir, "skills", "pack-active", "SKILL.md"),
    md("name: pack-active\ndescription: active\nscope: company"),
  );
  writeFileSync(join(dir, "skills", "layer-owned", "helper.txt"), "from pack");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: GIT_ENV }).toString().trim();
  return { dir, sha };
}

export function start() {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
