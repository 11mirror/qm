import { randomUUID } from "node:crypto";
import { signedHeaders, withSourceAuthNonce } from "../../../../plugins/chassis/src/core-client.ts";
import { mintSignedPayload, verifySignedPayload } from "../../../../src/auth/signed-token.ts";
import "../../../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { adminStatusFromGrants } from "../../../../src/admin/admin-service.ts";
import { coreEmailAllowed } from "../../../../plugins/chassis/src/external-members.ts";
import {
  ALICE,
  NOBODY,
  SECRET,
  PORTAL,
  ORG,
  DAY_MS,
  stubMailer,
  start,
  invite,
  revoke,
  roster,
  capFor,
} from "../../../support/external-users.ts";

const inviteTeammate = (base: string, body: unknown, headers: Record<string, string> = { "x-admin-actor": ALICE }) =>
  fetch(`${base}/v1/admin/users/invite`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("teammates receive permanent access and appear before their first session", async () => {
  const { sent, mailer } = stubMailer();
  const s = start({ mailer, emailAuthDomain: "corp.example" });
  try {
    const r = await inviteTeammate(s.base, { email: " Engineer@Corp.example " });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.member.expiresAt, null);
    assert.equal(d.member.kind, "teammate");
    assert.equal(d.emailSent, true);
    assert.ok(sent[0]);
    assert.match(sent[0].text, /no expiration/);
    assert.doesNotMatch(sent[0].html, /Invalid Date/);
    const list = await roster(s.base);
    assert.ok(list.users.some((u: any) => u.principalId === "engineer@corp.example" && u.sessionCount === 0));
    assert.equal(list.externalUsers[0].status, "active");
    assert.equal(await coreEmailAllowed(s.base, undefined, "engineer@corp.example", "test"), true);
    assert.equal((await inviteTeammate(s.base, { email: "engineer@corp.example" })).status, 200);
    assert.equal(sent.length, 2);
    assert.equal((await roster(s.base)).externalUsers.length, 1);
    assert.equal((await revoke(s.base, "engineer@corp.example")).status, 200);
    assert.equal(await coreEmailAllowed(s.base, undefined, "engineer@corp.example", "test"), false);
    assert.equal(s.built.identity.classify("engineer@corp.example").type, "guest");
  } finally {
    await s.close();
  }
});

test("teammate invitations validate expiry, require admin, and do not demote existing admins", async () => {
  const s = start();
  try {
    assert.equal((await inviteTeammate(s.base, { email: "a@corp.example" }, { "x-admin-actor": NOBODY })).status, 403);
    assert.equal((await inviteTeammate(s.base, { email: "invalid" })).status, 400);
    assert.equal(
      (await inviteTeammate(s.base, { email: "a@corp.example", expiresAt: Date.now() - DAY_MS })).status,
      400,
    );
    const first = await inviteTeammate(s.base, { email: "a@corp.example", role: "org_admin" });
    assert.equal(first.status, 200);
    const again = await inviteTeammate(s.base, { email: "a@corp.example", role: "member" });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as any).member.role, "org_admin");
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), "a@corp.example").isAdmin, true);
    assert.equal((await invite(s.base, { email: "a@corp.example", expiresAt: Date.now() + DAY_MS })).status, 400);
  } finally {
    await s.close();
  }
});

test("agent capabilities cannot create permanent teammate access", async () => {
  const s = start({ signed: true });
  try {
    const r = await inviteTeammate(
      s.base,
      { email: "a@corp.example" },
      { "x-agent-capability": await capFor("admin-alice") },
    );
    assert.equal(r.status, 403);
    assert.equal(s.built.identity.externalMember("a@corp.example"), undefined);
  } finally {
    await s.close();
  }
});

