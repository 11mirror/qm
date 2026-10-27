import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTestApp } from "../support/test-app.ts";
import { testConfig } from "../support/test-config.ts";
import { settle } from "../support/settle.ts";
import { quietRuns } from "../support/turns.ts";
import { setChannelInstructions } from "../support/channel-instructions.ts";
import { listFull, freshApp, judged } from "../support/ambient-app.ts";

test("ingest → ambient judge engages → spawns a smart-model worker that posts to the container", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C1";
    await setChannelInstructions(built, container, "!engage !post ambient reply", "U-admin");

    await built.app.ingestSurfaceEvents([
      { container, ts: "100.1", authorId: "U1", text: "did the Q3 launch slip?", createdAt: 1 },
    ]);

    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "the spawned worker posted exactly once");
    assert.match(pending[0]!.text, /^ambient reply/);
    assert.equal(pending[0]!.destination.target, container, "a plain post lands top-level in the container");
    const worker = await built.sessions.getByThread(`slack:${container}:ambient:100.1`);
    assert.ok(worker);
  } finally {
    await built.runtime.stop();
  }
});

test("unaddressed chatter with no standing orders stays silent (silence is the default)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    await built.app.ingestSurfaceEvents([
      { container: "C-quiet", ts: "1.0", authorId: "U1", text: "lunch anyone?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", "C-quiet");
    assert.equal(decision.act, false);
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 0, "idle chatter produces no proactive post");
  } finally {
    await built.runtime.stop();
  }
});

test("ambientEnabled=false gates the judge: engage-orders channel stays silent until re-enabled", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-off";
    await setChannelInstructions(
      built,
      container,
      "!engage !post ambient reply",
      "U-admin",
      undefined,
      undefined,
      false,
    );
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(decision.act, false, "the judge never runs in a switched-off channel");
    await quietRuns(built);
    assert.equal(((await built.posts.pending("slack")) as any[]).length, 0, "no proactive post");
    await setChannelInstructions(
      built,
      container,
      "!engage !post ambient reply",
      "U-admin",
      undefined,
      undefined,
      true,
    );
    const replay = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(replay.act, false, "messages overheard while off are not replayed");
    await built.app.ingestSurfaceEvents([{ container, ts: "2.0", authorId: "U1", text: "any update?", createdAt: 2 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "fresh messages engage again after re-enabling");
  } finally {
    await built.runtime.stop();
  }
});

test("default rule: standing orders opt the room into ambient, regardless of size", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-big";
    await setChannelInstructions(built, container, "!engage !post ambient reply", "U-admin");
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "U1",
        text: "did the launch slip?",
        createdAt: 1,
        members: Array.from({ length: 9 }, (_, i) => `U${i + 1}`),
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "a room with standing orders is watched whatever its size");
    assert.match(pending[0]!.text, /^ambient reply/);
  } finally {
    await built.runtime.stop();
  }
});

test("default rule: an action-mode bot entry opts the room in, with no standing orders", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-actionbot";
    await setChannelInstructions(built, container, "", "U-admin", { deploybot: { mode: "action" } });
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "B1",
        authorName: "deploybot",
        bot: true,
        text: "deploy failed !engage !post fixing it",
        createdAt: 1,
      },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "an action-bot trigger engages without standing orders");
    assert.match(pending[0]!.text, /^fixing it/);
  } finally {
    await built.runtime.stop();
  }
});

test("org-wide ambient switch off silences every channel regardless of per-channel settings", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-orgoff";
    await setChannelInstructions(
      built,
      container,
      "!engage !post ambient reply",
      "U-admin",
      undefined,
      undefined,
      true,
    );
    await built.config.setSetting("orgAmbient", false);
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "did the launch slip?", createdAt: 1 },
    ]);
    const decision = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(decision.act, false, "the org switch wins over an explicit per-channel on");
    await quietRuns(built);
    assert.equal(((await built.posts.pending("slack")) as any[]).length, 0);
    await built.config.setSetting("orgAmbient", true);
    await built.app.ingestSurfaceEvents([{ container, ts: "2.0", authorId: "U1", text: "any update?", createdAt: 2 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1, "flipping the org switch back on restores ambient");
  } finally {
    await built.runtime.stop();
  }
});

