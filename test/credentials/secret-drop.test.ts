import "../support/auto-fake-sprites.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "../support/build-app.ts";
import { createServer } from "../../src/api/server.ts";
import { createSecretDropStore, SECRET_DROP_TTL_MS } from "../../src/credentials/secret-drop.ts";
import { fireDropResolution, type DropResolution } from "../../src/triggers/keychain-ask.ts";
import { recordingOutbound } from "../support/recording-outbound.ts";
import { createIdempotencyStore } from "../../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../../src/auth/capability-token.ts";
import { signedRequestHeaders } from "../../plugins/chassis/src/source-auth-sign.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../../src/types.ts";
import { testConfig } from "../support/test-config.ts";
import { testMap, testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresReplayDedupe } from "../../src/auth/replay-dedupe.ts";

const SECRET = "secret-drop-test-secret".repeat(3);

describe("SecretDropStore", () => {
  it("mint → peek (non-consuming) → redeem (single-use)", async () => {
    const t = 1_000_000;
    const store = createSecretDropStore(testDatabaseUrl(), { now: () => t });
    const { dropId } = await store.mint({
      ownerId: "U_A",
      service: "stripe",
      purpose: "charge cards",
      requestedBy: "U_A",
    });

    const p1 = await store.peek(dropId);
    assert.ok(p1.ok && p1.rec.service === "stripe");
    assert.ok((await store.peek(dropId)).ok, "peek does not consume the drop");

    const r1 = await store.redeem(dropId);
    assert.ok(r1.ok && r1.rec.ownerId === "U_A");
    const r2 = await store.redeem(dropId);
    assert.ok(!r2.ok && r2.reason === "not_found", "single-use: a second redeem finds nothing");
    assert.ok(!(await store.peek(dropId)).ok, "the record is gone after redemption");
  });

  it("expires after the TTL, on both peek and redeem", async () => {
    let t = 1_000_000;
    const store = createSecretDropStore(testDatabaseUrl(), { now: () => t });
    const { dropId } = await store.mint({ ownerId: "U_A", service: "x", purpose: "p", requestedBy: "U_A" });
    t += SECRET_DROP_TTL_MS + 1;
    assert.deepEqual(await store.peek(dropId), { ok: false, reason: "expired" });
    assert.deepEqual(await store.redeem(dropId), { ok: false, reason: "expired" });
  });

  it("siblings: pending drops for the same conversation only — other threads, expired links, and same-service twins excluded", async () => {
    let t = 1_000_000;
    const store = createSecretDropStore(testDatabaseUrl(), { now: () => t });
    const base = {
      ownerId: "U_A",
      purpose: "p",
      requestedBy: "U_A",
      audienceScopeId: scopeId("channel", "C1"),
      threadRef: "t1",
    } as const;
    const { dropId: stale } = await store.mint({ ...base, service: "stale" });
    t += SECRET_DROP_TTL_MS + 1;
    const { dropId: a } = await store.mint({ ...base, service: "alphasvc" });
    await store.mint({ ...base, service: "alphasvc" });
    await store.mint({ ...base, service: "betasvc" });
    await store.mint({ ...base, service: "otherthread", threadRef: "t2" });
    await store.mint({ ...base, service: "otherscope", audienceScopeId: scopeId("channel", "C2") });

    const redeemed = await store.redeem(a);
    assert.ok(redeemed.ok);
    assert.deepEqual(
      (await store.siblings(redeemed.rec)).map((r) => r.service).sort(),
      ["betasvc"],
      "same scope + thread, unexpired, different service",
    );
    assert.ok(!(await store.peek(stale)).ok, "the scan reaps expired links it walks past");
  });
});

