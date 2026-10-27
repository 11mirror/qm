import { test } from "node:test";
import assert from "node:assert/strict";
import {
  postWithVerify,
  SLACK_POST_SPLIT_LIMIT,
  recoveryVerifyOldest,
  statusPlaceholderKey,
} from "../../src/slack/delivery.ts";
import { createSlackSender } from "../../src/slack/sender.ts";

function verifyHarness(
  opts: {
    postResults?: Array<{ ok?: { ts?: string; channel?: string }; err?: unknown }>;
    historyMessages?: unknown[];
    historyThrows?: boolean;
  } = {},
) {
  const results = opts.postResults ?? [{ ok: { ts: "1.1", channel: "C1" } }];
  let postCall = 0;
  const postArgs: any[] = [];
  let historyArgs: any;
  let repliesArgs: any;
  const scan = async () => {
    if (opts.historyThrows) throw new Error("history read failed");
    return { messages: opts.historyMessages ?? [] };
  };
  const client = {
    chat: {
      postMessage: async (args: any) => {
        postArgs.push(args);
        const r = results[Math.min(postCall, results.length - 1)]!;
        postCall++;
        if (r.err) throw r.err;
        return r.ok;
      },
    },
    conversations: {
      history: async (args: any) => {
        historyArgs = args;
        return scan();
      },
      replies: async (args: any) => {
        repliesArgs = args;
        return scan();
      },
    },
  } as any;
  return {
    client,
    postArgs,
    get postCalls() {
      return postArgs.length;
    },
    get historyCalled() {
      return historyArgs !== undefined;
    },
    get repliesCalled() {
      return repliesArgs !== undefined;
    },
  };
}

const KEY = "run:abc";
const foundMsg = { ts: "9.9", metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: KEY } } };

test("postWithVerify: posts once and returns ts on success", async () => {
  const h = verifyHarness();
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "1.1", channel: "C1" });
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false, "no verify on a clean success");
});

test("postWithVerify: stamps metadata with the idempotency key", async () => {
  const h = verifyHarness();
  await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(h.postArgs[0].metadata, {
    event_type: "qm_delivery",
    event_payload: { idempotency_key: KEY },
  });
});

test("postWithVerify: platform error rethrows without retry", async () => {
  const err = { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } };
  const h = verifyHarness({ postResults: [{ err }] });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1);
  assert.equal(h.historyCalled, false);
});

test("postWithVerify: rate limit waits, verifies (the claim may have lapsed), then re-posts", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_rate_limited_error", retryAfter: 0 } },
      { ok: { ts: "2.2", channel: "C1" } },
    ],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "2.2");
  assert.equal(h.postCalls, 2);
  assert.equal(h.historyCalled, true, "the 429 wait may outlive our delivery claim — check for a sibling's post");
});

test("postWithVerify: rate limit wait finds a sibling relay's post and reuses it", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_rate_limited_error", retryAfter: 0 } }],
    historyMessages: [foundMsg],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "9.9", channel: "C1", reused: true });
  assert.equal(h.postCalls, 1, "never re-posts over a sibling's landed message");
});

test("postWithVerify: ambiguous error + message found on verify returns existing ts, no re-post", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.deepEqual(res, { ts: "9.9", channel: "C1" });
  assert.equal(h.postCalls, 1, "the post landed — never re-sent");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: recovery preflight returns an existing keyed post without posting again", async () => {
  const h = verifyHarness({ historyMessages: [foundMsg] });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY, { verifyFirst: true });
  assert.deepEqual(res, { ts: "9.9", channel: "C1", reused: true });
  assert.equal(h.postCalls, 0, "fresh-process recovery reuses the live post");
  assert.equal(h.historyCalled, true);
});

