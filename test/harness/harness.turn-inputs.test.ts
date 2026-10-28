import type { Harness, HarnessTurnInput } from "../../src/harness/harness.ts";
import type { SecurityScreener } from "../../src/security/security-screener.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMockHarness } from "../support/mock-harness.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { createSkillStore } from "../../src/skills/skill-store.ts";
import { scopeId, type TurnRequest } from "../../src/types.ts";
import { testDatabaseUrl, testAdvisoryLock } from "../support/test-database.ts";
import { actor, fakeSandbox, readSandbox, buildOrchestrator, dm, slackDm } from "../support/system-prompt.ts";
import { createMemoryBlobTransferStore } from "../support/in-process-stores.ts";

test("Open uses the exact skill snapshot that passed screening despite an in-flight source update", async () => {
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const owner = scopeId("personal", actor.id);
  const skill = await skills.create({
    scopeId: owner,
    createdBy: actor.id,
    manifest: {
      name: "snapshot-method",
      description: "SAFE_DESCRIPTION",
      body: "SAFE_BODY",
      requiredCapabilities: [],
    },
  });
  await skills.review(skill.id, actor.id, []);
  await skills.publish(skill.id);
  let updated = false;
  const securityScreener: SecurityScreener = {
    provider: "test",
    classify: async ({ payload }) => {
      if (!updated && payload.includes("SAFE_DESCRIPTION")) {
        updated = true;
        await skills.update(skill.id, {
          ...skill.manifest,
          description: "UNSCREENED_UPDATE !security-risk",
          body: "UNSCREENED_BODY !security-risk",
        });
      }
      return { verdict: { decision: payload.includes("!security-risk") ? "strict" : "auto" }, score: 0, threshold: 1 };
    },
  };
  const { orchestrator } = buildOrchestrator({
    skills,
    securityScreener,
    isCurrentSharedScopeMember: async () => true,
  });
  const result = await orchestrator.handleTurn({
    surface: "test",
    actor,
    origin: { kind: "human" },
    conversation: {
      kind: "channel",
      channelRef: "C1",
      threadRef: "C1:skill-snapshot",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!skill snapshot-method",
  });
  assert.equal(result.status, "ok", result.reason);
  assert.equal(updated, true);
  assert.match(result.reply ?? "", /SAFE_BODY/);
  assert.doesNotMatch(result.reply ?? "", /UNSCREENED_UPDATE|UNSCREENED_BODY/);
});

test("steered files materialize in separate inboxes and keep distinct durable artifacts", async () => {
  const blobTransfer = createMemoryBlobTransferStore();
  const first = await blobTransfer.put(Buffer.from("first file"));
  const second = await blobTransfer.put(Buffer.from("second file"));
  const writes = new Map<string, string>();
  const sandbox: Sandbox = {
    ...readSandbox(),
    removeDir: async () => {},
    listDir: async () => [],
    writeFile: async () => {},
    writeFileBytes: async (_handle, path, bytes) => {
      writes.set(path, Buffer.from(bytes).toString());
    },
  };
  const harness = createMockHarness();
  const prepared: Array<Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>>> = [];
  harness.turns.runTurn = async (turn) => {
    for (const blob of [first, second]) {
      prepared.push(
        await turn.prepareSteer!("read this", {
          origin: { kind: "direct" },
          surface: "web",
          actor: { externalId: actor.id },
          conversation: { kind: "dm", threadRef: "steer-files" },
          text: "read this",
          attachments: [{ name: "report.txt", mimetype: "text/plain", ...blob }],
        }),
      );
    }
    return { reply: "done" };
  };
  const { orchestrator, files } = buildOrchestrator({ harness, sandbox, blobTransfer });
  const result = await orchestrator.handleTurn(dm("steer-files", "hello"));
  assert.equal(result.status, "ok", result.reason);
  const inboundWrites = [...writes].filter(([path]) => path.endsWith("/report.txt"));
  assert.equal(inboundWrites.length, 2);
  assert.deepEqual(
    inboundWrites.map(([, content]) => content),
    ["first file", "second file"],
  );
  for (const [i, [path]] of inboundWrites.entries()) {
    assert.ok(prepared[i]!.text.includes(path));
    assert.ok(await files.get(prepared[i]!.attachments![0]!.artifactId!));
    assert.equal(
      Buffer.from(prepared[i]!.documents![0]!.dataBase64, "base64").toString(),
      i === 0 ? "first file" : "second file",
    );
  }
  assert.notEqual(prepared[0]!.attachments![0]!.artifactId, prepared[1]!.attachments![0]!.artifactId);
});

test("read-only turns report steered files as unavailable without provisioning a sandbox", async () => {
  const harness = createMockHarness();
  let prepared: Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>> | undefined;
  harness.turns.runTurn = async (turn) => {
    prepared = await turn.prepareSteer!("", {
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: actor.id },
      conversation: { kind: "dm", threadRef: "steer-strict" },
      text: "",
      attachments: [{ name: "secret.txt", mimetype: "text/plain", sizeBytes: 4, blobId: "b1" }],
    });
    return { reply: "done" };
  };
  const { orchestrator } = buildOrchestrator({ harness });
  const result = await orchestrator.handleTurn(dm("steer-strict", "hello", { readOnly: true }));
  assert.equal(result.status, "ok", result.reason);
  assert.deepEqual(prepared?.attachments, []);
  assert.deepEqual(prepared?.documents, []);
  assert.match(prepared?.text ?? "", /secret.txt/);
});

