import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdir, readFile as fsReadFile } from "node:fs/promises";

const FINGERPRINT_FIXED_SOURCES = [
  "sandbox-base/Dockerfile",
  "local/Dockerfile",
  "cli/templates/aws/microvm-agent/agent.mjs",
];

export async function computeSandboxImageFingerprint(repoRoot: string): Promise<string | null> {
  try {
    const tools = (await readdir(join(repoRoot, "sandbox-base/tools"))).sort().map((f) => `sandbox-base/tools/${f}`);
    const paths = [...FINGERPRINT_FIXED_SOURCES, ...tools].sort();
    const fp = createHash("sha256");
    for (const p of paths) {
      fp.update(p);
      fp.update("\0");
      fp.update(
        createHash("sha256")
          .update(await fsReadFile(join(repoRoot, p)))
          .digest(),
      );
      fp.update("\n");
    }
    return fp.digest("hex");
  } catch {
    return null;
  }
}

export async function checkSandboxImage(repoRoot: string, image: string, labeled: string): Promise<void> {
  const want = await computeSandboxImageFingerprint(repoRoot);
  if (want && labeled && labeled !== want)
    console.warn(`[local-sandbox] sandbox image ${image} is stale — run \`npm run sandbox:local:build\``);
}