test("postWithVerify: threaded recovery paginates within the delivery window before posting", async () => {
  let replyReads = 0;
  const client = {
    chat: { postMessage: async () => assert.fail("an existing recovery post must not be posted again") },
    conversations: {
      history: async () => assert.fail("thread recovery must read replies"),
      replies: async () => {
        replyReads++;
        return replyReads === 1
          ? { messages: [], response_metadata: { next_cursor: "next" } }
          : { messages: [foundMsg], response_metadata: { next_cursor: "" } };
      },
    },
  } as any;
  const res = await postWithVerify(client, { channel: "C1", text: "hi", thread_ts: "5.5" }, KEY, {
    verifyFirst: true,
    verifyOldest: "100.0",
  });
  assert.deepEqual(res, { ts: "9.9", channel: "C1", reused: true });
  assert.equal(replyReads, 2);
});

test("recoveryVerifyOldest widens the probe window to cover an edited-in-place task message", () => {
  assert.equal(recoveryVerifyOldest(105_000, undefined), "45", "a minute of slack for slow enqueue and clock skew");
  assert.equal(recoveryVerifyOldest(3_000_000, "50.5"), "45.5", "the edited task message's own ts wins when older");
  assert.equal(recoveryVerifyOldest(50_000, "3000.5"), "-10", "the createdAt bound wins when older");
  assert.equal(recoveryVerifyOldest(undefined, "50.5"), "45.5");
  assert.equal(recoveryVerifyOldest(undefined, "not-a-ts"), undefined);
  assert.equal(recoveryVerifyOldest(undefined, undefined), undefined);
});

test("postWithVerify: a ts-less ok response stays undefined, never the string 'undefined'", async () => {
  const h = verifyHarness({ postResults: [{ ok: { channel: "C1" } }] });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, undefined);
});

test("postWithVerify: ambiguous error + not found retries the post", async () => {
  const h = verifyHarness({
    postResults: [
      { err: { code: "slack_webapi_request_error", original: { code: "ECONNRESET" } } },
      { ok: { ts: "3.3", channel: "C1" } },
    ],
    historyMessages: [],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY);
  assert.equal(res.ts, "3.3");
  assert.equal(h.postCalls, 2);
});

test("postWithVerify: ambiguous error + verify read fails rethrows without re-post", async () => {
  const err = { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } };
  const h = verifyHarness({ postResults: [{ err }], historyThrows: true });
  await assert.rejects(
    () => postWithVerify(h.client, { channel: "C1", text: "hi" } as any, KEY),
    (e: any) => e === err,
  );
  assert.equal(h.postCalls, 1, "at-most-once: never re-sent when we can't confirm");
});

test("postWithVerify: threaded post verifies via conversations.replies", async () => {
  const h = verifyHarness({
    postResults: [{ err: { code: "slack_webapi_request_error", original: { code: "ETIMEDOUT" } } }],
    historyMessages: [foundMsg],
  });
  await postWithVerify(h.client, { channel: "C1", text: "hi", thread_ts: "5.5" } as any, KEY);
  assert.equal(h.repliesCalled, true);
  assert.equal(h.historyCalled, false, "threaded verify reads replies, not history");
});

test("postWithVerify: a reply over Slack's server-split threshold becomes sequential parts with derived marker keys", async () => {
  const h = verifyHarness({
    postResults: [
      { ok: { ts: "1.1", channel: "C1" } },
      { ok: { ts: "1.2", channel: "C1" } },
      { ok: { ts: "1.3", channel: "C1" } },
    ],
  });
  const text = "word ".repeat(2_000);
  const res = await postWithVerify(h.client, { channel: "C1", text } as any, KEY);
  assert.equal(h.postCalls, 3);
  for (const args of h.postArgs) assert.ok(args.text.length <= 3_800, `part over the split limit: ${args.text.length}`);
  assert.deepEqual(
    h.postArgs.map((a) => a.metadata.event_payload.idempotency_key),
    [KEY, `${KEY}#p2`, `${KEY}#p3`],
  );
  assert.equal(h.postArgs.map((a) => a.text).join(""), text, "the parts carry the whole reply");
  assert.equal(res.ts, "1.1", "the first part anchors threading and attachments");
  assert.deepEqual(
    res.parts?.map((p) => p.ts),
    ["1.1", "1.2", "1.3"],
  );
});

