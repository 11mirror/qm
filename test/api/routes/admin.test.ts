import { createAdminCall } from "../../../src/tools/admin.ts";
import { adminRoutes } from "../../../src/api/routes/admin.ts";
import { UNATTENDED_ADMIN_GRANTS } from "../../../src/api/control-service.ts";
import "../../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../../../src/types.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  EGRESS_PROXY_AUD,
} from "../../../src/auth/capability-token.ts";
import { mintSignedPayload } from "../../../src/auth/signed-token.ts";
import { SECRET, ORG, start, capFor } from "../../support/admin-capability.ts";

test("an org admin's capability token can read and rewrite a scope's notebook via the admin API", async () => {
  const s = await start();
  try {
    const cap = await capFor("admin-alice");
    await s.built.memory.capture(ORG, ["seed"], 0);
    const putRes = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "standup is 9:30 every day." }] }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": cap },
    });
    assert.equal(getRes.status, 200);
    assert.match(((await getRes.json()) as any).content, /standup is 9:30/);

    const updates = (await s.built.auditLog.events()).filter((e) => e.action === "memory.update");
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.principalId, "admin-alice", "the admin action is attributed to the acting admin");
  } finally {
    await s.close();
  }
});

test("a large channel's capability passes HTTP parsing and retains admin authorization", async () => {
  const s = await start();
  try {
    const members = Array.from({ length: 120 }, (_, i) => ({
      id: `channel-member-${i}@example.test`,
      type: "internal" as const,
      displayName: `Channel Member ${i}`,
      teamIds: ["engineering"],
    }));
    const claims = {
      actorId: "admin-alice",
      scopeId: "channel:C1",
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      liveAuthor: true,
      members,
      keychainMembers: members,
      exp: Date.now() + CAPABILITY_TTL_MS,
    };
    const url = `${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`;
    const legacy = await mintSignedPayload({ orgId: "default-org", ...claims }, SECRET);
    const rejected = await fetch(url, { headers: { "x-agent-capability": legacy } });
    assert.equal(rejected.status, 431);
    await rejected.text();
    const token = await mintCapabilityToken(claims, SECRET);
    await s.built.memory.capture(ORG, ["seed"], 0);
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "Large channel standing rule." }] }),
    });
    assert.equal(response.status, 200);
    await response.text();
    const read = await fetch(url, { headers: { "x-agent-capability": token } });
    assert.equal(read.status, 200);
    assert.match(((await read.json()) as { content: string }).content, /Large channel standing rule/);
    const denied = await fetch(url, {
      method: "PATCH",
      headers: {
        "x-agent-capability": await mintCapabilityToken({ ...claims, actorId: "U1" }, SECRET),
        "content-type": "application/json",
      },
      body: JSON.stringify({ facts: [{ id: "1", text: "unauthorized overwrite" }] }),
    });
    assert.equal(denied.status, 403);
    await denied.text();
  } finally {
    await s.close();
  }
});

test("whoami answers an agent capability token for admins and non-admins alike", async () => {
  const s = await start();
  try {
    const admin = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-agent-capability": await capFor("admin-alice") },
    });
    assert.deepEqual(await admin.json(), { isAdmin: true, role: "org_admin", scopeId: ORG, permissions: ["admin"] });

    const user = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": await capFor("U1") } });
    assert.deepEqual(await user.json(), { isAdmin: false, permissions: [] });
  } finally {
    await s.close();
  }
});

test("a non-admin's capability token gets 403 from admin routes (gate routes, the grant store decides)", async () => {
  const s = await start();
  try {
    const cap = await capFor("U1");
    await s.built.memory.capture(ORG, ["seed"], 0);
    const res = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "poisoned" }] }),
    });
    assert.equal(res.status, 403);
    assert.equal((await fetch(`${s.base}/v1/admin/users`, { headers: { "x-agent-capability": cap } })).status, 403);
    assert.doesNotMatch(await s.built.memory.read(ORG), /poisoned/);
  } finally {
    await s.close();
  }
});

