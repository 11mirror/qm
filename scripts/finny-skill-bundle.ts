import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface FinnySkillBundleOptions {
  sourceRoot: string;
  targetRoot: string;
  allowlist: readonly string[];
  sourceRevision: string;
  classification: string;
  dryRun?: boolean;
}

export interface FinnySkillBundleManifest {
  schemaVersion: 1;
  source: { root: string; revision: string };
  classification: string;
  skills: string[];
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface FinnySkillInventoryDecision {
  name: string;
  decision: "stage" | "skip";
  reason: "allowlisted" | "not_allowlisted";
}

export interface FinnySkillBundleResult {
  manifest: FinnySkillBundleManifest;
  manifestJson: string;
  decisions: FinnySkillInventoryDecision[];
}

interface ValidatedFile {
  relativePath: string;
  bytes: Buffer;
  sha256: string;
}

const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CREDENTIAL_NAME = /(^|[._-])(auth|credentials?|secrets?|tokens?|keys?)([._-]|$)/i;

function stableCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function assertSafeSkillNames(allowlist: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of allowlist) {
    if (!VALID_SKILL_NAME.test(name) || name === "." || name === ".." || isAbsolute(name)) {
      throw new Error(`Invalid skill directory name: ${JSON.stringify(name)}`);
    }
    const folded = name.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new Error(`Duplicate case-folded skill directory name: ${JSON.stringify(name)}`);
    seen.add(folded);
    names.push(name);
  }
  return names.sort(stableCompare);
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertSafeRelativePath(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  if (!isWithin(root, absolute))
    throw new Error(`Path escapes source root: ${JSON.stringify(relative(root, absolute))}`);
  const rel = relative(root, absolute).split(sep).join("/");
  if (!rel || rel === ".") throw new Error("Expected a path below the source root");
  return rel;
}

function isCredentialLikeFilename(name: string): boolean {
  const lower = name.toLocaleLowerCase("en-US");
  return lower === ".env" || lower.startsWith(".env.") || CREDENTIAL_NAME.test(lower);
}

function assertTextFile(bytes: Buffer, relativePath: string): void {
  const hasBinaryControlByte = bytes.some(
    (byte) => byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f,
  );
  if (hasBinaryControlByte) throw new Error(`Unexpected binary file: ${JSON.stringify(relativePath)}`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Unexpected binary file: ${JSON.stringify(relativePath)}`);
  }
}

async function validateTree(sourceRoot: string, skillName: string): Promise<ValidatedFile[]> {
  const skillRoot = resolve(sourceRoot, skillName);
  if (!isWithin(sourceRoot, skillRoot) || skillRoot === sourceRoot) {
    throw new Error(`Skill path escapes source root: ${JSON.stringify(skillName)}`);
  }
  const rootStat = await lstat(skillRoot);
  if (rootStat.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${JSON.stringify(skillName)}`);
  if (!rootStat.isDirectory()) throw new Error(`Allowlisted skill is not a directory: ${JSON.stringify(skillName)}`);

  const validated: ValidatedFile[] = [];
  const foldedPaths = new Set<string>();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => stableCompare(a.name, b.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const relativePath = assertSafeRelativePath(sourceRoot, absolute);
      const folded = relativePath.toLocaleLowerCase("en-US");
      if (foldedPaths.has(folded)) throw new Error(`Duplicate case-folded path: ${JSON.stringify(relativePath)}`);
      foldedPaths.add(folded);

      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${JSON.stringify(relativePath)}`);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${JSON.stringify(relativePath)}`);
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Socket, device, or FIFO is not allowed: ${JSON.stringify(relativePath)}`);
      if (isCredentialLikeFilename(basename(absolute))) {
        throw new Error(`Credential-like filename is not allowed: ${JSON.stringify(relativePath)}`);
      }
      if ((stat.mode & 0o111) !== 0) throw new Error(`Unexpected executable file: ${JSON.stringify(relativePath)}`);

      const bytes = await readFile(absolute);
      assertTextFile(bytes, relativePath);
      validated.push({
        relativePath,
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }

  await walk(skillRoot);
  return validated;
}

export async function stageFinnySkillBundle(options: FinnySkillBundleOptions): Promise<FinnySkillBundleResult> {
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const allowlist = assertSafeSkillNames(options.allowlist);
  if (!options.sourceRevision.trim()) throw new Error("sourceRevision must not be empty");
  if (!options.classification.trim()) throw new Error("classification must not be empty");
  if (sourceRoot === targetRoot || isWithin(sourceRoot, targetRoot)) {
    throw new Error("Target root must be outside the source root");
  }

  const sourceStat = await lstat(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("Source root must be a real directory");

  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
  const sourceNames = sourceEntries.map((entry) => entry.name).sort(stableCompare);
  const sourceFolded = new Set<string>();
  for (const name of sourceNames) {
    const folded = name.toLocaleLowerCase("en-US");
    if (sourceFolded.has(folded)) throw new Error(`Duplicate case-folded source entry: ${JSON.stringify(name)}`);
    sourceFolded.add(folded);
  }

  const allowedFolded = new Set(allowlist.map((name) => name.toLocaleLowerCase("en-US")));
  const decisions: FinnySkillInventoryDecision[] = sourceNames.map((name) =>
    allowedFolded.has(name.toLocaleLowerCase("en-US"))
      ? { name, decision: "stage", reason: "allowlisted" }
      : { name, decision: "skip", reason: "not_allowlisted" },
  );

  const manifest: FinnySkillBundleManifest = {
    schemaVersion: 1,
    source: { root: sourceRoot, revision: options.sourceRevision },
    classification: options.classification,
    skills: [...allowlist],
    files: [],
  };

  if (options.dryRun) return { manifest, manifestJson: `${JSON.stringify(manifest, null, 2)}\n`, decisions };

  const actualByFolded = new Map(sourceNames.map((name) => [name.toLocaleLowerCase("en-US"), name]));
  const files: ValidatedFile[] = [];
  for (const requestedName of allowlist) {
    const actualName = actualByFolded.get(requestedName.toLocaleLowerCase("en-US"));
    if (!actualName) throw new Error(`Allowlisted skill directory does not exist: ${JSON.stringify(requestedName)}`);
    if (actualName !== requestedName) {
      throw new Error(`Allowlisted skill name has different casing on disk: ${JSON.stringify(requestedName)}`);
    }
    files.push(...(await validateTree(sourceRoot, actualName)));
  }
  files.sort((a, b) => stableCompare(a.relativePath, b.relativePath));
  manifest.files = files.map((file) => ({ path: file.relativePath, size: file.bytes.byteLength, sha256: file.sha256 }));
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  try {
    await lstat(targetRoot);
    throw new Error(`Target root already exists: ${JSON.stringify(targetRoot)}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await mkdir(targetRoot, { recursive: false, mode: 0o700 });
  for (const file of files) {
    const destination = resolve(targetRoot, ...file.relativePath.split("/"));
    if (!isWithin(targetRoot, destination)) throw new Error("Internal path containment failure");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { mode: 0o600, flag: "wx" });
  }
  await writeFile(resolve(targetRoot, "manifest.json"), manifestJson, { mode: 0o600, flag: "wx" });
  return { manifest, manifestJson, decisions };
}
