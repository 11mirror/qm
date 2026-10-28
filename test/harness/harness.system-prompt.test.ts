import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchestratorInput } from "../../src/core/orchestrator.ts";
import { createCronStore } from "../../src/cron/cron-store.ts";
import type { Sandbox } from "../../src/sandbox/sandbox.ts";
import { createSkillStore, type SkillStore } from "../../src/skills/skill-store.ts";
import { scopeId, type Conversation, type Principal, type ScopeId } from "../../src/types.ts";
import { testDatabaseUrl, testAdvisoryLock } from "../support/test-database.ts";
import { ORG, actor, fakeSandbox, readSandbox, buildOrchestrator, dm, slackDm } from "../support/system-prompt.ts";

test("system prompt is ordered cached-prefix → volatile tail, with memory LAST (after every other block)", async () => {
  const { orchestrator: orch, memory } = buildOrchestrator();

  await memory.capture(scopeId("personal", actor.id), ["my favorite color is chartreuse"], Date.now());

  let prompt = "";
  for (let i = 0; i < 200 && !/chartreuse/.test(prompt); i++) {
    await new Promise((r) => setTimeout(r, 10));
    const b = await orch.handleTurn(
      dm(`dm:U1:tB${i}`, "!sysprompt", {
        deliveryCandidates: [
          { target: "C1", label: "#general" },
          { target: "C2", label: "#random" },
        ],
      }),
    );
    assert.equal(b.status, "ok");
    prompt = b.reply ?? "";
  }

  const headingAt = (title: string): number => {
    const at = prompt.indexOf(`\n## ${title}\n`);
    assert.notEqual(at, -1, `expected block "## ${title}" to be present as its own heading`);
    return at;
  };

  const ordered = [
    "Where you are",
    "Where scheduled tasks post",
    "Sandbox environment profile",
    "Connected apps",
    "What you remember",
  ];
  assert.doesNotMatch(prompt, /\n## Your logins\n/);
  const positions = ordered.map((title) => ({ title, at: headingAt(title) }));
  positions.reduce((prev, cur) => {
    assert.ok(cur.at > prev.at, `"## ${cur.title}" must come AFTER "## ${prev.title}" (got ${cur.at} vs ${prev.at})`);
    return cur;
  });

  assert.ok(
    headingAt("What you remember") > headingAt("Connected apps"),
    "memory (## What you remember) must be appended AFTER ## Connected apps (most-volatile-last)",
  );
  assert.match(prompt, /chartreuse/);

  assert.match(prompt, /## System orientation/);
  assert.match(prompt, /sandbox files as cached, not durably saved/);
  assert.match(prompt, /\$AGENT_API_URL/);
});

test("Open carries only the live actor's personal reads into a shared turn and audits actual access", async () => {
  const teammate: Principal = { id: "U2", type: "internal" };
  const { orchestrator, config, workspace, files, auditLog } = buildOrchestrator({
    sandbox: readSandbox(),
    isCurrentSharedScopeMember: async (_principalId, sourceScope) => sourceScope === scopeId("channel", "C1"),
  });
  const personal = scopeId("personal", actor.id);
  const teammatePersonal = scopeId("personal", teammate.id);
  const channelScope = scopeId("channel", "C1");
  const put = (id: string, ownerScopeId: ScopeId, name: string, mimetype: string, data: Uint8Array | string) =>
    files.put({
      id,
      ownerScopeId,
      createdBy: actor.id,
      name,
      path: name,
      mimetype,
      data: Buffer.from(data),
      direction: "in",
    });
  const privateId = "1".repeat(32);
  const teammateId = "3".repeat(32);
  const binaryId = "4".repeat(32);
  await put(privateId, personal, "private.txt", "text/plain", "ACTOR_PRIVATE_FILE");
  await put(teammateId, teammatePersonal, "teammate.txt", "text/plain", "TEAMMATE_PRIVATE_FILE");
  await put(binaryId, personal, "private.bin", "application/octet-stream", new Uint8Array([255, 254, 0, 1]));
  const channel = (thread: string, text: string, origin: OrchestratorInput["origin"]): OrchestratorInput => ({
    surface: "test",
    actor,
    conversation: {
      kind: "channel",
      threadRef: thread,
      channelRef: "C1",
      audience: [actor, teammate],
      publishMembers: [actor, teammate],
    },
    text,
    origin,
  });

  const isolated = await orchestrator.handleTurn(channel("C1:isolated", "!sysprompt", { kind: "human" }));
  assert.doesNotMatch(isolated.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  const open = await orchestrator.handleTurn(
    channel("C1:open", `!read shared/open-personal-U1/${privateId}/private.txt`, { kind: "human" }),
  );
  assert.equal(open.reply, "ACTOR_PRIVATE_FILE");
  const binary = await orchestrator.handleTurn(
    channel("C1:binary", `!read shared/open-personal-U1/${binaryId}/private.bin`, { kind: "human" }),
  );
  assert.match(binary.reply ?? "", new RegExp(`Files ID ${binaryId}`));
  const teammateRead = await orchestrator.handleTurn(channel("C1:teammate", "!sysprompt", { kind: "human" }));
  assert.doesNotMatch(teammateRead.reply ?? "", /shared\/open-personal-U2\//);
  const nextActor = await orchestrator.handleTurn({
    ...channel("C1:open", `!read shared/open-personal-U1/${privateId}/private.txt`, { kind: "human" }),
    actor: teammate,
  });
  assert.doesNotMatch(nextActor.reply ?? "", /ACTOR_PRIVATE_FILE/);
  const nextActorOwn = await orchestrator.handleTurn({
    ...channel("C1:open", `!read shared/open-personal-U2/${teammateId}/teammate.txt`, { kind: "human" }),
    actor: teammate,
  });
  assert.equal(nextActorOwn.reply, "TEAMMATE_PRIVATE_FILE");

  const automated = await orchestrator.handleTurn(channel("C1:automation", "!sysprompt", { kind: "automation" }));
  assert.doesNotMatch(automated.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  const incompleteRoster = await orchestrator.handleTurn({
    ...channel("C1:incomplete", "!sysprompt", { kind: "human" }),
    conversation: {
      kind: "channel",
      threadRef: "C1:incomplete",
      channelRef: "C1",
      audience: [actor, teammate],
    },
  });
  assert.doesNotMatch(incompleteRoster.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  await config.setSetting("externalSlackParticipants", true, scopeId("org", ORG));
  const external = await orchestrator.handleTurn({
    surface: "slack",
    actor,
    conversation: {
      kind: "channel",
      threadRef: "C1:external",
      channelRef: "C1",
      audience: [actor, { id: "guest@example.com", type: "guest" }],
    },
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.equal(external.status, "ok");
  assert.doesNotMatch(external.reply ?? "", /shared\/open-personal-U1\/private\.txt/);
  assert.equal((await workspace.list(channelScope)).includes("private.txt"), false);
  const carryAudit = (await auditLog.events()).find((event) => event.action === "sharing.cross_context_read");
  assert.equal(carryAudit?.principalId, actor.id);
  assert.deepEqual(JSON.parse(carryAudit?.detail ?? "{}"), {
    actor: actor.id,
    source: personal,
    target: channelScope,
  });
});

test("Open advertises the source and audits a carried skill read without granting it to the room", async () => {
  const personal = scopeId("personal", actor.id);
  const skills = createSkillStore({ advisoryLock: testAdvisoryLock(), databaseUrl: testDatabaseUrl() });
  const skill = await skills.create({
    scopeId: personal,
    createdBy: actor.id,
    manifest: {
      name: "private-method",
      description: "Use a private working method",
      body: "Keep the method private.",
      requiredCapabilities: [],
    },
  });
  await skills.review(skill.id, actor.id, []);
  await skills.publish(skill.id);
  const { orchestrator, auditLog, acl } = buildOrchestrator({
    skills,
    isCurrentSharedScopeMember: async () => true,
  });
  const result = await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: {
      kind: "channel",
      threadRef: "C1:skill",
      channelRef: "C1",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.match(result.reply ?? "", /Additional skill sources: personal:U1/);
  assert.doesNotMatch(result.reply ?? "", /private-method|Use a private working method/);
  const read = await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: {
      kind: "channel",
      threadRef: "C1:skill",
      channelRef: "C1",
      audience: [actor],
      publishMembers: [actor],
    },
    text: "!skill private-method",
    origin: { kind: "human" },
  });
  assert.equal(read.status, "ok", read.reason);
  assert.equal(read.reply, "Keep the method private.");
  const event = (await auditLog.events()).find(
    (candidate) => candidate.action === "sharing.cross_context_read" && candidate.resource === `skill:${skill.id}`,
  );
  assert.deepEqual(JSON.parse(event?.detail ?? "{}"), {
    actor: actor.id,
    source: personal,
    target: scopeId("channel", "C1"),
  });
  assert.deepEqual(await acl.list(), []);
});

test("Open keeps unclassified personal memory out of rooms, loads room memory in DMs, and capture stays in the room", async () => {
  let member = true;
  const { orchestrator, memory, files } = buildOrchestrator({
    sandbox: readSandbox(),
    isCurrentSharedScopeMember: async (principalId, sourceScope) =>
      member && principalId === actor.id && sourceScope === scopeId("channel", "C1"),
  });
  const personal = scopeId("personal", actor.id);
  const channelScope = scopeId("channel", "C1");
  await memory.capture(personal, ["PERSONAL_OPEN_MEMORY"], Date.now(), actor.id);
  const channelConversation: Conversation = {
    kind: "channel",
    threadRef: "C1:memory",
    channelRef: "C1",
    audience: [actor],
    publishMembers: [actor],
  };
  const prompt = await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: channelConversation,
    text: "!sysprompt",
    origin: { kind: "human" },
  });
  assert.doesNotMatch(prompt.reply ?? "", /Sharing posture: Open/);
  assert.doesNotMatch(prompt.reply ?? "", /PERSONAL_OPEN_MEMORY/);

  await orchestrator.handleTurn({
    surface: "test",
    actor,
    conversation: { ...channelConversation, threadRef: "C1:capture" },
    text: "!memoryremember ROOM_ONLY_MEMORY",
    origin: { kind: "human" },
  });
  assert.match(await memory.read(channelScope), /ROOM_ONLY_MEMORY/);
  assert.doesNotMatch(await memory.read(personal), /ROOM_ONLY_MEMORY/);

  const search = await orchestrator.handleTurn(
    dm("dm:U1:open-search", "!memorysearch ROOM_ONLY_MEMORY", {
      origin: { kind: "human" },
    }),
  );
  assert.match(search.reply ?? "", /\[channel:C1\].*ROOM_ONLY_MEMORY/);
  const decisionId = "5".repeat(32);
  await files.put({
    id: decisionId,
    ownerScopeId: channelScope,
    createdBy: actor.id,
    name: "decision.txt",
    path: "decision.txt",
    mimetype: "text/plain",
    data: Buffer.from("ROOM_DECISION_FILE"),
    direction: "in",
  });
  const sharedFile = await orchestrator.handleTurn(
    dm("dm:U1:room-file", `!read shared/open-channel-C1/${decisionId}/decision.txt`, { origin: { kind: "human" } }),
  );
  assert.equal(sharedFile.reply, "ROOM_DECISION_FILE");

  const dmPrompt = await orchestrator.handleTurn(
    dm("dm:U1:search-only", "!sysprompt", {
      origin: { kind: "human" },
    }),
  );
  assert.match(dmPrompt.reply ?? "", /### channel:C1[\s\S]*ROOM_ONLY_MEMORY/);
  assert.match(dmPrompt.reply ?? "", /use these authorized memories freely/);
  assert.doesNotMatch(dmPrompt.reply ?? "", /apply it only if that tag matches here/);

  member = false;
  const revoked = await orchestrator.handleTurn(
    dm("dm:U1:revoked", "!memorysearch ROOM_ONLY_MEMORY", {
      origin: { kind: "human" },
    }),
  );
  assert.doesNotMatch(revoked.reply ?? "", /ROOM_ONLY_MEMORY/);
  const revokedFile = await orchestrator.handleTurn(
    dm("dm:U1:room-file", `!read shared/open-channel-C1/${decisionId}/decision.txt`, { origin: { kind: "human" } }),
  );
  assert.doesNotMatch(revokedFile.reply ?? "", /ROOM_DECISION_FILE/);
});

test("the system prompt is byte-identical across two turns a minute apart; the clock rides the environment note", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { orchestrator: orch } = buildOrchestrator();

  const turn = (): OrchestratorInput =>
    dm("dm:U1:cache-stable", "!sysprompt", {
      timezone: "America/New_York",
      deliveryCandidates: [
        { target: "C1", label: "#general" },
        { target: "C2", label: "#random" },
      ],
    });
  const systemOf = (reply: string): string => reply.split("\n\n<environment>")[0]!;
  const environmentOf = (reply: string): string => reply.slice(systemOf(reply).length);

  const first = await orch.handleTurn(turn());
  t.mock.timers.tick(61_000);
  const second = await orch.handleTurn(turn());
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");

  for (const title of ["Skills", "Where you are", "Where scheduled tasks post", "Connected apps"]) {
    assert.ok(
      environmentOf(first.reply ?? "").includes(`\n## ${title}\n`),
      `expected "## ${title}" in the first environment`,
    );
    assert.ok(
      !environmentOf(second.reply ?? "").includes(`\n## ${title}\n`),
      `unchanged "## ${title}" must not repeat`,
    );
    assert.ok(!systemOf(first.reply ?? "").includes(`\n## ${title}\n`));
  }
  for (const title of ["Sandbox environment profile", "The user's local time", "What you remember", "Your logins"]) {
    assert.ok(
      !systemOf(first.reply ?? "").includes(`\n## ${title}\n`),
      `"## ${title}" must not be in the system prompt`,
    );
  }
  assert.match(environmentOf(first.reply ?? ""), /## The user's local time/);
  assert.notEqual(environmentOf(second.reply ?? ""), environmentOf(first.reply ?? ""), "the clock moved a minute");
  assert.equal(
    systemOf(second.reply ?? ""),
    systemOf(first.reply ?? ""),
    "the system prompt must be byte-identical across turns or every cached message block behind it is invalidated",
  );
});

test("the cached prefix survives skill-store reordering + a recordUse-style metadata update", async () => {
  const mkSkill = (name: string, lastUsedAt?: number) => ({
    skill: { manifest: { name, description: `does ${name}` }, lastUsedAt },
    shadowed: [],
  });
  let visible = [mkSkill("alpha"), mkSkill("midway"), mkSkill("zeta")];
  const churningSkills = { visibleFor: async () => [...visible] } as unknown as SkillStore;
  const { orchestrator: orch } = buildOrchestrator({ skills: churningSkills });

  const prefixOf = (prompt: string): string => prompt.split("\n\n<environment>")[0]!;
  const turn = () => dm("dm:U1:skill-order", "!sysprompt", { timezone: "America/New_York" });

  const first = await orch.handleTurn(turn());
  assert.equal(first.status, "ok");

  visible = [mkSkill("zeta", Date.now()), mkSkill("alpha"), mkSkill("midway")];
  const second = await orch.handleTurn(turn());
  assert.equal(second.status, "ok");

  const prefixA = prefixOf(first.reply ?? "");
  assert.ok(
    first.reply!.includes("**alpha**") && first.reply!.includes("**zeta**"),
    "skills render in the initial environment",
  );
  assert.doesNotMatch(second.reply!, /\*\*alpha\*\*|\*\*zeta\*\*/);
  assert.equal(
    prefixOf(second.reply ?? ""),
    prefixA,
    "a store-order shuffle + lastUsedAt update must not change a byte of the cached prefix",
  );
});

test("standing obligations: this scope's pending triggers render; other scopes' and immediate one-shots don't", async () => {
  const crons = createCronStore(testDatabaseUrl());
  const base = { owner: actor.id, createdBy: actor.id, ownerScopeId: scopeId("personal", actor.id) };
  await crons.create({
    ...base,
    schedule: { everyMs: 300_000 },
    title: "Vendor status",
    action: "poll the vendor status page",
  });
  await crons.create({
    ...base,
    schedule: { firstFireAt: Date.now() + 86_400_000 },
    title: "Legal follow-up",
    action: "follow up with legal",
  });
  await crons.create({ ...base, schedule: { firstFireAt: Date.now() - 1000 }, message: "hi alice" });
  await crons.create({
    ...base,
    ownerScopeId: scopeId("channel", "C9"),
    schedule: { everyMs: 300_000 },
    action: "channel-only digest",
  });

  const { orchestrator: orch } = buildOrchestrator({ crons });
  const b = await orch.handleTurn(dm("dm:U1:obl", "!sysprompt"));
  assert.equal(b.status, "ok");
  const prompt = b.reply ?? "";

  assert.match(prompt, /schedule the wake-up in the same turn/);
  assert.match(prompt, /\n## Already scheduled here\n/);
  assert.match(prompt, /Vendor status — every 5 minutes/);
  assert.match(prompt, /Legal follow-up — once at/);
  assert.doesNotMatch(prompt, /poll the vendor status page|follow up with legal/);
  assert.doesNotMatch(prompt, /hi alice/);
  assert.doesNotMatch(prompt, /channel-only digest/);
});

test("'Sandbox environment profile' renders the substrate profile's spec; no resize menu renders", async () => {
  const sized: Sandbox = {
    ...fakeSandbox(),
    profile: {
      ...fakeSandbox().profile,
      spec: { ...fakeSandbox().profile.spec, cpus: 4, memoryMb: 8192 },
    },
  };
  const b = await buildOrchestrator({ sandbox: sized }).orchestrator.handleTurn(dm("dm:U1:rz1", "!sysprompt"));
  assert.equal(b.status, "ok");
  const prompt = b.reply ?? "";
  assert.doesNotMatch(prompt, /## Resizing this computer/);
  assert.match(prompt, /4 vCPU \/ 8 GB RAM/, "the This-machine block shows the profile spec");
});

test("Slack turns get the terse-response style instruction; other surfaces do not", async () => {
  const { orchestrator: orch } = buildOrchestrator();

  const slack = await orch.handleTurn(slackDm("dm:U1:slack-style", "!sysprompt"));
  assert.equal(slack.status, "ok");
  assert.doesNotMatch(slack.reply ?? "", /## Talking on Slack/);
  assert.match(slack.reply ?? "", /This is Slack: keep each reply to a couple of sentences/);

  const nonSlack = await orch.handleTurn(dm("dm:U1:non-slack-style", "!sysprompt"));
  assert.equal(nonSlack.status, "ok");
  assert.doesNotMatch(nonSlack.reply ?? "", /## Talking on Slack/);
  assert.doesNotMatch(nonSlack.reply ?? "", /a couple of sentences/);
});
test("a project session names its linked Slack home channel; unlinked projects get no block", async () => {
  const managedGroups = {
    recognizes: (ref: string) => ref.startsWith("web-project-"),
    membership: async () => true,
    members: async () => [actor.id],
    version: async () => "1",
    name: async () => "Proj",
    withVersion: async <T>(_ref: string, _version: string | undefined, fn: () => Promise<T>) => fn(),
    slackChannel: async (ref: string) =>
      ref === "web-project-linked" ? { channelId: "C-ENG", channelName: "eng" } : undefined,
  };
  const { orchestrator: orch } = buildOrchestrator({ managedGroups });

  const group = (ref: string, thread: string): OrchestratorInput => ({
    surface: "test",
    actor,
    conversation: {
      kind: "group",
      threadRef: thread,
      channelRef: ref,
      channelName: "Proj",
      audience: [actor],
    } as Conversation,
    text: "!sysprompt",
    scopeVersion: "1",
    sessionParticipantIds: [actor.id],
    origin: { kind: "direct" },
  });

  const linked = await orch.handleTurn(group("web-project-linked", "grp:linked:1"));
  assert.equal(linked.status, "ok", `refused: ${(linked as { reason?: string }).reason}`);
  const prompt = linked.reply ?? "";
  assert.match(prompt, /## Project home channel/);
  assert.match(prompt, /#eng/);
  assert.match(prompt, /channel: "eng"/);

  const unlinked = await orch.handleTurn(group("web-project-bare", "grp:bare:1"));
  assert.equal(unlinked.status, "ok");
  assert.ok(!(unlinked.reply ?? "").includes("## Project home channel"));
});

for (const mode of ["off", "writable", "skip"] as const) {
  test(`Open respects memory ${mode}`, async () => {
    const { orchestrator, memory } = buildOrchestrator({
      sandbox: readSandbox(),
      memoryPolicy: { recall: mode === "skip" ? "visible" : mode, capture: "off" },
      isCurrentSharedScopeMember: async () => true,
    });
    await memory.capture(scopeId("personal", actor.id), ["DO_NOT_RECALL_PRIVATE_NOTE"], Date.now(), actor.id);
    for (const text of [
      "!sysprompt",
      "!memorysearch DO_NOT_RECALL_PRIVATE_NOTE",
      "!read shared/open-personal-U1/memory/MEMORY.md",
    ]) {
      const result = await orchestrator.handleTurn({
        surface: "test",
        actor,
        conversation: {
          kind: "channel",
          channelRef: "C1",
          threadRef: `C1:disabled:${mode}:${text}`,
          audience: [actor],
          publishMembers: [actor],
        },
        origin: { kind: "human" },
        text,
        ...(mode === "skip" ? { skipMemory: true } : {}),
      });
      assert.doesNotMatch(result.reply ?? "", /DO_NOT_RECALL_PRIVATE_NOTE/);
    }
  });
}