test("x-admin-actor cannot escalate a capability token — the header is the portal's source-authed door", async () => {
  const s = await start();
  try {
    const cap = await capFor("U1");
    const spoof = { "x-agent-capability": cap, "x-admin-actor": "admin-alice@default-org" };

    const whoami = await fetch(`${s.base}/v1/admin/whoami`, { headers: spoof });
    assert.equal(
      ((await whoami.json()) as any).isAdmin,
      false,
      "the header must not turn a non-admin token into an admin",
    );

    await s.built.memory.capture(ORG, ["seed"], 0);
    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { ...spoof, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "escalated via x-admin-actor" }] }),
    });
    assert.equal(write.status, 403);
    assert.doesNotMatch(await s.built.memory.read(ORG), /escalated/);
  } finally {
    await s.close();
  }
});

test("a wrong-audience token never reaches the admin plane", async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/v1/admin/whoami`, {
      headers: { "x-agent-capability": await capFor("admin-alice", { aud: EGRESS_PROXY_AUD }) },
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("an autonomous turn's token cannot act as an admin, even when its actor holds the grant", async () => {
  const s = await start();
  try {
    const cap = await capFor("admin-alice", { live: false });

    const whoami = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await whoami.json()) as any).isAdmin, true, "whoami stays answerable — introspection, not reach");

    await s.built.memory.capture(ORG, ["seed"], 0);
    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "planted by a 3am cron" }] }),
    });
    assert.equal(write.status, 403);
    assert.match(((await write.json()) as any).message, /turn the admin started themselves/);
    assert.doesNotMatch(await s.built.memory.read(ORG), /planted/);
  } finally {
    await s.close();
  }
});

test("an unattended admin-read grant opens only the five read-only routes and keeps the DM gate", async () => {
  const s = await start();
  try {
    const granted = await capFor("admin-alice", { live: false, grants: ["admin.sessions.read"] });
    const scopeQ = `scope=${encodeURIComponent(ORG)}`;
    const allowed: Array<[string, number]> = [
      [`/v1/admin/sessions?${scopeQ}`, 200],
      [`/v1/admin/sessions/missing-session?${scopeQ}`, 404],
      ["/v1/admin/scopes", 200],
      [`/v1/admin/errors?${scopeQ}`, 200],
      [`/v1/admin/runs?${scopeQ}`, 200],
    ];
    for (const [path, expected] of allowed) {
      const response = await fetch(`${s.base}${path}`, { headers: { "x-agent-capability": granted } });
      assert.equal(response.status, expected, `${path} is usable under the grant (got ${response.status})`);
    }

    const denied = [
      ["GET", "/v1/admin/sessions/missing-session/llm"],
      ["GET", "/v1/admin/memory"],
      ["GET", `/v1/admin/scopes/${encodeURIComponent(ORG)}`],
      ["POST", "/v1/admin/sessions"],
      ["PUT", "/v1/admin/scopes"],
      ["DELETE", "/v1/admin/errors"],
    ] as const;
    for (const [method, path] of denied) {
      const response = await fetch(`${s.base}${path}`, {
        method,
        headers: { "x-agent-capability": granted, "content-type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      });
      assert.equal(response.status, 403, `${method} ${path} stays attended-only`);
    }

    const ungranted = await capFor("admin-alice", { live: false });
    const ungrantedRead = await fetch(`${s.base}/v1/admin/spend`, { headers: { "x-agent-capability": ungranted } });
    assert.equal(ungrantedRead.status, 403);
    assert.match(
      ((await ungrantedRead.json()) as { message: string }).message,
      /lacks the unattended grant admin\.spend\.read/,
    );
    const noGrantRoute = await fetch(`${s.base}/v1/admin/memory?${scopeQ}`, {
      headers: { "x-agent-capability": ungranted },
    });
    assert.equal(noGrantRoute.status, 403);
    assert.match(((await noGrantRoute.json()) as { message: string }).message, /cannot use this route/);
    const channelGrant = await capFor("admin-alice", {
      live: false,
      grants: ["admin.sessions.read"],
      scope: scopeId("channel", "C1"),
    });
    const channelRead = await fetch(`${s.base}/v1/admin/sessions`, {
      headers: { "x-agent-capability": channelGrant },
    });
    assert.equal(channelRead.status, 403);
    assert.match(((await channelRead.json()) as { message: string }).message, /ask the agent in a DM/);
  } finally {
    await s.close();
  }
});

test("each new unattended read grant opens exactly its own routes", async () => {
  const s = await start();
  try {
    const scopeQ = `scope=${encodeURIComponent(ORG)}`;
    const cases: Array<[string, string[]]> = [
      ["admin.audit.read", [`/v1/admin/audit?${scopeQ}`]],
      ["admin.egress.read", [`/v1/admin/egress?${scopeQ}`]],
      ["admin.files.read", [`/v1/admin/files?${scopeQ}`]],
      ["admin.spend.read", ["/v1/admin/spend"]],
      ["admin.crons.read", [`/v1/admin/crons?${scopeQ}`]],
    ];
    const crossDenied = [
      `/v1/admin/sessions?${scopeQ}`,
      `/v1/admin/audit?${scopeQ}`,
      `/v1/admin/egress?${scopeQ}`,
      `/v1/admin/files?${scopeQ}`,
      "/v1/admin/spend",
      `/v1/admin/crons?${scopeQ}`,
    ];
    for (const [grant, allowed] of cases) {
      const token = await capFor("admin-alice", { live: false, grants: [grant] });
      for (const path of allowed) {
        const response = await fetch(`${s.base}${path}`, { headers: { "x-agent-capability": token } });
        assert.equal(response.status, 200, `${grant} opens ${path} (got ${response.status})`);
      }
      for (const path of crossDenied) {
        if (allowed.includes(path)) continue;
        const response = await fetch(`${s.base}${path}`, { headers: { "x-agent-capability": token } });
        assert.equal(response.status, 403, `${grant} must not open ${path}`);
      }
    }
    const combined = await capFor("admin-alice", {
      live: false,
      grants: ["admin.sessions.read", "admin.egress.read"],
    });
    assert.equal(
      (await fetch(`${s.base}/v1/admin/egress?${scopeQ}`, { headers: { "x-agent-capability": combined } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${s.base}/v1/admin/sessions?${scopeQ}`, { headers: { "x-agent-capability": combined } })).status,
      200,
    );
    assert.equal(
      (await fetch(`${s.base}/v1/admin/audit?${scopeQ}`, { headers: { "x-agent-capability": combined } })).status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("the unattended-grant listing mirrors the route annotations and only answers a live org admin", async () => {
  const s = await start();
  try {
    const expected = adminRoutes.flatMap((route) =>
      "path" in route && route.admin?.unattended
        ? [{ grant: route.admin.unattended.grant, method: route.method, path: route.path }]
        : [],
    );
    const listing = await createAdminCall(s.base, await capFor("admin-alice"))({ action: "unattended_grants" });
    assert.equal(listing.status, 200);
    const grants = (listing.body as { grants: Array<Record<string, string>> }).grants;
    assert.deepEqual(
      grants.map(({ grant, method, path }) => ({ grant, method, path })),
      expected,
    );
    assert.deepEqual(new Set(grants.map((entry) => entry.grant)), new Set(UNATTENDED_ADMIN_GRANTS));
    assert.ok(grants.every((entry) => entry.summary));
    assert.deepEqual(
      grants.filter((entry) => entry.action === "spend" || entry.action === "crons").map((entry) => entry.grant),
      ["admin.spend.read", "admin.crons.read"],
    );
    assert.ok(!grants.some((entry) => entry.path === "/v1/admin/users"));
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "unattended-grants.read"));

    const nonAdmin = await fetch(`${s.base}/v1/admin/unattended-grants`, {
      headers: { "x-agent-capability": await capFor("U1") },
    });
    assert.equal(nonAdmin.status, 403);
    const unattended = await fetch(`${s.base}/v1/admin/unattended-grants`, {
      headers: {
        "x-agent-capability": await capFor("admin-alice", { live: false, grants: [...UNATTENDED_ADMIN_GRANTS] }),
      },
    });
    assert.equal(unattended.status, 403);
  } finally {
    await s.close();
  }
});