test("invitation links work without email delivery and are single use, scoped, and revocable", async () => {
  const s = start();
  const redeem = (token: string) =>
    fetch(`${s.base}/v1/auth/invitations/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  const issue = async () => {
    const r = await inviteTeammate(s.base, { email: "qa@corp.example" });
    assert.equal(r.status, 200);
    const data: any = await r.json();
    assert.equal(data.emailSent, false);
    const url = new URL(data.signInUrl);
    assert.equal(url.pathname, "/auth/invite");
    return new URLSearchParams(url.hash.slice(1)).get("token")!;
  };
  try {
    const token = await issue();
    const claims: any = await verifySignedPayload(token, SECRET);
    assert.equal((await redeem(token + "tampered")).status, 400);
    assert.equal((await redeem(await mintSignedPayload({ ...claims, exp: Date.now() - 1 }, SECRET))).status, 400);
    assert.equal((await redeem(await mintSignedPayload({ ...claims, org: "org:other" }, SECRET))).status, 400);
    assert.equal(
      (await redeem(await mintSignedPayload({ ...claims, aud: "https://elsewhere.example" }, SECRET))).status,
      400,
    );
    const results = await Promise.all([redeem(token), redeem(token)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const accepted: any = await results.find((r) => r.status === 200)!.json();
    assert.equal(accepted.email, "qa@corp.example");
    const revoked = await issue();
    assert.equal((await revoke(s.base, "qa@corp.example")).status, 200);
    assert.equal((await redeem(revoked)).status, 403);
    await issue();
    assert.equal((await redeem(revoked)).status, 403);
  } finally {
    await s.close();
  }
});

test("invitation redemption requires source authentication before consuming a valid invitation", async () => {
  const s = start({ signed: true });
  try {
    const now = Date.now();
    const inviteId = randomUUID();
    const email = "signed-teammate@corp.example";
    await s.built.identity.putExternalMember({
      email,
      role: "member",
      expiresAt: null,
      kind: "teammate",
      inviteId,
      invitedBy: "admin-alice",
      createdAt: now,
      updatedAt: now,
    });
    const token = await mintSignedPayload(
      {
        purpose: "teammate-invite",
        org: ORG,
        aud: PORTAL,
        email,
        inviteId,
        iat: now,
        exp: now + DAY_MS,
        jti: randomUUID(),
      },
      SECRET,
    );
    const body = JSON.stringify({ token });
    const path = withSourceAuthNonce("/v1/auth/invitations/redeem", SECRET);
    const unsigned = await fetch(`${s.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(unsigned.status, 401);
    const signed = await fetch(`${s.base}${path}`, {
      method: "POST",
      headers: signedHeaders(SECRET, "POST", path, body),
      body,
    });
    assert.equal(signed.status, 200);
    assert.deepEqual(await signed.json(), { email });
    const reusedPath = withSourceAuthNonce("/v1/auth/invitations/redeem", SECRET);
    const reused = await fetch(`${s.base}${reusedPath}`, {
      method: "POST",
      headers: signedHeaders(SECRET, "POST", reusedPath, body),
      body,
    });
    assert.equal(reused.status, 400);
    assert.deepEqual(await reused.json(), { error: "invitation_used" });
  } finally {
    await s.close();
  }
});

test("teammate invites reject manual deactivation before changing access or sending mail", async () => {
  const { sent, mailer } = stubMailer();
  const s = start({ mailer });
  const email = "inactive@corp.example";
  try {
    await s.built.identity.deactivate(email);
    const denied = await inviteTeammate(s.base, { email, role: "org_admin" });
    assert.equal(denied.status, 409);
    assert.match(((await denied.json()) as any).message, /Reactivate/);
    assert.equal(s.built.identity.externalMember(email), undefined);
    assert.equal(adminStatusFromGrants(await s.built.admin.listGrants(), email).isAdmin, false);
    assert.equal(sent.length, 0);
    assert.equal(s.built.identity.classify(email).type, "guest");

    await s.built.identity.reactivate(email);
    assert.equal((await inviteTeammate(s.base, { email })).status, 200);
    assert.equal((await revoke(s.base, email)).status, 200);
    assert.equal((await inviteTeammate(s.base, { email })).status, 200);
    assert.equal(s.built.identity.classify(email).type, "internal");
    assert.equal(sent.length, 2);
  } finally {
    await s.close();
  }
});
