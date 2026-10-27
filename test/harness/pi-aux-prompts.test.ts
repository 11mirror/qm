import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDetectionPrompt, detectResult, renderDetectPrompt } from "../../src/harness/pi-aux-prompts.ts";
import { storedItem } from "../../src/sessions/items.ts";

test("detectResult replies only on a yes verdict", () => {
  assert.equal(detectResult({ ok: true, value: { verdict: "yes", reason: "no mention needed" } }, false).respond, true);
  assert.equal(
    detectResult({ ok: true, value: { verdict: "no", reason: "they said yes to each other" } }, false).respond,
    false,
  );
  const unrecognized = detectResult({ ok: false, text: "Maybe?" }, false);
  assert.equal(unrecognized.respond, false, "an answer outside the schema fails quiet");
  assert.equal(unrecognized.reason, "unrecognized verdict: Maybe?");
});

test("detectResult returns every reaction of a react verdict without replying", () => {
  const r = detectResult(
    { ok: true, value: { verdict: "react", reactions: ["pray", "🙏", "raised_hands", "tada"] } },
    true,
  );
  assert.equal(r.respond, false);
  assert.deepEqual(r.reactions, ["pray", "🙏", "raised_hands", "tada"]);
  assert.equal(detectResult({ ok: true, value: { verdict: "react" } }, true).reactions, undefined);
  const disabled = detectResult({ ok: true, value: { verdict: "react", reactions: ["pray"] } }, false);
  assert.equal(disabled.respond, false, "reactions disabled → react is not a yes");
  assert.equal(disabled.reactions, undefined);
});

test("renderDetectPrompt keeps the whole persona", () => {
  const persona = `Persona start. ${"x".repeat(5_000)} Only answer when named.`;
  const prompt = renderDetectPrompt({
    session: {} as never,
    message: "hi",
    recentContext: "",
    systemPrompt: persona,
    history: [],
    recordModelCall: () => {},
  });
  assert.ok(prompt.includes("Only answer when named."));
});

test("turn-detection prompt treats plain-text assistant handle + sensitive question as a reply", () => {
  const prompt = buildDetectionPrompt("Use :pray: for thanks.");
  assert.match(prompt, /plain-text assistant name\/handle/);
  assert.match(prompt, /"agent prod"/);
  assert.match(prompt, /Do NOT choose NO just because the topic is legal/);
});

test("turn-detection prompt says conversational flow can imply the assistant should answer", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /conversation flow/);
  assert.match(prompt, /no mention needed/);
  assert.match(prompt, /can you send the chart/);
});

test("turn-detection prompt treats implied assistant-target follow-ups as addressed", () => {
  const prompt = buildDetectionPrompt();
  assert.match(prompt, /implied target is the assistant/);
  assert.match(prompt, /even if the assistant is not explicitly mentioned/);
  assert.match(prompt, /what do you mean by that\?/);
  assert.match(prompt, /what is available now\?/);
  assert.match(prompt, /<@U123> what do you mean by that\?[^]*NO/);
});

test("renderDetectPrompt uses prior assistant replies, not assembled prior user prompts", () => {
  const prompt = renderDetectPrompt({
    session: {} as any,
    message: "yes, send it",
    recentContext: "carol: Can you send the chart?",
    systemPrompt: "You are Agent Prod.",
    history: [
      storedItem(
        {
          kind: "UserMessage",
          text: "## The conversation right now\nnoisy rendered Slack block\n\nCan you send the chart?",
        },
        { sessionId: "s", seq: 1, createdAt: 1 },
      ),
      storedItem(
        { kind: "AgentMessage", text: "I can send the chart if you share it again." },
        { sessionId: "s", seq: 2, createdAt: 2 },
      ),
    ],
    recordModelCall() {},
  });

  assert.match(prompt, /Your earlier replies in this thread/);
  assert.match(prompt, /I can send the chart if you share it again/);
  assert.doesNotMatch(prompt, /noisy rendered Slack block/);
  assert.match(prompt, /NEWEST message:\nyes, send it/);
});