test("postWithVerify: a verify-first replay of a split reply re-posts only the parts that never landed", async () => {
  const landed = (key: string, ts: string) => ({
    ts,
    metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: key } },
  });
  const h = verifyHarness({
    postResults: [{ ok: { ts: "3.3", channel: "C1" } }],
    historyMessages: [landed(KEY, "9.1"), landed(`${KEY}#p2`, "9.2")],
  });
  const text = "word ".repeat(2_000);
  const res = await postWithVerify(h.client, { channel: "C1", text } as any, KEY, { verifyFirst: true });
  assert.equal(h.postCalls, 1, "parts 1 and 2 were found by their markers");
  assert.equal(h.postArgs[0].metadata.event_payload.idempotency_key, `${KEY}#p3`);
  assert.equal(res.ts, "9.1");
  assert.ok(!res.reused, "a retry that posted any new part did new work — attachment replay must not be skipped");
  assert.deepEqual(
    res.parts?.map((p) => [p.ts, p.reused ?? false]),
    [
      ["9.1", true],
      ["9.2", true],
      ["3.3", false],
    ],
  );
});

test("postWithVerify: a replay that finds every part reports the whole post as reused", async () => {
  const landed = (key: string, ts: string) => ({
    ts,
    metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: key } },
  });
  const h = verifyHarness({
    historyMessages: [landed(KEY, "9.1"), landed(`${KEY}#p2`, "9.2")],
  });
  const text = "word ".repeat(1_200);
  const res = await postWithVerify(h.client, { channel: "C1", text } as any, KEY, { verifyFirst: true });
  assert.equal(h.postCalls, 0);
  assert.equal(res.reused, true, "everything already landed — side effects were already done");
});