test("an aud-less token never opens the admin door", async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": await capFor("admin-alice", { aud: null }) },
    });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).message, /per-turn agent token/);
  } finally {
    await s.close();
  }
});

test("grant management refuses agent tokens outright — promote/revoke stays in the portal", async () => {
  const s = await start();
  try {
    const cap = await capFor("admin-alice");
    const promote = await fetch(`${s.base}/v1/admin/grants`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: ORG }),
    });
    assert.equal(promote.status, 403);
    assert.match(((await promote.json()) as any).message, /portal-only/);

    const revoke = await fetch(`${s.base}/v1/admin/grants/admin-bob?scope=${encodeURIComponent(ORG)}&role=org_admin`, {
      method: "DELETE",
      headers: { "x-agent-capability": cap },
    });
    assert.equal(revoke.status, 403);

    const u9 = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": await capFor("U9") } });
    assert.equal(((await u9.json()) as any).isAdmin, false, "the refused promote really didn't land");
  } finally {
    await s.close();
  }
});

test("admin walls hold for every spelling of a path, and encoded params still route", async () => {
  const s = await start();
  try {
    const live = await capFor("admin-alice");
    const unattended = await capFor("admin-alice", { live: false });
    for (const [path, status] of [
      ["/v1/admin/grants", 403],
      ["/v1/%61dmin/grants", 404],
      ["/v1/admin/gr%61nts", 404],
    ] as const) {
      const promote = await fetch(`${s.base}${path}`, {
        method: "POST",
        headers: { "x-agent-capability": live, "content-type": "application/json" },
        body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: ORG }),
      });
      assert.equal(promote.status, status, `promote via ${path}`);
    }
    for (const [path, status] of [
      ["/v1/admin/grants/admin-bob", 403],
      ["/v1/%61dmin/grants/admin-bob", 404],
    ] as const) {
      const revoke = await fetch(`${s.base}${path}?scope=${encodeURIComponent(ORG)}&role=org_admin`, {
        method: "DELETE",
        headers: { "x-agent-capability": unattended },
      });
      assert.equal(revoke.status, status, `unattended revoke via ${path}`);
    }
    const whoami = async (who: string) =>
      (
        (await (
          await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": await capFor(who) } })
        ).json()) as any
      ).isAdmin;
    assert.equal(await whoami("U9"), false);
    assert.equal(await whoami("admin-bob"), true);

    const scope = await fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": live },
    });
    assert.equal(scope.status, 200);
  } finally {
    await s.close();
  }
});

