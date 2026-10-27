import { test } from "node:test";
import assert from "node:assert/strict";
import { refusalNote, refusalDelivery, postThenAckRunDelivery } from "../../src/slack/refusals.ts";
import { SESSION_BUSY_USER_TEXT } from "../../src/core/failure-copy.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../../src/api/app.ts";
import { createOrchestrator } from "../../src/core/orchestrator.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { createModelGateway } from "../../src/model/model-gateway.ts";
import { createMockHarness } from "../support/mock-harness.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createDockerDeployProvider } from "../../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../../src/deploy/deploy-service.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createTurnRunner } from "../../src/turns/turn-runner.ts";
import { TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import type { ErrorLog } from "../../src/admin/error-log.ts";
import type { SessionStore } from "../../src/sessions/session-store.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import type { Conversation, Principal } from "../../src/types.ts";
import { singleProcessDeps } from "../support/single-process.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresRateLimiter } from "../../src/ratelimit/postgres-rate-limiter.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { testConfigStore, testDatabaseUrl, testDeployBackings } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { settledRun, testRunStore } from "../support/turns.ts";

const ADMIN_URL = "https://portal.example.com/admin/?view=history&session=s-1";

test("refusalNote: a failure renders the core-supplied admin link and drops the misleading DM/internal steer", () => {
  const note = refusalNote({ reason: "An unknown error occurred", adminUrl: ADMIN_URL }, "channel");
  assert.match(note, /An unknown error occurred/);
  assert.match(note, /Full error: https:\/\/portal\.example\.com\/admin\/\?view=history&session=s-1/);
  assert.doesNotMatch(note, /fully-internal/, "a turn error is not a boundary refusal — no internal-channel advice");
});

test("refusalNote: a boundary (internal-only) refusal keeps the DM/internal steer and never links", () => {
  const note = refusalNote(
    {
      status: "refused",
      refusalKind: "internal_only",
      reason: "internal-only: shared audience includes a non-internal participant",
      adminUrl: ADMIN_URL,
    },
    "channel",
  );
  assert.equal(
    note,
    "I can't respond here — internal-only: shared audience includes a non-internal participant. Try a DM or a fully-internal channel.",
  );
  assert.doesNotMatch(note, /Full error/, "boundary refusals have nothing to debug in admin");
});

test("refusalNote: no adminUrl ⇒ reason only, no dangling link", () => {
  const note = refusalNote({ reason: "approval denied for git push" }, "dm");
  assert.match(note, /approval denied for git push/);
  assert.doesNotMatch(note, /Full error/);
});

test("refusalNote: a busy session reads as a human note, with no error framing and no link", () => {
  const note = refusalNote(
    { status: "refused", refusalKind: "session_busy", reason: SESSION_BUSY_USER_TEXT, adminUrl: ADMIN_URL },
    "channel",
  );
  assert.equal(note, SESSION_BUSY_USER_TEXT);
  assert.doesNotMatch(note, /session busy/);
  assert.doesNotMatch(note, /error/i);
});

test("refusalNote: a failed turn hides the internal reason but keeps the admin link", () => {
  const note = refusalNote(
    { status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42", adminUrl: ADMIN_URL },
    "dm",
  );
  assert.doesNotMatch(note, /TypeError|sandbox\.ts/);
  assert.match(note, /something went wrong on my end/);
  assert.match(note, /Full error: https:/);
});

test("refusalNote: a security quarantine is human-safe and hides the internal reason", () => {
  const note = refusalNote(
    {
      refusalKind: "security_quarantine",
      reason: "Auto quarantined suspicious or unscreenable external input before the agent ran.",
      adminUrl: ADMIN_URL,
    },
    "channel",
  );

  assert.equal(
    note,
    "I couldn't act because my security screen flagged part of this message or its conversation context. Please retry without the flagged context, or ask an admin to review the quarantine.",
  );
  assert.doesNotMatch(note, /Auto quarantined|unscreenable|Full error/);
});

test("refusalDelivery: quarantine posts in-thread only when addressed; every unprompted refusal stays silent", () => {
  assert.equal(refusalDelivery({ refusalKind: "security_quarantine" }, false), "thread");
  assert.equal(refusalDelivery({ refusalKind: "security_quarantine" }, true), "silent");
  assert.equal(refusalDelivery({}, true), "silent");
  assert.equal(refusalDelivery({}, false), "requester");
});

test("postThenAckRunDelivery: acknowledges only after the Slack post succeeds", async () => {
  const calls: string[] = [];
  let finishPost!: () => void;
  const posting = postThenAckRunDelivery({
    post: () =>
      new Promise<void>((resolve) => {
        calls.push("post");
        finishPost = resolve;
      }),
    ack: () => calls.push("ack"),
    release: () => calls.push("release"),
  });

  assert.deepEqual(calls, ["post"]);
  finishPost();
  await posting;
  assert.deepEqual(calls, ["post", "ack"]);
});

test("postThenAckRunDelivery: releases recovery when the Slack post fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    postThenAckRunDelivery({
      post: async () => {
        calls.push("post");
        throw new Error("Slack unavailable");
      },
      ack: () => calls.push("ack"),
      release: () => calls.push("release"),
    }),
    /Slack unavailable/,
  );
  assert.deepEqual(calls, ["post", "release"]);
});