test("no standing orders → an informal address does NOT engage (mention-only default)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-addr";
    await built.app.ingestSurfaceEvents([
      {
        container,
        ts: "1.0",
        authorId: "U1",
        text: "hey can you help with the launch? !engage !post on it",
        createdAt: 1,
      },
    ]);
    await settle(async () => (await built.ambientJudgments!.list({ scope: container })).length > 0);
    assert.equal(((await built.posts.pending("slack")) as any[]).length, 0, "an unwatched room is mention-only");
    const rows = await built.ambientJudgments!.list({ scope: container });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, "ignore");
    assert.match(rows[0]!.reason ?? "", /defaults off/);
    const replay = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(replay.act, false);
  } finally {
    await built.runtime.stop();
  }
});

test("a formal @mention WITH content is left to the mention turn path (excluded from ambient)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-dedup";
    await built.app.ingestSurfaceEvents(
      [
        {
          container,
          ts: "1.0",
          authorId: "U1",
          text: "@bot please help !engage !post hi",
          mentionsSelf: true,
          createdAt: 1,
        },
      ],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 0, "no second, top-level ambient reply for a formal mention+content");
  } finally {
    await built.runtime.stop();
  }
});

test("a BARE @mention is ALSO owned by the direct dispatch path, so the ambient judge excludes it", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-bare";
    await setChannelInstructions(built, container, "!engage !post here", "U-admin");
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "1.0", authorId: "U1", text: "@bot", mentionsSelf: true, createdAt: 1 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 0, "the direct path owns the mention; the ambient judge does not double-reply");
  } finally {
    await built.runtime.stop();
  }
});

test("a message the direct path owns (ingested handled) is excluded from the ambient judge", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-owned";
    await setChannelInstructions(built, container, "!engage !post here", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "U1", text: "following up on the thread", handled: true, createdAt: 1 },
    ]);
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 0, "a born-handled message is owned by the direct path, never the judge");

    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorId: "U1", text: "following up on the thread", createdAt: 2 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending2 = await built.posts.pending("slack");
    assert.equal(pending2.length, 1, "an un-owned message still engages the judge");
  } finally {
    await built.runtime.stop();
  }
});

test("a message that @mentions ANOTHER person (not the bot) is judged normally, never excluded", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-other";
    await setChannelInstructions(built, container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "1.0", authorId: "U1", text: "@jordan can you send those emails?", createdAt: 1 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await settle(async () =>
      (await listFull(built.ambientJudgments!, { scope: container })).some(
        (r: any) => r.decision === "ignore" && r.prompt,
      ),
    );
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.ok(
      rows.some((r: any) => r.decision === "ignore" && r.prompt),
      "the other-person mention was judged, not excluded",
    );
    assert.ok(!rows.some((r: any) => r.decision === "fastlane"), "it is not treated as a formal self-mention");
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 0, "and with no engaging order, nothing is posted");
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient watermark advances so a batch is judged once, not re-judged every tick", async () => {
  const built = freshApp();
  try {
    const container = "C-once";
    await setChannelInstructions(built, container, "flag launch talk", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "1.0", authorId: "U1", text: "not a match", createdAt: 1 }]);
    await built.app.judgeAmbientContainer("slack", container);
    const again = await built.app.judgeAmbientContainer("slack", container);
    assert.equal(again.act, false, "an already-judged batch is not re-judged into acting");
  } finally {
    await built.runtime.stop();
  }
});