for (const budget of ["bytes", "reupload", "retry"] as const) {
  test(`steered documents respect the initial turn budget (${budget})`, async () => {
    const blobTransfer = createMemoryBlobTransferStore();
    const blob = await blobTransfer.put(Buffer.from(budget === "bytes" ? "x".repeat(7_999_995) : "initial"));
    const steerBlob = budget === "reupload" ? blob : await blobTransfer.put(Buffer.from("steered document"));
    const sandbox: Sandbox = {
      ...readSandbox(),
      removeDir: async () => {},
      listDir: async () => [],
      writeFile: async () => {},
      writeFileBytes: async () => {},
    };
    const harness = createMockHarness();
    let prepared: Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>> | undefined;
    harness.turns.runTurn = async (turn) => {
      assert.equal(turn.documents?.length, 1);
      const request: TurnRequest = {
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: actor.id },
        conversation: { kind: "dm", threadRef: `steer-budget-${budget}` },
        text: "read this",
        attachments: [
          { name: budget === "reupload" ? "initial-0.txt" : "steered.txt", mimetype: "text/plain", ...steerBlob },
        ],
      };
      prepared = await turn.prepareSteer!("read this", request);
      if (budget === "retry") {
        assert.equal(prepared.documents?.length, 1);
        prepared = await turn.prepareSteer!("read this", request);
        assert.equal(turn.documents?.length, 1);
      }
      if (budget === "reupload")
        assert.notEqual(prepared.attachments?.[0]?.artifactId, turn.documents?.[0]?.artifactId);
      return { reply: "done" };
    };
    const { orchestrator } = buildOrchestrator({ harness, sandbox, blobTransfer });
    const result = await orchestrator.handleTurn({
      ...dm(`steer-budget-${budget}`, "hello"),
      attachments: [{ name: "initial-0.txt", mimetype: "text/plain", ...blob }],
    });
    assert.equal(result.status, "ok", result.reason);
    if (budget === "retry") assert.equal(prepared?.documents?.length, 1);
    else assert.deepEqual(prepared?.documents, []);
    if (budget === "reupload" || budget === "retry") assert.doesNotMatch(prepared?.text ?? "", /not included inline/);
    else assert.match(prepared?.text ?? "", /steered.txt" is not included inline/);
  });
}