test("MCP server registration refuses agent tokens — the agent cannot change which calls need approval", async () => {
  const s = await start();
  try {
    const res = await fetch(`${s.base}/v1/admin/mcp-servers/crm`, {
      method: "PUT",
      headers: { "x-agent-capability": await capFor("admin-alice"), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://tools.example.com/mcp", approval: "none", validate: false }),
    });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as any).message, /portal-only/);
  } finally {
    await s.close();
  }
});

test("impersonation refuses agent tokens outright — acting as another user stays in the portal", async () => {
  const s = await start();
  try {
    const cap = await capFor("admin-alice");
    const start1 = await fetch(`${s.base}/v1/admin/impersonate`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ target: "U9" }),
    });
    assert.equal(start1.status, 403);
    assert.match(((await start1.json()) as any).message, /portal-only/);

    const stop1 = await fetch(`${s.base}/v1/admin/impersonate/stop`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ target: "U9" }),
    });
    assert.equal(stop1.status, 403);
  } finally {
    await s.close();
  }
});

test("a live admin turn in a shared room reads private content like a DM", async () => {
  const s = await start();
  try {
    const fromChannel = await capFor("admin-alice", { scope: scopeId("channel", "C1") });

    const sessions = await fetch(`${s.base}/v1/admin/sessions?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(sessions.status, 200);
    const personalNotebook = await fetch(
      `${s.base}/v1/admin/memory?scope=${encodeURIComponent(scopeId("personal", "U1"))}`,
      {
        headers: { "x-agent-capability": fromChannel },
      },
    );
    assert.equal(personalNotebook.status, 200);

    await s.built.memory.capture(ORG, ["seed"], 0);
    const put = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { "x-agent-capability": fromChannel, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "launch day is June 24." }] }),
    });
    assert.equal(put.status, 200);
    const orgNotebook = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(orgNotebook.status, 200);

    const userFromChannel = await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("U1")}`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(userFromChannel.status, 200);
    const keychainFromChannel = await fetch(`${s.base}/v1/admin/keychain`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(keychainFromChannel.status, 200);
    const mirrorFromChannel = await fetch(`${s.base}/v1/admin/ambient-context`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(mirrorFromChannel.status, 200);
    const judgmentsFromChannel = await fetch(`${s.base}/v1/admin/ambient-judgments`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(judgmentsFromChannel.status, 200);
    const importFromChannel = await fetch(`${s.base}/v1/admin/scopes/${encodeURIComponent(ORG)}/import`, {
      method: "PUT",
      headers: { "x-agent-capability": fromChannel, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(importFromChannel.status, 404);
    assert.match(((await importFromChannel.json()) as { message: string }).message, /unknown admin resource/);
    const ackPicksFromChannel = await fetch(`${s.base}/v1/admin/ack-emoji-picks`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(ackPicksFromChannel.status, 200);
    const rosterFromChannel = await fetch(`${s.base}/v1/admin/users`, {
      headers: { "x-agent-capability": fromChannel },
    });
    assert.equal(rosterFromChannel.status, 200);

    const fromDm = await capFor("admin-alice");
    const dmSessions = await fetch(`${s.base}/v1/admin/sessions?scope=${encodeURIComponent(ORG)}`, {
      headers: { "x-agent-capability": fromDm },
    });
    assert.equal(dmSessions.status, 200);
    const dmUser = await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("U1")}`, {
      headers: { "x-agent-capability": fromDm },
    });
    assert.equal(dmUser.status, 200);
    const dmKeychain = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-agent-capability": fromDm } });
    assert.equal(dmKeychain.status, 200);
  } finally {
    await s.close();
  }
});

test("revoking the admin grant cuts off an already-minted token immediately", async () => {
  const s = await start();
  try {
    const cap = await capFor("admin-alice");
    const before = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await before.json()) as any).isAdmin, true);
    await s.built.admin.revokeGrant({ id: "admin-bob", type: "internal" }, "admin-alice", ORG, "org_admin");

    const after = await fetch(`${s.base}/v1/admin/whoami`, { headers: { "x-agent-capability": cap } });
    assert.equal(((await after.json()) as any).isAdmin, false);
    await s.built.memory.capture(ORG, ["seed"], 0);
    const write = await fetch(`${s.base}/v1/admin/memory?scope=${encodeURIComponent(ORG)}`, {
      method: "PATCH",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ id: "1", text: "stale admin" }] }),
    });
    assert.equal(write.status, 403, "the live grant store, not the token, is the authority");
  } finally {
    await s.close();
  }
});