test("a judge failure leaves the batch unjudged so the next pass judges it again", async () => {
  const built = freshApp();
  try {
    const container = "C-judge-down";
    await setChannelInstructions(built, container, "flag launch talk", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "1.0", authorId: "U1", text: "!judge-down", createdAt: 1 }]);
    assert.equal((await built.app.judgeAmbientContainer("slack", container)).act, false);
    assert.deepEqual(
      await built.ambientJudgments!.list({ scope: container }),
      [],
      "a failed judge records no judgment",
    );
    await built.app.ingestSurfaceEvents([{ container, ts: "1.0", authorId: "U1", text: "launch moved", createdAt: 1 }]);
    await built.app.judgeAmbientContainer("slack", container);
    const rows = await built.ambientJudgments!.list({ scope: container });
    assert.ok(rows.length > 0, "the batch the failed judge skipped is judged on the next pass");
    assert.ok(rows.every((r: { decision: string; tsFrom?: string }) => r.decision === "ignore" && r.tsFrom === "1.0"));
  } finally {
    await built.runtime.stop();
  }
});

test("a backlog longer than one judge window is judged oldest-first, not skipped", async () => {
  const built = freshApp();
  try {
    const container = "C-backlog";
    await setChannelInstructions(built, container, "flag launch talk", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "1000.000", authorId: "U1", text: "hello", createdAt: 1 }]);
    await built.app.judgeAmbientContainer("slack", container);
    const ts = (i: number) => `${2000 + i}.000`;
    await built.app.ingestSurfaceEvents(
      Array.from({ length: 70 }, (_, i) => ({
        container,
        ts: ts(i),
        authorId: "U1",
        text: `note ${i}`,
        createdAt: 2 + i,
      })),
    );
    await built.app.judgeAmbientContainer("slack", container);
    await built.app.judgeAmbientContainer("slack", container);
    let rows: Array<{ tsFrom?: string; tsTo?: string }> = [];
    for (let i = 0; i < 50; i++) {
      rows = await built.ambientJudgments!.list({ scope: container });
      if (rows.some((r) => r.tsFrom === ts(0)) && rows.some((r) => r.tsTo === ts(69))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      rows.some((r) => r.tsFrom === ts(0)),
      "the oldest message after the cursor is judged even when more than 60 arrived",
    );
    assert.ok(
      rows.some((r) => r.tsTo === ts(69)),
      "a later pass reaches the newest message",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("mirror read interface: ingest is queryable by search + readMessages", async () => {
  const built = freshApp();
  try {
    await built.app.ingestSurfaceEvents([
      { container: "C1", ts: "1.0", authorId: "U1", text: "the deploy is green", createdAt: 1 },
      { container: "C1", ts: "2.0", authorId: "U2", sub: "T1", text: "thread reply about the deploy", createdAt: 2 },
    ]);
    const found = await built.app.searchSurface("deploy");
    assert.equal(found.length, 2, "both messages match the search");
    const msgs = await built.app.readSurfaceMessages("C1");
    assert.equal(msgs.length, 2);
  } finally {
    await built.runtime.stop();
  }
});

test("the worker DECIDES where to post: a thread_ts roots the reply under the message it chose", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-choose";
    await setChannelInstructions(built, container, "!engage !postthread 200.1 ahoy matey", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "200.1", authorId: "U1", text: "a fresh tweet link", createdAt: 1 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const pending = await built.posts.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.destination.target, `${container}:200.1`, "reply threaded exactly where the agent chose");
    assert.match(pending[0]!.text, /^ahoy matey/);
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient wake prompt is structured XML (<wake>/<message trigger>), untrusted body escaped", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-xml";
    await setChannelInstructions(built, container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "300.1", authorId: "U1", authorName: "Ann", text: "check <https://x.com/foo>", createdAt: 1 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const sub = await built.sessions.getByThread(`slack:${container}:ambient:300.1`);
    assert.ok(sub, "the ambient worker session exists");
    const items = await built.sessions.getItems(sub!.id);
    const wake = items.find((i) => i.kind === "UserMessage" && typeof i.text === "string")?.text as string;
    assert.ok(wake, "the worker's wake prompt was recorded");
    assert.match(wake, /^<wake reason="ambient" surface="slack" channel="C-xml"/);
    assert.match(wake, /<message [^>]*id="300\.1"[^>]*trigger="true"[^>]*>/);
    assert.match(wake, /check &lt;https:\/\/x\.com\/foo&gt;/);
  } finally {
    await built.runtime.stop();
  }
});

test("ambient judge: backdrop renders before NEW MESSAGES, absent on the first judgment (§2.1)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-bd";
    await setChannelInstructions(built, container, "watch this channel", "U-admin");
    await built.app.ingestSurfaceEvents([
      { container, ts: "1.0", authorId: "Alice", text: "first message", createdAt: 1 },
    ]);
    await built.app.judgeAmbientContainer("slack", container);
    await built.app.ingestSurfaceEvents([
      { container, ts: "2.0", authorId: "Bob", text: "second message", createdAt: 2 },
    ]);
    await built.app.judgeAmbientContainer("slack", container);
    const rows = await judged(
      built.ambientJudgments!,
      container,
      (rows) =>
        rows.some((r: any) => r.prompt?.includes("second message")) &&
        rows.some((r: any) => r.prompt?.includes("first message") && !r.prompt?.includes("second message")),
    );
    const second = rows.find((r: any) => r.prompt?.includes("second message"))!;
    const first = rows.find((r: any) => r.prompt?.includes("first message") && !r.prompt?.includes("second message"))!;
    assert.ok(first && !first.prompt!.includes("EARLIER CONTEXT"), "the first judgment has no backdrop");
    assert.ok(second.prompt!.includes("EARLIER CONTEXT"), "the second judgment shows the backdrop section");
    assert.ok(
      second.prompt!.indexOf("EARLIER CONTEXT") < second.prompt!.indexOf("NEW MESSAGES"),
      "backdrop is rendered before NEW MESSAGES",
    );
    assert.ok(second.prompt!.includes("Alice: first message"), "the earlier message is the backdrop");
  } finally {
    await built.runtime.stop();
  }
});