describe("fireDropResolution", () => {
  const depsWith = (run: (req: TurnRequest) => Promise<TurnResult>) => ({
    outbound: recordingOutbound(),
    idempotency: createIdempotencyStore(testDatabaseUrl()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run,
  });

  it("resumes the channel as the owner with the credential handle, exactly once", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    const drop: DropResolution = {
      id: "drop1",
      ownerId: "U_A",
      service: "stripe",
      purpose: "charge cards",
      audienceScopeId: scopeId("channel", "C1"),
      threadRef: "ch:C1-t",
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
      grantId: "g1",
      credentialHandle: "kc_stripe",
      granted: true,
    };
    await fireDropResolution(deps, drop);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.conversation.kind, "channel");
    assert.equal(seen[0]!.actor.externalId, "U_A", "the resume runs as the owner who supplied the key");
    assert.match(seen[0]!.text, /kc_stripe/, "the channel resume hands over the credential handle");

    await fireDropResolution(deps, drop);
    assert.equal(seen.length, 1, "the drop:<id> fireKey dedupes a double fire");
  });

  it("skips a channel resume when the owner is no longer a current member of the drop's channel", async () => {
    const seen: TurnRequest[] = [];
    const run = async (req: TurnRequest) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    };
    const drop = (id: string): DropResolution => ({
      id,
      ownerId: "U_A",
      service: "stripe",
      purpose: "charge cards",
      audienceScopeId: scopeId("channel", "C1"),
      threadRef: "ch:C1-t",
      grantId: "g1",
      credentialHandle: "kc_stripe",
      granted: true,
    });
    const left = await fireDropResolution(
      { ...depsWith(run), currentScopeMembers: async () => [{ id: "U_B", type: "internal" as const }] },
      drop("drop-left"),
    );
    assert.equal(seen.length, 0, "membership is checked the same way as for crons and asks");
    assert.match(left.note ?? "", /no longer a member/);
    await fireDropResolution(
      {
        ...depsWith(run),
        currentScopeMembers: async () => [
          { id: "U_A", type: "internal" as const },
          { id: "U_B", type: "internal" as const },
        ],
      },
      drop("drop-member"),
    );
    assert.equal(seen.length, 1, "a current member still gets the resume");
  });

  it("resumes a DM (own scope, no grant) and tells the agent the key is available here", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    await fireDropResolution(deps, {
      id: "drop2",
      ownerId: "U_A",
      service: "openai",
      purpose: "summarize",
      audienceScopeId: scopeId("personal", "U_A"),
      granted: false,
    });
    assert.equal(seen[0]!.conversation.kind, "dm");
    assert.match(seen[0]!.text, /available here/);
  });

  it("enqueues a fallback delivery when the resume turn doesn't land (drop is single-use, no sweep)", async () => {
    const outbound = recordingOutbound();
    const deps = {
      outbound,
      idempotency: createIdempotencyStore(testDatabaseUrl()),
      identity: createIdentityService(testMap(), { externalMembers: testMap() }),
      run: async () => ({ status: "pending_approval" }) as TurnResult,
    };
    const destination = { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") } as const;
    await fireDropResolution(deps, {
      id: "dropF",
      ownerId: "U_A",
      service: "stripe",
      purpose: "p",
      audienceScopeId: scopeId("channel", "C1"),
      destination,
      grantId: "g1",
      credentialHandle: "kc_stripe",
      granted: true,
    });
    const fb = (await outbound.pending("slack")).filter((d) => d.idempotencyKey === "drop:dropF:fallback");
    assert.equal(fb.length, 1, "the conversation hears the key arrived even when the resume turn didn't run");
    assert.match(fb[0]!.text, /saved to the keychain/);
  });

  it("with sibling drops still pending: the wake fires (with its grant) but says what's outstanding instead of ordering a resume", async () => {
    const seen: TurnRequest[] = [];
    const deps = depsWith(async (req) => {
      seen.push(req);
      return { status: "ok" } as TurnResult;
    });
    await fireDropResolution(deps, {
      id: "dropP",
      ownerId: "U_A",
      service: "alphasvc",
      purpose: "p",
      audienceScopeId: scopeId("channel", "C1"),
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
      grantId: "gA",
      credentialHandle: "kc_alpha",
      granted: true,
      pendingSiblings: ["betasvc"],
    });
    assert.equal(seen.length, 1, "every redeem wakes the conversation — it must hear each grant's load command");
    assert.match(seen[0]!.text, /kc_alpha/, "the intermediate wake still hands over its own handle");
    assert.match(seen[0]!.text, /`betasvc`.*haven't been filled/, "the wake names the outstanding sibling links");
    assert.match(seen[0]!.text, /keep waiting/);
    assert.doesNotMatch(seen[0]!.text, /Pick the task back up/, "no resume order while credentials are outstanding");
    assert.doesNotMatch(seen[0]!.text, /and run the task/, "the grant load command must not carry a run order either");
  });
});