test("steered native office documents are observed by the screen after extraction and still delivered", async () => {
  const blobTransfer = createMemoryBlobTransferStore();
  const blob = await blobTransfer.put(readFileSync(new URL("../fixtures/documents/sample.docx", import.meta.url)));
  const sandbox: Sandbox = {
    ...readSandbox(),
    removeDir: async () => {},
    listDir: async () => [],
    writeFile: async () => {},
    writeFileBytes: async () => {},
  };
  const harness = createMockHarness();
  let prepared: Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>> | undefined;
  let screened = false;
  harness.turns.runTurn = async (turn) => {
    prepared = await turn.prepareSteer!("summarize", {
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: actor.id },
      conversation: { kind: "dm", threadRef: "steer-office-screen" },
      text: "summarize",
      attachments: [
        {
          name: "unsafe.docx",
          mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ...blob,
        },
      ],
    });
    return { reply: "done" };
  };
  const securityScreener: SecurityScreener = {
    provider: "test",
    classify: async ({ payload }) => {
      const blocked = payload.includes("DOCX-QUARTZ-731");
      screened ||= blocked;
      return { verdict: { decision: blocked ? "strict" : "auto" }, score: 0, threshold: 1 };
    },
  };
  const { orchestrator } = buildOrchestrator({ harness, sandbox, blobTransfer, securityScreener });
  const result = await orchestrator.handleTurn(dm("steer-office-screen", "hello"));
  assert.equal(result.status, "ok", result.reason);
  for (let i = 0; i < 3_000 && !screened; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(screened, true, "the extracted text reaches the screen");
  assert.equal(prepared?.documents?.length, 1, "a would-block verdict does not withhold the document");
  assert.doesNotMatch(prepared?.text ?? "", /withheld/);
});

test("documents uploaded during a turn survive a runtime handoff without aliasing the active harness", async () => {
  const blobTransfer = createMemoryBlobTransferStore();
  const blob = await blobTransfer.put(Buffer.from("HANDOFF-DOCUMENT-492"));
  const sandbox: Sandbox = {
    ...readSandbox(),
    removeDir: async () => {},
    listDir: async () => [],
    writeFile: async () => {},
    writeFileBytes: async () => {},
  };
  const harness = createMockHarness();
  let segments = 0;
  harness.turns.runTurn = async (turn) => {
    if (++segments === 1) {
      const activeDocuments = turn.documents!;
      const prepared = await turn.prepareSteer!("read this", {
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: actor.id },
        conversation: { kind: "dm", threadRef: "steer-handoff" },
        text: "read this",
        attachments: [{ name: "steered.txt", mimetype: "text/plain", ...blob }],
      });
      assert.equal(prepared.documents?.length, 1);
      assert.equal(activeDocuments.length, 0);
      return { reply: "", runtimeHandoff: { choice: { modelId: "gpt-6-astra" }, lifetime: "task" } };
    }
    assert.equal(turn.documents?.length, 1);
    assert.equal(Buffer.from(turn.documents![0]!.dataBase64, "base64").toString(), "HANDOFF-DOCUMENT-492");
    return { reply: "read after switching" };
  };
  const { orchestrator } = buildOrchestrator({ harness, sandbox, blobTransfer });
  const result = await orchestrator.handleTurn(dm("steer-handoff", "hello"));
  assert.equal(result.status, "ok", result.reason);
  assert.equal(segments, 2);
});

for (const surfaceTools of [false, true]) {
  test(`automatic memory is injected once, then only updates (${surfaceTools ? "spine" : "DM"})`, async () => {
    const base = createMockHarness();
    const seen: HarnessTurnInput[] = [];
    const harness: Harness = {
      ...base,
      turns: {
        ...base.turns,
        runTurn: async (turn) => {
          seen.push(turn);
          await turn.emit({ kind: "UserMessage", text: turn.input });
          await turn.emit({ kind: "AgentMessage", text: "ok" });
          return { reply: "ok" };
        },
      },
    };
    const { orchestrator, memory, sessions } = buildOrchestrator({ harness });
    const personal = scopeId("personal", actor.id);
    await memory.capture(personal, ["ALPHA_MARKER", "BETA_MARKER"], Date.now());
    const input = slackDm("memory-once", "hello", { surfaceTools });
    const first = await orchestrator.handleTurn(input);
    assert.equal(first.status, "ok");
    assert.match(seen[0]!.environment!, /ALPHA_MARKER/);
    await orchestrator.handleTurn({ ...input, text: "next" });
    assert.doesNotMatch(seen[1]!.environment ?? "", /ALPHA_MARKER|BETA_MARKER|What you remember/);
    const beta = (await memory.facts!(personal)).find((fact) => fact.text.includes("BETA_MARKER"))!;
    await memory.delete!(personal, [beta.id]);
    await memory.capture(personal, ["GAMMA_MARKER"], Date.now());
    await orchestrator.handleTurn({ ...input, text: "third" });
    assert.doesNotMatch(seen[2]!.environment!, /ALPHA_MARKER/);
    assert.match(seen[2]!.environment!, /GAMMA_MARKER/);
    assert.match(seen[2]!.environment!, /\nU1: 1 earlier fact was consolidated or removed/);
    const entries = await sessions.getItems(first.sessionId!);
    const users = entries.filter((entry) => entry.kind === "UserMessage");
    assert.match(JSON.stringify(users[0]!.body), /memoryRecall/);
    assert.doesNotMatch(JSON.stringify(users[1]!.body), /ALPHA_MARKER|BETA_MARKER/);
  });
}

