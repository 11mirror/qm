import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson } from "../src/util/canonical-json.ts";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";
import { SLACK_POST_SPLIT_LIMIT } from "../src/slack/lib.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

const uploadedNames = (uploads: Record<string, unknown>[]) =>
  uploads.flatMap((u) => (u.file_uploads as Array<{ filename: string }>).map(({ filename }) => filename));

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

async function deliver(
  destination: Record<string, unknown> = {},
  sourceThreadRef?: string,
  webUiPublicUrl?: string,
  text = "two screenshots and the notes",
  row: {
    createdAt?: number;
    history?: Record<string, unknown>[];
    loseAck?: boolean;
    approval?: unknown;
    uploadError?: Error;
    uploadedFileIds?: string[];
    unsharedFileIds?: string[];
    shareThreadTs?: string;
    withoutAttachments?: boolean;
    recoveredFileContents?: Record<string, string>;
  } = {},
) {
  const delivery = {
    id: "D1",
    idempotencyKey: destination.commandApprovalId ? `command-approval:${destination.commandApprovalId}:0` : "D1",
    text,
    ...(sourceThreadRef
      ? { provenance: { trigger: "cron", sourceThreadRef, sourceTitle: "Weekly <project> & check-in" } }
      : {}),
    destination: { type: "slack", target: "C1:100.200", ...destination },
    ...(row.withoutAttachments ? {} : { attachments: mixedFiles }),
    createdAt: row.createdAt ?? Date.now(),
  };
  const queues = new Map<string, unknown[]>([[String(delivery.destination.type), [delivery]]]);
  const acknowledgements: string[] = [];
  const ackBodies: unknown[] = [];
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const probes: Record<string, unknown>[] = [];
  const history = row.history ?? [];
  const conversationsOpened: Record<string, unknown>[] = [];
  const shareInfoCalls = new Map<string, number>();
  const recoveredDownloads: string[] = [];
  const probe = async (args: Record<string, unknown>) => {
    probes.push(args);
    return {
      messages: args.ts
        ? history.filter((message) => message.ts === args.ts || message.thread_ts === args.ts)
        : history.filter((message) => !message.thread_ts),
    };
  };
  const core = {
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    getApproval: async () => row.approval ?? null,
    readBlob: async (id: string) => Buffer.from(id),
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    ackDelivery: async (id: string, body: unknown) => {
      if (row.loseAck) throw new Error("acknowledgement lost");
      acknowledgements.push(id);
      ackBodies.push(body);
    },
  };
  const client = {
    conversations: {
      open: async (args: Record<string, unknown>) => {
        conversationsOpened.push(args);
        return { channel: { id: "C1" } };
      },
      replies: probe,
      history: probe,
    },
    files: {
      uploadV2: async (args: Record<string, unknown>) => {
        if (row.uploadError) throw row.uploadError;
        uploads.push(args);
        const fileIds = row.uploadedFileIds ?? mixedFiles.map((_, index) => `F${index + 1}`);
        history.push({
          ts: "101.300",
          thread_ts: args.thread_ts,
          text: args.initial_comment,
          files: mixedFiles.map((file, index) => ({ ...file, id: fileIds[index] })),
        });
        return { files: [{ files: fileIds.map((id) => ({ id })) }] };
      },
      info: async ({ file }: { file: string }) => {
        if (row.unsharedFileIds?.includes(file)) throw new Error("share not committed");
        const calls = (shareInfoCalls.get(file) ?? 0) + 1;
        shareInfoCalls.set(file, calls);
        if (row.shareThreadTs && calls > 1) throw new Error("requested thread share not found");
        const requestedThreadTs = uploads.at(-1)?.thread_ts;
        const shareThreadTs = row.shareThreadTs ?? requestedThreadTs;
        const observed = history
          .flatMap((message) => (message.files as Array<{ id?: string; name?: string }> | undefined) ?? [])
          .find((candidate) => candidate.id === file);
        return {
          file: {
            id: file,
            ...(observed?.name ? { name: observed.name } : {}),
            shares: {
              private: {
                C1: [{ ts: "101.300", ...(shareThreadTs ? { thread_ts: shareThreadTs } : {}) }],
              },
            },
          },
        };
      },
    },
    chat: {
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { ts: args.ts, channel: args.channel };
      },
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        history.push({ ...args, ts: "separate-message" });
        return { ts: "separate-message" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    webUiPublicUrl,
    flow: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async (id: string) => Buffer.from(id),
      fetchFileArtifactFromCore: async () => Buffer.from("artifact"),
    } as never,
    threads: { mark: (channel: string, ts: string) => void marks.push({ channel, ts }) } as never,
    clientForIdentity: () => client,
    clientForAccount: () => client,
    downloadRecoveredFile: async (_client, file) => {
      if (file.id) recoveredDownloads.push(file.id);
      const recovered = file.id ? row.recoveredFileContents?.[file.id] : undefined;
      if (recovered !== undefined) return Buffer.from(recovered);
      const index = mixedFiles.findIndex((candidate) => candidate.name === file.name);
      if (index < 0) throw new Error("unexpected recovered file");
      return Buffer.from(`B${index + 1}`);
    },
  });

  await poller.pollDeliveries(client);
  return {
    acknowledgements,
    ackBodies,
    uploads,
    posts,
    updates,
    marks,
    probes,
    conversationsOpened,
    recoveredDownloads,
  };
}

