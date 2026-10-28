import { createHash } from "node:crypto";
import { relative } from "node:path";
import { readFile as fsReadFile, stat } from "node:fs/promises";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { shq } from "../util/shell.ts";
import { swallow } from "../util/errors.ts";
import { makeTar } from "./tar.ts";
import type { SandboxHandle } from "./sandbox.ts";

export interface RoLayerNames {
  manifest: string;
  tar: string;
  label: string;
}

export interface RoLayerIo {
  readFile(handle: SandboxHandle, relPath: string): Promise<string | null>;
  writeFileBytes(handle: SandboxHandle, relPath: string, data: Uint8Array): Promise<void>;
  exec(script: string, timeoutSec: number): Promise<{ code: number; stderr: string }>;
}

export async function materializeRoLayers(
  workspace: WorkspaceStore,
  layers: WorkspaceLayer[],
  handle: SandboxHandle,
  io: RoLayerIo,
  names: RoLayerNames,
): Promise<void> {
  const roFiles: Array<{ path: string; abs: string }> = [];
  for (const layer of layers) {
    if (layer.mode === "rw") continue;
    const dir = workspace.scopeDir(layer.scopeId);
    for (const abs of await workspace.list(layer.scopeId)) {
      const rel = relative(dir, abs);
      roFiles.push({ path: layer.mountPath ? `${layer.mountPath}/${rel}` : rel, abs });
    }
  }
  if (!roFiles.length) return;
  roFiles.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
  const fp = createHash("sha256");
  for (const f of roFiles) {
    const st = await stat(f.abs);
    fp.update(`${f.path}\0${st.size}\0${st.mtimeMs}\n`);
  }
  const want = fp.digest("hex");
  let have: string | null = null;
  try {
    have = await io.readFile(handle, names.manifest);
  } catch (err) {
    swallow(`${names.label}: ro-layers manifest probe`, err);
  }
  if (have === want) return;
  const roEntries: Array<{ path: string; data: Uint8Array }> = [];
  for (const f of roFiles) roEntries.push({ path: f.path, data: await fsReadFile(f.abs) });
  const tar = await makeTar([...roEntries, { path: names.manifest, data: Buffer.from(want) }]);
  await io.writeFileBytes(handle, names.tar, tar);
  const extract = await io.exec(
    `cd ${shq(handle.rootDir)} && tar -xf ${shq(names.tar)}; rc=$?; rm -f ${shq(names.tar)}; exit $rc`,
    120,
  );
  if (extract.code !== 0) throw new Error(`${names.label} read-only layer materialize failed: ${extract.stderr}`);
}
