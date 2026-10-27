import "./auto-fake-sprites.ts";

import { after } from "node:test";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../plugins/chassis/src/portal-identity.ts";
import { createServer } from "../../src/api/server.ts";
import type { BuiltApp } from "../../src/wiring.ts";
import { buildApp } from "./build-app.ts";
import { testConfig } from "./test-config.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./test-database.ts";

export const SECRET = "core-signing-secret".repeat(3);

export async function startWebUiRelay(
  serverOptions: (built: BuiltApp) => Parameters<typeof createServer>[1],
  { runtime = false } = {},
): Promise<{ built: BuiltApp; webBase: string }> {
  const built = buildApp(testConfig());
  if (runtime) built.runtime.start();
  const core = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    ...serverOptions(built),
  });
  core.listen(0);
  process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
  process.env.CORE_SIGNING_SECRET = SECRET;
  process.env.WEB_UI_PRINCIPALS = "";
  const { handler } = await import("../../plugins/web-ui/server/index.ts");
  const web = createHttpServer(handler);
  web.listen(0);
  after(async () => {
    await new Promise<void>((r) => web.close(() => r()));
    await new Promise<void>((r) => core.close(() => r()));
    if (runtime) await built.runtime.stop();
  });
  return { built, webBase: `http://localhost:${(web.address() as AddressInfo).port}` };
}

export function asUser(user: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      "content-type": "application/json",
      [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, SECRET),
      ...init.headers,
    },
  };
}