test("Slack post acknowledgements carry the exact provider result", async () => {
  const { ackBodies, posts } = await deliver(
    { type: "slack", slackAccountId: "account-1", slackTeamId: "team-1" },
    undefined,
    undefined,
    "report ready",
  );
  assert.deepEqual(
    ackBodies.map((body) => (body as { providerReceipt?: unknown }).providerReceipt),
    [
      {
        provider: "slack",
        action: "post",
        channelId: "C1",
        messageTs: "separate-message",
        threadTs: "100.200",
        slackAccountId: "account-1",
        slackTeamId: "team-1",
        renderedBodySha256: sha256(canonicalJson(posts[0])),
        files: [
          { id: "F1", sha256: sha256("B1") },
          { id: "F2", sha256: sha256("B2") },
          { id: "F3", sha256: sha256("B3") },
        ],
      },
    ],
  );
});

test("Slack post acknowledgements stay weak when any intended attachment lacks provider evidence", async () => {
  for (const row of [
    { uploadError: new Error("upload failed") },
    { uploadedFileIds: ["F1"] },
    { unsharedFileIds: ["F2"] },
    { shareThreadTs: "wrong-thread" },
  ]) {
    const { ackBodies } = await deliver({ type: "slack" }, undefined, undefined, "report ready", row);
    assert.equal((ackBodies[0] as { providerReceipt?: unknown }).providerReceipt, undefined);
  }
});

test("Slack post evidence hashes the transformed request sent to Slack", async () => {
  const { ackBodies, posts } = await deliver({ type: "slack" }, undefined, undefined, "**report ready**");
  assert.equal(posts[0]!.text, "*report ready*");
  const receipt = (ackBodies[0] as { providerReceipt: { renderedBodySha256: string } }).providerReceipt;
  assert.equal(receipt.renderedBodySha256, sha256(canonicalJson(posts[0])));
  assert.notEqual(receipt.renderedBodySha256, sha256(canonicalJson({ text: "**report ready**" })));
});

test("Slack update evidence hashes the exact update request", async () => {
  const { ackBodies, posts, updates } = await deliver(
    { type: "slack", editRef: "171.200" },
    undefined,
    undefined,
    "updated report",
    { withoutAttachments: true },
  );
  assert.equal(posts.length, 0);
  assert.equal(updates.length, 1);
  assert.deepEqual((ackBodies[0] as { providerReceipt?: unknown }).providerReceipt, {
    provider: "slack",
    action: "update",
    channelId: "C1",
    messageTs: "171.200",
    threadTs: "100.200",
    renderedBodySha256: sha256(canonicalJson(updates[0])),
  });
});

