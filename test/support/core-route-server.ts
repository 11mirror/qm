import type { AddressInfo } from "node:net";
import { createServer } from "../../src/api/server.ts";
import type { App } from "../../src/api/app.ts";
import { signedHeaders } from "../../plugins/chassis/src/core-client.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./test-database.ts";

type ServerOptions = NonNullable<Parameters<typeof createServer>[1]>;

export const CORE_SECRET = "core-signing-secret".repeat(3);

export type CoreResponse = { status: number; json: Record<string, unknown> };

/** Serves `app` on a signed core API at a free port; `post` sends a body signed the way the web edge signs it. */
export function serveCore(app: App, deps: Omit<ServerOptions, "replayDedupe" | "signingSecret"> = {}) {
  const server = createServer(app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: CORE_SECRET,
    ...deps,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<CoreResponse> {
    const raw = JSON.stringify(body);
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...signedHeaders(CORE_SECRET, "POST", path, raw), "content-type": "application/json", ...headers },
      body: raw,
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { base, post, close };
}
