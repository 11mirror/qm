import { createInsecureTestServer, createServer } from "../../src/api/server.ts";
import { buildApp } from "./build-app.ts";
import type { Mailer } from "../../plugins/chassis/src/resend.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../../src/auth/capability-token.ts";
import { scopeId } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";
import { listenLocal } from "./listen-local.ts";

export const ALICE = "admin-alice@default-org";

export const NOBODY = "user-uma@default-org";

export const SECRET = "external-users-test-secret".repeat(2);

export const PORTAL = "https://portal.example.com";

export const ORG = scopeId("org", "default-org");

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Sent = { to: string; subject: string; text: string; html: string };

export function stubMailer(fail?: string): { sent: Sent[]; mailer: Mailer } {
  const sent: Sent[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        if (fail) throw new Error(fail);
        sent.push(message);
        return "msg-1";
      },
    },
  };
}

export function start(
  opts: { mailer?: Mailer; signed?: boolean; emailAuthDomain?: string; emailAuthPrincipals?: string[] } = {},
) {
  const built = buildApp(testConfig({ ...(opts.signed ? { signingSecret: SECRET } : {}) }));
  const deps = {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    identity: built.identity,
    directory: built.directory,
    config: built.config,
    portalUrl: PORTAL,
    portalIdentitySecret: SECRET,
    replayDedupe: { durable: true, claim: built.replayDedupe!.claim.bind(built.replayDedupe!) },
    brandingDefault: { selfLabel: "Acme Bot" },
    ...(opts.mailer ? { inviteMailer: opts.mailer } : {}),
    ...(opts.emailAuthDomain ? { emailAuthDomain: opts.emailAuthDomain } : {}),
    ...(opts.emailAuthPrincipals ? { emailAuthPrincipals: opts.emailAuthPrincipals } : {}),
  };
  const server = opts.signed
    ? createServer(built.app, {
        ...deps,
        signingSecret: SECRET,
      })
    : createInsecureTestServer(built.app, deps);
  const base = listenLocal(server);
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const invite = (base: string, body: unknown, headers: Record<string, string> = { "x-admin-actor": ALICE }) =>
  fetch(`${base}/v1/admin/external-users`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const revoke = (base: string, email: string, headers: Record<string, string> = { "x-admin-actor": ALICE }) =>
  fetch(`${base}/v1/admin/external-users/${encodeURIComponent(email)}`, { method: "DELETE", headers });

export const roster = async (
  base: string,
  headers: Record<string, string> = { "x-admin-actor": ALICE },
): Promise<any> => (await fetch(`${base}/v1/admin/users`, { headers })).json();

export const capFor = (actorId: string) =>
  mintCapabilityToken(
    {
      actorId,
      scopeId: scopeId("personal", actorId),
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    SECRET,
  );
