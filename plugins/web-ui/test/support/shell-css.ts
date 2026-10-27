import { readFileSync } from "node:fs";

export function shellCss(): string {
  const shell = new URL("../../src/shell.css", import.meta.url);
  return [...readFileSync(shell, "utf8").matchAll(/@import "(\.\/[^"]+)";/g)]
    .map(([, path]) => readFileSync(new URL(path!, shell), "utf8"))
    .join("\n");
}
