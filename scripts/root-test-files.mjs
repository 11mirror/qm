import { readdir } from "node:fs/promises";

const SKIPPED = new Set(["e2e", "fixtures", "integration", "memory-bench", "support"]);

export async function rootTestFiles(dir = "test") {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) files.push(...(await rootTestFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}