test("postWithVerify: a fence spanning the split boundary is closed and reopened per part", async () => {
  const h = verifyHarness({
    postResults: [{ ok: { ts: "1.1", channel: "C1" } }, { ok: { ts: "1.2", channel: "C1" } }],
  });
  const text = "intro\n```\n" + "code line\n".repeat(450) + "```\n";
  await postWithVerify(h.client, { channel: "C1", text } as any, KEY);
  assert.ok(h.postCalls >= 2);
  for (const args of h.postArgs) {
    assert.equal((args.text.match(/```/g) ?? []).length % 2, 0, "every part renders standalone");
  }
});

test("postWithVerify: a message with blocks is never split — its over-limit fallback text is clipped instead", async () => {
  const h = verifyHarness({ postResults: [{ ok: { ts: "1.1", channel: "C1" } }] });
  const blocks = [{ type: "section" }];
  const text = "word ".repeat(9_000);
  await postWithVerify(h.client, { channel: "C1", text, blocks } as any, KEY);
  assert.equal(h.postCalls, 1, "blocks carry the content; one message");
  assert.equal(h.postArgs[0].blocks, blocks);
  assert.ok(h.postArgs[0].text.length <= 39_001, "the notification fallback stays under Slack's truncation zone");
  assert.ok(h.postArgs[0].text.endsWith("…"));
});

test("postWithVerify: a blocks message with a mid-size fallback keeps its text untouched", async () => {
  const h = verifyHarness({ postResults: [{ ok: { ts: "1.1", channel: "C1" } }] });
  const blocks = [{ type: "section" }];
  const text = "word ".repeat(2_000);
  await postWithVerify(h.client, { channel: "C1", text, blocks } as any, KEY);
  assert.equal(h.postCalls, 1);
  assert.equal(h.postArgs[0].text, text);
});

test("split parts verify strictly when the caller asked for verification, best-effort otherwise", async () => {
  const historyFails = {
    chat: { postMessage: async (args: { text: string }) => ({ ok: true, ts: `${args.text.length}.1`, channel: "C1" }) },
    conversations: {
      history: async () => {
        throw new Error("ratelimited");
      },
      replies: async () => {
        throw new Error("ratelimited");
      },
    },
    search: { messages: async () => ({ ok: true, messages: { matches: [] } }) },
  } as unknown as Parameters<typeof postWithVerify>[0];
  const long = "x".repeat(SLACK_POST_SPLIT_LIMIT + 10);
  const relaxed = await postWithVerify(historyFails, { channel: "C1", text: long }, "k1");
  assert.equal(relaxed.parts?.length, 2, "a caller that did not ask for verification still gets all parts posted");
  await assert.rejects(
    postWithVerify(historyFails, { channel: "C1", text: long }, "k2", { verifyFirst: true }),
    /ratelimited/,
    "a caller that asked for verification keeps strict verification on every part",
  );
});

test("postWithVerify: a replay of split blocks posts only the missing batch", async () => {
  const blocks = Array.from({ length: 51 }, (_, i) => ({
    type: "section",
    text: { type: "mrkdwn", text: `Part ${i}` },
  }));
  const h = verifyHarness({
    postResults: [{ ok: { ts: "9.2", channel: "C1" } }],
    historyMessages: [{ ts: "9.1", metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: KEY } } }],
  });
  const res = await postWithVerify(h.client, { channel: "C1", text: "Full fallback", blocks }, KEY, {
    verifyFirst: true,
  });
  assert.equal(h.postCalls, 1);
  assert.equal(h.postArgs[0].metadata.event_payload.idempotency_key, `${KEY}#p2`);
  assert.deepEqual(h.postArgs[0].blocks, blocks.slice(50));
  assert.equal(res.ts, "9.1");
  assert.ok(!res.reused);
  assert.deepEqual(
    res.parts?.map((part) => part.reused ?? false),
    [true, false],
  );
});

const RECOVERED_AGE_MS = 60_000;

function harness(opts: { thread?: Array<Record<string, unknown>>; errors?: Record<string, string> }) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  const record =
    (method: string, result: unknown = {}) =>
    async (args: Record<string, unknown>) => {
      calls.push({ method, args });
      const error = opts.errors?.[method];
      if (error) throw Object.assign(new Error(error), { data: { error } });
      return typeof result === "function" ? result(args) : result;
    };
  const client = {
    conversations: {
      replies: record("conversations.replies", () => ({ messages: opts.thread ?? [] })),
      history: record("conversations.history", () => ({ messages: opts.thread ?? [] })),
    },
    reactions: { add: record("reactions.add") },
    pins: { add: record("pins.add"), remove: record("pins.remove") },
    chat: {
      postMessage: record("chat.postMessage", { ts: "900.100" }),
      update: record("chat.update"),
      delete: record("chat.delete"),
    },
  };
  const checkpoints: Array<[string, string]> = [];
  const core = {
    reportRunEditRef: async (runId: string, editRef: string) => {
      checkpoints.push([runId, editRef]);
    },
  };
  const send = createSlackSender({
    core: core as never,
    flow: { inFlightRuns: new Set<string>() } as never,
    threads: { mark: () => {} } as never,
    defaultClient: client,
  });
  return {
    calls,
    checkpoints,
    methods: () => calls.map((c) => c.method),
    send: (post: { destination: Record<string, unknown>; idempotencyKey?: string; text?: string; ageMs?: number }) =>
      send({
        idempotencyKey: post.idempotencyKey ?? "post:k1",
        text: post.text ?? "",
        destination: { type: "slack", target: "C1:100.200", ...post.destination } as never,
        ...(post.ageMs ? { createdAt: Date.now() - post.ageMs } : {}),
      }),
  };
}

test("a recovered run reply adopts the status placeholder it finds by metadata instead of posting beside it", async () => {
  const h = harness({
    thread: [
      { ts: "100.200", text: "the question" },
      {
        ts: "100.300",
        text: "Working on it…",
        metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: statusPlaceholderKey("r1") } },
      },
    ],
  });
  await h.send({ destination: {}, idempotencyKey: "run:r1", text: "the answer", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "chat.update"]);
  const update = h.calls[1]!.args;
  assert.equal(update.ts, "100.300");
  assert.equal(update.text, "the answer");
  assert.deepEqual(update.metadata, { event_type: "qm_delivery", event_payload: { idempotency_key: "run:r1" } });
  assert.deepEqual(
    h.checkpoints,
    [["r1", "100.300"]],
    "the adopted placeholder is checkpointed before it is finalized",
  );
});

test("a recovered run reply with no placeholder in the thread posts normally after the probe", async () => {
  const h = harness({ thread: [{ ts: "100.200", text: "the question" }] });
  await h.send({ destination: {}, idempotencyKey: "run:r1", text: "the answer", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "conversations.replies", "chat.postMessage"]);
  assert.equal(h.calls[2]!.args.text, "the answer");
  assert.deepEqual(h.checkpoints, []);
});

test("a recovered empty run reply deletes the orphaned placeholder it finds by metadata", async () => {
  const h = harness({
    thread: [
      {
        ts: "100.300",
        metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: statusPlaceholderKey("r1") } },
      },
    ],
  });
  await h.send({ destination: {}, idempotencyKey: "run:r1", text: "", ageMs: RECOVERED_AGE_MS });
  assert.deepEqual(h.methods(), ["conversations.replies", "chat.delete"]);
  assert.equal(h.calls[1]!.args.ts, "100.300");
});