test("Slack update recovery reuses byte-verified files after a lost acknowledgement", async () => {
  const history: Record<string, unknown>[] = [];
  const first = await deliver({ type: "slack", editRef: "171.200" }, undefined, undefined, "updated report", {
    history,
    loseAck: true,
  });
  assert.equal(first.updates.length, 2);
  assert.equal(first.uploads.length, 1);
  assert.deepEqual(first.acknowledgements, []);
  history.push({ ...first.updates.at(-1), ts: "171.200", thread_ts: "100.200" });
  history.push(
    ...Array.from({ length: 500 }, (_, index) => ({
      ts: `unrelated-${index}`,
      thread_ts: "100.200",
      files: [{ id: `UNRELATED-${index}`, name: `unrelated-${index}.txt` }],
    })),
  );

  const recovered = await deliver({ type: "slack", editRef: "171.200" }, undefined, undefined, "updated report", {
    createdAt: Date.now() - 60_000,
    history,
  });

  assert.equal(recovered.updates.length, 1);
  assert.equal(recovered.uploads.length, 0);
  assert.deepEqual(
    recovered.probes.map((probe) => ({ limit: probe.limit, oldest: probe.oldest, latest: probe.latest })),
    [
      { limit: 1, oldest: "171.200", latest: "171.200" },
      { limit: 1, oldest: "101.300", latest: "101.300" },
    ],
  );
  assert.deepEqual(recovered.recoveredDownloads, ["F1", "F2", "F3"]);
  assert.deepEqual(recovered.acknowledgements, ["D1"]);
  assert.deepEqual((recovered.ackBodies[0] as { providerReceipt?: unknown }).providerReceipt, {
    provider: "slack",
    action: "update",
    channelId: "C1",
    messageTs: "171.200",
    threadTs: "100.200",
    renderedBodySha256: sha256(canonicalJson(recovered.updates[0])),
    files: [
      { id: "F1", sha256: sha256("B1") },
      { id: "F2", sha256: sha256("B2") },
      { id: "F3", sha256: sha256("B3") },
    ],
  });
});