test("ambient judge: backdrop is capped at the last 10 (§2.1)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-bdcap";
    await setChannelInstructions(built, container, "watch", "U-admin");
    await built.app.ingestSurfaceEvents(
      Array.from({ length: 12 }, (_v, i) => ({
        container,
        ts: `${1000 + i}.0`,
        authorId: `U${i + 1}`,
        text: `m${i + 1}`,
        createdAt: i + 1,
      })),
    );
    await settle(async () => (await built.ambientJudgments!.list({ scope: container })).length > 0);
    await built.app.ingestSurfaceEvents([{ container, ts: "1013.0", authorId: "U13", text: "m13", createdAt: 13 }]);
    await settle(async () =>
      (await listFull(built.ambientJudgments!, { scope: container })).some(
        (r: any) => r.prompt?.includes("m13") && r.prompt?.includes("EARLIER CONTEXT"),
      ),
    );
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    const last = rows.find((r: any) => r.prompt?.includes("m13") && r.prompt?.includes("EARLIER CONTEXT"))!;
    const backdrop = last.prompt!.slice(last.prompt!.indexOf("EARLIER CONTEXT"), last.prompt!.indexOf("NEW MESSAGES"));
    const backdropCount = (backdrop.match(/^U\d+: m\d+$/gm) ?? []).length;
    assert.equal(backdropCount, 10, "backdrop capped at the last 10");
    assert.ok(!/: m1$/m.test(backdrop) && !/: m2$/m.test(backdrop), "the oldest messages fell off the cap");
  } finally {
    await built.runtime.stop();
  }
});

test("a judged batch records a durable judgment row: prompt, decision, model, ts range (§2.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-row";
    await setChannelInstructions(built, container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.decision, "act");
    assert.ok(rows[0]!.prompt && rows[0]!.prompt.includes("NEW MESSAGES"));
    assert.equal(rows[0]!.model, "claude-haiku-5-5", "the resolved judge model is recorded (default Haiku)");
    assert.equal(rows[0]!.tsFrom, "5.0");
    assert.equal(rows[0]!.tsTo, "5.0");
    assert.ok(typeof rows[0]!.latencyMs === "number");
  } finally {
    await built.runtime.stop();
  }
});

test("the ambient judge model is independent of the detect model (PI_JUDGE_MODEL)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildTestApp(
    testConfig({ dataDir, detectModelId: "claude-opus-4-8", judgeModelId: "claude-sonnet-5" }),
  );
  built.runtime.start();
  try {
    const container = "C-judgemodel";
    await setChannelInstructions(built, container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.model, "claude-sonnet-5", "the judge model is recorded, not the detect model");
  } finally {
    await built.runtime.stop();
  }
});

