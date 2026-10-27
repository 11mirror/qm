import "./auto-fake-sprites.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "./test-app.ts";
import { testConfig } from "./test-config.ts";
import { settle } from "./settle.ts";

export async function listFull(store: any, opts?: any): Promise<any[]> {
  const rows = await store.list(opts);
  return Promise.all(rows.map((r: any) => store.get(r.id)));
}

export function freshApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  return buildTestApp(testConfig({ dataDir }));
}

export async function judged(
  store: any,
  container: string,
  ready: (rows: any[]) => boolean = (rows) => rows.length > 0,
) {
  await settle(async () => ready(await listFull(store, { scope: container })));
  return listFull(store, { scope: container });
}
