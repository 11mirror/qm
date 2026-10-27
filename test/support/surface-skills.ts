import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../../src/api/server.ts";
import { buildApp } from "./build-app.ts";
import { scopeId, type ScopeId } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./test-database.ts";

export function start() {
  const built = buildApp(testConfig({ orgId: "acme", seedSkills: false }));
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    skills: built.skills,
    directory: built.directory,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export async function publish(
  skills: ReturnType<typeof buildApp>["skills"],
  scope: ScopeId,
  name: string,
  description: string,
) {
  const sk = await skills.create({
    scopeId: scope,
    manifest: { name, description, requiredCapabilities: [], body: `# ${name}` },
    createdBy: "author",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
}

export interface SkillView {
  id: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed: boolean;
  editable: boolean;
  status?: string;
  version?: number;
}

export async function startSecure() {
  const SECRET = "skills-http-cap-secret".repeat(3);
  const built = buildApp(testConfig({ orgId: "acme", seedSkills: false, signingSecret: SECRET }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = (actorId: string, scope: ScopeId = scopeId("personal", actorId), liveActor = true) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        aud: CONTROL_PLANE_AUD,
        ...(liveActor ? { liveActor: true } : {}),
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );
  return {
    base,
    cap,
    skills: built.skills,
    directory: built.directory,
    sessions: built.sessions,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