test("profile and scheduled-work changes append fresh snapshots without rewriting the cached prefix or history", async () => {
  const crons = createCronStore(testDatabaseUrl());
  const sandbox = fakeSandbox();
  const seen: HarnessTurnInput[] = [];
  const harness = createMockHarness();
  const runTurn = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    seen.push(turn);
    return runTurn(turn);
  };
  const { orchestrator, sessions } = buildOrchestrator({ crons, sandbox, harness });
  const input = dm("dm:U1:snapshot-cache", "hello");
  const first = await orchestrator.handleTurn(input);
  assert.equal(first.status, "ok");
  const originalHistory = await sessions.getItems(first.sessionId!);
  const cron = await crons.create({
    owner: actor.id,
    createdBy: actor.id,
    ownerScopeId: scopeId("personal", actor.id),
    schedule: { everyMs: 300_000 },
    title: "Synthetic status",
    action: "check the synthetic status page",
  });
  sandbox.profile.spec = { os: "Other Linux", cpus: 8, workdir: "/new/workspace", homeDir: "/new/home" };
  assert.equal((await orchestrator.handleTurn({ ...input, text: "next" })).status, "ok");
  await crons.setEnabled(cron.id, false);
  assert.equal((await orchestrator.handleTurn({ ...input, text: "third" })).status, "ok");
  delete sandbox.profile.spec;
  crons.byOwner = async () => {
    throw new Error("inventory unavailable");
  };
  assert.equal((await orchestrator.handleTurn({ ...input, text: "fourth" })).status, "ok");
  for (const turn of seen) {
    assert.equal(turn.systemPrompt, seen[0]!.systemPrompt);
    assert.doesNotMatch(turn.systemPrompt, /Sandbox environment profile|Already scheduled here|synthetic status/);
    assert.match(turn.systemPrompt, /Use `cron` list\/get for details/);
  }
  assert.match(seen[0]!.environment!, /Debian 12/);
  assert.match(seen[0]!.environment!, /No active scheduled work/);
  assert.match(seen[1]!.environment!, /Other Linux|8 vCPU/);
  assert.match(seen[1]!.environment!, /Synthetic status/g);
  assert.doesNotMatch(seen[2]!.environment!, /Synthetic status/g);
  assert.match(seen[2]!.environment!, /No active scheduled work/);
  assert.match(seen[3]!.environment!, /No longer included: Sandbox environment profile/);
  assert.match(seen[3]!.environment!, /Scheduled-work status is unavailable/);
  assert.doesNotMatch(seen[3]!.environment!, /Other Linux|synthetic status|No active scheduled work/);
  assert.deepEqual(seen[1]!.history, originalHistory);
  assert.deepEqual((await sessions.getItems(first.sessionId!)).slice(0, originalHistory.length), originalHistory);
});

