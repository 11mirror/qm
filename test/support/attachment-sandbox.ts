import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";

export function fakeSandbox(): { sandbox: Sandbox; handle: SandboxHandle; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const sandbox = {
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      files.set(rel, data);
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
    async listDir(_h: SandboxHandle, dir: string) {
      return [...files.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
  } as unknown as Sandbox;
  return { sandbox, handle: { id: "x", rootDir: "/tmp/x" }, files };
}