describe("/v1/keychain/drops — sibling-aware resume", () => {
  it("first redeem reports its pending sibling; the last redeem fires clean", async () => {
    const built = buildApp(testConfig({ signingSecret: SECRET }));
    await built.directory.replaceChannels(
      [{ channelId: "C1", name: "drops", isPrivate: false }],
      [{ channelId: "C1", principalId: "U_A" }],
    );
    const fires: DropResolution[] = [];
    let fired: (() => void) | undefined;
    const server = createServer(built.app, {
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
      signingSecret: SECRET,
      keychain: built.keychain,
      secretDrops: built.secretDrops,
      outbound: built.outbound,
      workspace: built.workspace,
      auditLog: built.auditLog,
      fireDropResolution: async (drop) => {
        fires.push(drop);
        fired?.();
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const cap = await mintCapabilityToken(
        { actorId: "U_A", scopeId: scopeId("channel", "C1"), threadRef: "th1", exp: Date.now() + CAPABILITY_TTL_MS },
        SECRET,
      );
      const mint = async (service: string) => {
        const r = await fetch(`${base}/v1/keychain/drops`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-agent-capability": cap },
          body: JSON.stringify({ service, purpose: "the task" }),
        });
        const { dropId, formPath } = (await r.json()) as { dropId: string; formPath: string };
        return { dropId, t: new URL(formPath, "http://x").searchParams.get("t")! };
      };
      let nonce = 0;
      const redeem = async ({ dropId, t }: { dropId: string; t: string }, secret: string) => {
        const waited = new Promise<void>((resolve) => {
          fired = resolve;
        });
        const path = `/v1/keychain/drops/${dropId}?t=${encodeURIComponent(t)}&_n=${nonce++}`;
        const body = JSON.stringify({ secret });
        const r = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...signedRequestHeaders(SECRET, "POST", path, body),
            "x-drop-owner": "U_A",
            "x-drop-owner-org": "acme",
            "content-type": "application/json",
          },
          body,
        });
        assert.equal(r.status, 200);
        await waited;
      };

      const alpha = await mint("alphasvc");
      const beta = await mint("betasvc");

      await redeem(alpha, "sk-alpha");
      assert.equal(fires.length, 1);
      assert.deepEqual(fires[0]!.pendingSiblings, ["betasvc"], "the first redeem knows its sibling is still pending");

      await redeem(beta, "sk-beta");
      assert.equal(fires.length, 2);
      assert.equal(fires[1]!.pendingSiblings, undefined, "the last redeem fires the plain resume");

      const gamma = await mint("gammasvc");
      await mint("deltasvc");
      const broken = built.secretDrops!.siblings;
      built.secretDrops!.siblings = () => Promise.reject(new Error("boom"));
      try {
        await redeem(gamma, "sk-gamma");
      } finally {
        built.secretDrops!.siblings = broken;
      }
      assert.equal(fires.length, 3, "a failed sibling scan must not cancel the wake");
      assert.equal(fires[2]!.pendingSiblings, undefined, "scan failure degrades to a wake with no sibling note");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
