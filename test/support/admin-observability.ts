import { createInsecureTestServer } from "../../src/api/server.ts";
import { buildApp } from "./build-app.ts";
import { testConfig } from "./test-config.ts";
import { listenLocal } from "./listen-local.ts";

export function start(overrides: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig({ ...overrides });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    runs: built.runs,
    workspace: built.workspace,
    files: built.files,
    config: built.config,
    outbound: built.outbound,
    crons: built.crons,
  });
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const ALICE = { "x-admin-actor": "admin-alice@default-org" };

export const get = (base: string, path: string, headers: Record<string, string> = ALICE) =>
  fetch(base + path, { headers });

export const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await get(base, path, headers)).json();