test("a recorded editRef skips the placeholder probe", async () => {
  const h = harness({});
  await h.send({
    destination: { editRef: "100.300" },
    idempotencyKey: "run:r1",
    text: "the answer",
    ageMs: RECOVERED_AGE_MS,
  });
  assert.deepEqual(h.methods(), ["chat.update"]);
});

for (const [label, destination, method, error] of [
  ["reaction", { react: { messageTs: "100.200", emoji: "eyes" } }, "reactions.add", "already_reacted"],
  ["pin", { pin: { messageTs: "100.200" } }, "pins.add", "already_pinned"],
  ["unpin", { pin: { messageTs: "100.200", remove: true } }, "pins.remove", "no_pin"],
  ["unpin", { pin: { messageTs: "100.200", remove: true } }, "pins.remove", "not_pinned"],
  ["delete", { delete: { messageTs: "100.500" } }, "chat.delete", "message_not_found"],
] as const) {
  test(`a recovered ${label} post acts without probing and resolves quietly when Slack answers ${error}`, async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      const h = harness({ errors: { [method]: error } });
      await h.send({ destination, ageMs: RECOVERED_AGE_MS });
      assert.deepEqual(h.methods(), [method]);
      assert.deepEqual(errors, []);
    } finally {
      console.error = original;
    }
  });
}

test("fresh and recovered reaction, pin and delete posts act directly", async () => {
  for (const ageMs of [0, RECOVERED_AGE_MS]) {
    const react = harness({});
    await react.send({ destination: { react: { messageTs: "100.200", emoji: "eyes" } }, ageMs });
    assert.deepEqual(react.methods(), ["reactions.add"]);

    const pin = harness({});
    await pin.send({ destination: { pin: { messageTs: "100.200" } }, ageMs });
    assert.deepEqual(pin.methods(), ["pins.add"]);

    const remove = harness({});
    await remove.send({ destination: { delete: { messageTs: "100.500" } }, ageMs });
    assert.deepEqual(remove.methods(), ["chat.delete"]);
    assert.equal(remove.calls[0]!.args.ts, "100.500");
  }
});