test("Slack split posts remain weak without attachments", async () => {
  const text = "a long reply ".repeat(Math.ceil(SLACK_POST_SPLIT_LIMIT / 12) + 20);
  const { ackBodies, posts, uploads } = await deliver({ type: "slack" }, undefined, undefined, text, {
    withoutAttachments: true,
  });
  assert.ok(posts.length > 1);
  assert.equal(uploads.length, 0);
  assert.equal((ackBodies[0] as { providerReceipt?: unknown }).providerReceipt, undefined);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} cron deliveries include settings below the complete message and preserve attachments`, async () => {
    const text = "Scheduled update. ".repeat(250);
    const { posts, uploads, acknowledgements } = await deliver(
      { type },
      "cron:morning report:fire:123",
      "https://agent.example/web-ui/",
      text,
    );
    assert.equal(posts.length, 1);
    const blocks = posts[0]!.blocks as Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
    assert.equal(
      blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text!.text)
        .join(""),
      text,
    );
    assert.deepEqual(blocks.at(-1), {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Weekly &lt;project&gt; &amp; check-in · <https://agent.example/web-ui/crons/morning%20report|Settings>",
          verbatim: true,
        },
      ],
    });
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(
      uploadedNames(uploads),
      mixedFiles.map((f) => f.name),
    );
    assert.deepEqual(acknowledgements, ["D1"]);
  });
}

test("recovery uploads a fully missing attachment set after the message marker landed", async () => {
  const history = [
    {
      ts: "separate-message",
      thread_ts: "100.200",
      metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: "D1" } },
    },
  ];
  const result = await deliver({ type: "slack" }, undefined, undefined, undefined, {
    createdAt: Date.now() - 60_000,
    history,
  });

  assert.equal(result.posts.length, 0);
  assert.equal(result.uploads.length, 1);
  assert.deepEqual(result.acknowledgements, ["D1"]);
  assert.ok((result.ackBodies[0] as { providerReceipt?: unknown }).providerReceipt);
});

test("recovery leaves a partial attachment set unacknowledged", async () => {
  const history = [
    {
      ts: "separate-message",
      thread_ts: "100.200",
      metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: "D1" } },
    },
    {
      ts: "file-message",
      thread_ts: "100.200",
      files: [{ id: "F1", name: mixedFiles[0]!.name }],
    },
  ];
  const result = await deliver({ type: "slack" }, undefined, undefined, undefined, {
    createdAt: Date.now() - 60_000,
    history,
  });

  assert.equal(result.posts.length, 0);
  assert.equal(result.uploads.length, 0);
  assert.deepEqual(result.acknowledgements, []);
});

test("recovery rejects a same-name provider file whose downloaded bytes differ", async () => {
  const history = [
    {
      ts: "separate-message",
      thread_ts: "100.200",
      metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: "D1" } },
    },
    ...mixedFiles.map((file, index) => ({
      ts: `file-${index + 1}`,
      thread_ts: "100.200",
      files: [{ id: `F${index + 1}`, name: file.name }],
    })),
  ];
  const result = await deliver({ type: "slack" }, undefined, undefined, undefined, {
    createdAt: Date.now() - 60_000,
    history,
    recoveredFileContents: { F1: "different bytes" },
  });

  assert.equal(result.posts.length, 0);
  assert.equal(result.uploads.length, 0);
  assert.deepEqual(result.acknowledgements, []);
});

test("cron deliveries omit settings when the web UI is unavailable", async () => {
  const { posts, uploads } = await deliver({}, "cron:c1:fire:123");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.blocks, undefined);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]!.initial_comment, undefined);
  assert.deepEqual(
    uploadedNames(uploads),
    mixedFiles.map((f) => f.name),
  );
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} deliveries mark text for recovery and batch mixed attachments`, async () => {
    const { acknowledgements, uploads, posts, marks } = await deliver({ type });

    assert.equal(uploads.length, 1);
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0]!.metadata, {
      event_type: "qm_delivery",
      event_payload: { idempotency_key: "D1" },
    });
    assert.equal(uploads[0]!.channel_id, "C1");
    assert.equal(uploads[0]!.thread_ts, type === "principal" ? undefined : "100.200");
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
    assert.deepEqual(acknowledgements, ["D1"]);
    assert.deepEqual(marks, type === "principal" ? [] : [{ channel: "C1", ts: "100.200" }]);
  });

  test(`${type} restart after a lost acknowledgement reuses the actual posted message and files`, async () => {
    const history: Record<string, unknown>[] = [];
    const first = await deliver({ type }, undefined, undefined, undefined, { history, loseAck: true });
    assert.equal(first.posts.length, 1);
    assert.equal(first.uploads.length, 1);
    assert.deepEqual(first.acknowledgements, []);
    const { probes, posts, uploads, acknowledgements, ackBodies } = await deliver(
      { type },
      undefined,
      undefined,
      undefined,
      {
        createdAt: Date.now() - 60_000,
        history,
      },
    );

    assert.equal(probes.length, type === "principal" ? 1 : 2, "the recovered row verifies the marker and its files");
    assert.equal(posts.length, 0, "a marker hit means the text was already posted");
    assert.equal(uploads.length, 0, "files behind a delivered marker are not replayed");
    assert.deepEqual(acknowledgements, ["D1"]);
    if (type !== "principal") {
      assert.equal((ackBodies[0] as { providerReceipt?: unknown }).providerReceipt !== undefined, true);
    }
  });

  test(`${type} long replies with attachments take the splitting path instead of one upload comment`, async () => {
    const text = "a long reply ".repeat(Math.ceil(SLACK_POST_SPLIT_LIMIT / 12) + 20);
    const { posts, uploads, ackBodies } = await deliver({ type }, undefined, undefined, text);

    assert.ok(posts.length > 1, `expected the text split across posts, got ${posts.length}`);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
    assert.equal((ackBodies[0] as { providerReceipt?: unknown }).providerReceipt, undefined);
  });

  test(`${type} deliveries keep the separate-comment fallback when upload comments cannot carry post options`, async () => {
    const { uploads, posts } = await deliver({ type, unfurlLinks: false });

    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.text, "two screenshots and the notes");
    assert.equal(posts[0]!.unfurl_links, false);
    assert.equal(uploads.length, 1, "the fallback still batches the files themselves");
    assert.equal(uploads[0]!.initial_comment, undefined);
    assert.deepEqual(uploadedNames(uploads), ["first.png", "second.jpg", "notes.pdf"]);
  });
}