test("an OpenAI-only deployment judges with an OpenAI auxiliary model, not Haiku", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildTestApp(testConfig({ dataDir, modelId: "gpt-5.6-sol", openaiApiKey: "sk-openai-test" }));
  built.runtime.start();
  try {
    const container = "C-openai-judge";
    await setChannelInstructions(built, container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(rows[0]!.model, "gpt-5.6-luna", "the auxiliary follows the configured base model's provider");
  } finally {
    await built.runtime.stop();
  }
});

test("an admin-set org base model drives the auxiliary, not just the PI_MODEL env", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-surfcache-"));
  const built = buildTestApp(testConfig({ dataDir, openaiApiKey: "sk-openai-test" }));
  await built.config.setRuntimeSelection("org:default-org", { modelId: "gpt-5.6-sol" });
  built.runtime.start();
  try {
    const container = "C-admin-base";
    await setChannelInstructions(built, container, "!engage !post ahoy", "U-admin");
    await built.app.ingestSurfaceEvents([{ container, ts: "5.0", authorId: "U1", text: "need help", createdAt: 5 }]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.equal(rows.length, 1, "one row for the judged batch");
    assert.equal(
      rows[0]!.model,
      "gpt-5.6-luna",
      "onboarding through the admin UI, not PI_MODEL, still moves the auxiliary",
    );
  } finally {
    await built.runtime.stop();
  }
});

test("a formal-mention fastlane records a fastlane row (§2.2)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-fast";
    await setChannelInstructions(built, container, "", "U-admin", undefined, undefined, true);
    await built.app.ingestSurfaceEvents(
      [{ container, ts: "6.0", authorId: "U1", text: "@bot please help", mentionsSelf: true, createdAt: 6 }],
      "slack",
      { name: "bot", mentionId: "UBOT" },
    );
    await settle(async () =>
      (await listFull(built.ambientJudgments!, { scope: container })).some((r: any) => r.decision === "fastlane"),
    );
    const rows = await listFull(built.ambientJudgments!, { scope: container });
    assert.ok(
      rows.some((r: any) => r.decision === "fastlane"),
      "the mention-routed batch recorded a fastlane row",
    );
    assert.ok(!rows.some((r: any) => r.decision === "fastlane" && r.prompt), "a fastlane row carries no prompt");
  } finally {
    await built.runtime.stop();
  }
});

test("worker seed is the trigger plus the 3 messages before it (§2.4)", async () => {
  const built = freshApp();
  built.runtime.start();
  try {
    const container = "C-seed";
    await setChannelInstructions(built, container, "watch", "U-admin");
    await built.app.ingestSurfaceEvents([
      ...Array.from({ length: 5 }, (_v, i) => ({
        container,
        ts: `40${i + 1}.0`,
        authorId: `U${i + 1}`,
        text: `msg ${i + 1}`,
        createdAt: i + 1,
      })),
      { container, ts: "406.0", authorId: "U6", text: "trigger !engage !post reply", createdAt: 6 },
    ]);
    await built.posts.waitFor((post) => post.destination.type === "slack");
    await quietRuns(built);
    const sub = await built.sessions.getByThread(`slack:${container}:ambient:406.0`);
    assert.ok(sub, "the ambient worker session exists");
    const items = await built.sessions.getItems(sub!.id);
    const wake = items.find((i) => i.kind === "UserMessage" && typeof i.text === "string")?.text as string;
    assert.ok(wake.includes(`id="406.0"`) && wake.includes(`id="403.0"`), "the trigger and the 3 before it are seeded");
    assert.ok(!wake.includes(`id="402.0"`), "the 4th-back message is not seeded (seed is trigger + 3)");
    assert.ok(
      wake.includes("read_thread") && wake.includes("search"),
      "the instructions point at read_thread/search for more context",
    );
  } finally {
    await built.runtime.stop();
  }
});