test("connector revocation refreshes the environment without treating historical inventories as authority", async () => {
  let revoked = false;
  const { orchestrator } = buildOrchestrator({
    connectorStatusCache: {
      get: async () => ({
        principalId: actor.id,
        checkedAt: Date.now(),
        providers: { google: { connected: true, needsReconnect: revoked } },
      }),
      put: async () => {},
    },
  });
  const first = await orchestrator.handleTurn(dm("dm:U1:revoked-cache", "!sysprompt"));
  revoked = true;
  const second = await orchestrator.handleTurn(dm("dm:U1:revoked-cache", "!sysprompt"));
  const prefix = (reply: string) => reply.split("\n\n<environment>")[0]!;
  assert.match(first.reply!, /Connected: Google/);
  assert.match(second.reply!, /Needs reconnect: Google.*Do not use these apps/);
  assert.doesNotMatch(second.reply!, /Connected: Google/);
  assert.equal(prefix(first.reply!), prefix(second.reply!));
  assert.match(second.reply!, /sections below replace their earlier versions/);
});

for (const mode of ["flagged", "ordinary"] as const) {
  test(`live inbox steering refreshes context with ${mode} screening`, async () => {
    const harness = createMockHarness();
    const thread = mode === "ordinary" ? "web:alice:default" : "web:alice:inbox";
    let prepared: Awaited<ReturnType<NonNullable<HarnessTurnInput["prepareSteer"]>>> | undefined;
    harness.turns.runTurn = async (turn) => {
      prepared = await turn.prepareSteer!("summarize again", {
        origin: { kind: "direct" },
        surface: "web",
        actor: { externalId: actor.id },
        conversation: { kind: "dm", threadRef: thread },
        text: "summarize again",
        conversationHeader: "UPDATED_INBOX_SNAPSHOT",
      });
      return { reply: "done" };
    };
    let refreshedScreens = 0;
    const securityScreener: SecurityScreener = {
      provider: "test",
      classify: async ({ payload }) => {
        if (payload.includes("UPDATED_INBOX_SNAPSHOT")) {
          refreshedScreens++;
          return { verdict: { decision: "strict" }, score: 1, threshold: 1 };
        }
        return { verdict: { decision: "auto" }, score: 0, threshold: 1 };
      },
    };
    const { orchestrator } = buildOrchestrator({ harness, securityScreener });
    const result = await orchestrator.handleTurn(dm(thread, "hello", { surface: "web" }));
    assert.equal(result.status, "ok", result.reason);
    if (mode === "flagged") assert.match(prepared!.text, /UPDATED_INBOX_SNAPSHOT/);
    else assert.equal(prepared!.text, "summarize again");
    if (mode === "ordinary") assert.equal(refreshedScreens, 0);
    else assert.ok(refreshedScreens > 0);
  });
}

test("the history tool opens one item without reading the transcript, and still finds it by search", async () => {
  const harness = createMockHarness();
  const opened: Array<string | null> = [];
  let found: string[] = [];
  let rememberedSeq = -1;
  harness.turns.runTurn = async (turn) => {
    if (turn.input.includes("recall")) {
      opened.push(await turn.tools.historyOpen(rememberedSeq));
      opened.push(await turn.tools.historyOpen(9_999));
      found = await turn.tools.history("ZEBRA-DELTA-42");
    }
    return { reply: "done" };
  };
  const { orchestrator, sessions } = buildOrchestrator({ harness });
  assert.equal((await orchestrator.handleTurn(dm("dm:U1:history-open", "remember ZEBRA-DELTA-42"))).status, "ok");
  const session = (await sessions.getByThread("dm:U1:history-open"))!;
  const { lease } = await sessions.acquireLease(session.id);
  const remembered = await sessions.append(lease!, { kind: "UserMessage", text: "remember ZEBRA-DELTA-42" });
  await sessions.releaseLease(lease!);
  rememberedSeq = remembered.seq;
  let fullReads = 0;
  const getItems = sessions.getItems.bind(sessions);
  sessions.getItems = async (...args) => {
    if (args[0] === session.id && args[1] === undefined) fullReads++;
    return getItems(...args);
  };
  const before = fullReads;
  assert.equal((await orchestrator.handleTurn(dm("dm:U1:history-open", "recall it"))).status, "ok");
  assert.match(opened[0] ?? "", /ZEBRA-DELTA-42/);
  assert.equal(opened[1], null, "an unknown seq opens nothing");
  assert.ok(found.some((hit) => hit.includes("ZEBRA-DELTA-42")));
  assert.equal(fullReads - before, 1, "only search reads the whole transcript");
});