test("ordinary deliveries omit cron settings even with a configured web UI", async () => {
  const { posts } = await deliver({ unfurlLinks: false }, "dm:D1", "https://agent.example/web-ui");
  assert.equal(posts[0]!.blocks, undefined);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} attachment-only cron deliveries use a valid footer without an empty message section`, async () => {
    const { posts, uploads, acknowledgements } = await deliver(
      { type },
      "cron:c1:fire:123",
      "https://agent.example",
      "",
    );
    assert.equal(posts.length, 1);
    assert.deepEqual(
      (posts[0]!.blocks as Array<{ type: string }>).map((block) => block.type),
      ["context"],
    );
    assert.equal(uploads.length, 1);
    assert.deepEqual(
      uploadedNames(uploads),
      mixedFiles.map((f) => f.name),
    );
    assert.deepEqual(acknowledgements, ["D1"]);
  });
}

for (const type of ["group", "principal"]) {
  for (const sender of ["josh", "@josh", "<@U123> & <!channel>"]) {
    test(`${type} relay attribution is a plain-text footer for ${sender}`, async () => {
      const { posts } = await deliver({ type, relaySender: sender }, undefined, undefined, "Ship it");
      assert.equal(posts.length, 1);
      assert.equal(posts[0]!.text, "Ship it");
      assert.deepEqual(posts[0]!.blocks, [
        { type: "section", text: { type: "mrkdwn", text: "Ship it" } },
        {
          type: "context",
          elements: [{ type: "plain_text", text: `Sent for @${sender.replace(/^@+/, "")}`, emoji: false }],
        },
      ]);
    });
  }

  test(`${type} attachment-only relay retains its attribution alongside cron settings`, async () => {
    const { posts, uploads } = await deliver(
      { type, relaySender: "josh" },
      "cron:c1:fire:123",
      "https://agent.example/web-ui",
      "",
    );
    assert.equal(posts.length, 1);
    const blocks = posts[0]!.blocks as Array<{ type: string; elements: Array<{ type: string; text: string }> }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.type, "context");
    assert.deepEqual(blocks[0]!.elements[0], { type: "plain_text", text: "Sent for @josh", emoji: false });
    assert.equal(blocks[0]!.elements[1]!.type, "mrkdwn");
    assert.ok(uploads.length);
  });
}

for (const type of ["group", "principal"]) {
  test(`${type} long relays split within Slack's block limit and keep the footer last`, async () => {
    const text = "x".repeat(145_000);
    const { posts } = await deliver({ type, relaySender: "josh" }, undefined, undefined, text);
    assert.equal(posts.length, 2);
    const blocks = posts.flatMap((post) => {
      const batch = post.blocks as Array<{ type: string; text?: { text: string }; elements?: unknown[] }>;
      assert.ok(batch.length <= 50);
      return batch;
    });
    assert.equal(
      blocks
        .filter((block) => block.type === "section")
        .map((block) => block.text!.text)
        .join(""),
      text,
    );
    assert.deepEqual(blocks.at(-1), {
      type: "context",
      elements: [{ type: "plain_text", text: "Sent for @josh", emoji: false }],
    });
    assert.equal(blocks.filter((block) => block.type === "context").length, 1);
  });
}