test("refusalNote: boundary copy follows the typed refusal kind, not the reason wording", () => {
  const dm = refusalNote(
    { status: "refused", refusalKind: "internal_only", reason: "guests cannot use this", adminUrl: ADMIN_URL },
    "dm",
  );
  assert.equal(dm, "I can't respond just now — guests cannot use this.");
  const untyped = refusalNote({ status: "refused", reason: "internal-only lookalike", adminUrl: ADMIN_URL }, "dm");
  assert.match(untyped, /Full error/);
});

const ORG = "default-org";
const ADMIN = "https://portal.example.com";
const actor: Principal = { id: "U1", type: "internal" };

function fakeSandbox(): Sandbox {
  const unreached = () => {
    throw new Error("fakeSandbox: a failed turn must not touch the sandbox");
  };
  return {
    profile: {
      backend: "fake",
      writablePersistence: "resident_disk",
      processSessions: false,
    },
    provision: unreached as never,
    run: unreached as never,
    readFile: unreached as never,
    writeFile: unreached as never,
    writeFileBytes: unreached as never,
    readFileBytes: unreached as never,
    listDir: unreached as never,
    removeDir: unreached as never,
    teardown: unreached as never,
  };
}

function buildOrchestrator(sessions: SessionStore) {
  const databaseUrl = testDatabaseUrl();
  const config = testConfigStore(ORG);
  const acl = createAclStore(createPostgresGrantStore(databaseUrl));
  const auditLog = createPostgresAuditLog(databaseUrl);
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "ral-")));
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore: createDeployStore(testDeployBackings()),
    provider: createDockerDeployProvider(),
    deployDir: join(tmpdir(), "ral-deploy"),
    auditLog,
    acl,
  });
  return createOrchestrator({
    ...singleProcessDeps(),
    identity: createIdentityService(databaseUrl),
    resolution: createResolutionService(ORG, config, acl),
    sessions,
    workspace,
    files: createPostgresFileArtifactStore(databaseUrl, createMemoryDurableByteStore()),
    sandbox: fakeSandbox(),
    modelGateway: createModelGateway(),
    auditLog,
    rateLimiter: createPostgresRateLimiter(databaseUrl, { maxPerWindow: 1000, windowMs: 60_000 }),
    harness: createMockHarness(),
    memory: createPostgresMemoryService(databaseUrl),
    deploy,
    acl,
  });
}

test("a failed turn surfaces a refusal whose admin link points at the real session UUID", async (t) => {
  // The session store checks the turn's fence, so it must share the ledger's database.
  const { runs, ledger, databaseUrl } = testRunStore();
  const sessions = createPostgresSessionStore(databaseUrl);
  const orchestrator = buildOrchestrator(sessions);
  const recorded: string[] = [];
  const errors = { record: (e) => recorded.push(e.message) } as Partial<ErrorLog> as ErrorLog;
  const runner = createTurnRunner({ ledger, orchestrator, queues: TURN_QUEUES, slots: 1, errors, pollMs: 50 });
  runner.start();
  t.after(() => runner.stopClaims());

  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const request = {
    surface: "test",
    actor,
    conversation: { kind: "channel", threadRef, audience: [actor] } as Conversation,
    origin: { kind: "direct" as const },
    text: "!boom",
  };
  const { run } = await runs.enqueue({ sessionId: threadRef, request, maxAttempts: 1 });

  const stored = await settledRun(runs, run.id);
  assert.ok(
    recorded.some((message) => /boom/.test(message)),
    `the failure was recorded: ${recorded.join("; ")}`,
  );
  assert.equal(stored?.result?.status, "failed");
  assert.equal(stored?.result?.sessionId, threadRef, "raw stored result holds the threadRef");

  const session = await sessions.getByThread(threadRef);
  assert.ok(session, "session row exists for the threadRef");

  const app = createApp({ sessions, runs, publicWebUrl: ADMIN } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session!.id, "getRun resolved threadRef → real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(got?.result?.adminUrl, `${ADMIN}/settings/history/s/${session!.id}`);

  const note = refusalNote(got!.result!, "channel");
  console.log("\n  Slack would post:\n  " + note + "\n");
  assert.equal(note.split("Full error: ")[1], `${ADMIN}/settings/history/s/${session!.id} Try again, or DM me.`);
  assert.doesNotMatch(note, /ch:C_UUID_FIXTURE/, "the link must not contain the threadRef");
  assert.doesNotMatch(note, /fully-internal/, "a turn failure is not a boundary refusal");
});