test("principal delivery metadata renders an actionable deployment card", async () => {
  const request = { deploymentId: "00000000-0000-4000-8000-000000000001", requesterId: "bob@example.com" };
  const { posts } = await deliver(
    JSON.parse(JSON.stringify({ type: "principal", target: "U1", deploymentAccess: request })),
  );
  const blocks = posts[0]!.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
  const actions = blocks.find((b) => b.type === "actions")!;
  assert.equal(actions.elements!.length, 2);
  assert.deepEqual(JSON.parse(actions.elements![0]!.value), request);
});
test("delegated approvals recover native buttons from durable records", async () => {
  const approval = {
    requestId: "A1",
    command: "publish",
    reason: "approval",
    grantModes: { session: false, always: false },
    request: { actor: { externalId: "U1" } },
  };
  const history: Record<string, unknown>[] = [];
  const destination = { type: "principal", target: "U1", commandApprovalId: "A1" };
  const first = await deliver(destination, undefined, undefined, "Approval needed", {
    approval,
    history,
    loseAck: true,
  });
  assert.equal(first.posts.length, 1);
  const rendered = JSON.stringify(first.posts[0]!.blocks);
  assert.match(rendered, /hilo_allow_once/);
  assert.doesNotMatch(rendered, /hilo_allow_always/);
  const second = await deliver(destination, undefined, undefined, "Approval needed", {
    approval,
    history,
    createdAt: Date.now() - 60_000,
  });
  assert.equal(second.posts.length, 0);
  assert.deepEqual(second.acknowledgements, ["D1"]);
});

test("an approval too long for Slack links its Deny-only card to the conversation on the web", async () => {
  const approval = {
    requestId: "A1",
    sessionId: "S 1",
    command: `example_send {"a":"${"&".repeat(15_000)}","to":"attacker@example.com"}`,
    reason: "this tool asks for approval before each call",
    request: { actor: { externalId: "U1" } },
  };
  const out = await deliver(
    { type: "principal", target: "U1", commandApprovalId: "A1" },
    undefined,
    "https://qm.example.com/",
    "Approval needed",
    { approval },
  );
  const rendered = JSON.stringify(out.posts[0]!.blocks);
  assert.match(rendered, /<https:\/\/qm\.example\.com\/s\/S%201\|this conversation in QM>/);
  assert.doesNotMatch(rendered, /hilo_allow_once|attacker@example\.com/);
});

for (const approval of [null, { requestId: "A1", command: "publish", request: { actor: { externalId: "U2" } } }]) {
  test(`delegated approvals discard ${approval ? "mismatched" : "expired"} records`, async () => {
    const out = await deliver(
      { type: "principal", target: "U1", commandApprovalId: "A1" },
      undefined,
      undefined,
      "Approval needed",
      { approval },
    );
    assert.equal(out.posts.length, 0);
    assert.deepEqual(out.acknowledgements, ["D1"]);
  });
}

test("a stale queued approval cannot render a newer request for the same command", async () => {
  const approval = { requestId: "A1", createdAt: 99, command: "publish", request: { actor: { externalId: "U1" } } };
  const out = await deliver(
    { type: "principal", target: "U1", commandApprovalId: "A1" },
    undefined,
    undefined,
    "approval",
    { approval },
  );
  assert.equal(out.posts.length, 0);
  assert.deepEqual(out.acknowledgements, ["D1"]);
});

test("a queued system approval notification is retired without opening a Slack DM", async () => {
  const actorId = "system:ambient:acme";
  const approval = { requestId: "A1", command: "publish", request: { actor: { externalId: actorId } } };
  const out = await deliver(
    { type: "principal", target: actorId, commandApprovalId: "A1" },
    undefined,
    undefined,
    "Approval needed",
    { approval },
  );
  assert.deepEqual(out.conversationsOpened, []);
  assert.deepEqual(out.posts, []);
  assert.deepEqual(out.uploads, []);
  assert.deepEqual(out.acknowledgements, ["D1"]);
});

for (const type of ["slack", "group", "principal"]) {
  test(`${type} file-only deliveries survive a restart after a lost acknowledgement`, async () => {
    const history: Record<string, unknown>[] = [];
    const first = await deliver({ type }, undefined, undefined, "", { history, loseAck: true });
    assert.equal(first.posts.length, 1);
    assert.equal(first.posts[0]!.text, "Files attached.");
    assert.equal(first.uploads.length, 1);
    assert.deepEqual(first.acknowledgements, []);
    const recovered = await deliver({ type }, undefined, undefined, "", {
      history,
      createdAt: Date.now() - 60_000,
    });
    assert.equal(recovered.posts.length, 0);
    assert.equal(recovered.uploads.length, 0);
    assert.deepEqual(recovered.acknowledgements, ["D1"]);
  });
}
