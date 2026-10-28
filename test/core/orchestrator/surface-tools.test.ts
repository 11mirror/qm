import { Readable } from "node:stream";
import { createAttachStaging } from "../../../src/core/orchestrator/attach-tool.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectNamedOutbound,
  parseOutboundFiles,
  MAX_ATTACHMENT_BYTES,
  type ArtifactRegistration,
} from "../../../src/core/attachments.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../../../src/core/orchestrator/surface-tools.ts";
import { turnPostKeys } from "../../../src/core/orchestrator/turn-helpers.ts";
import { createMemoryBlobTransferStore } from "../../../src/persistence/blob-transfer.ts";
import { createMemoryDurableByteStore } from "../../../src/files/durable-byte-store.ts";
import { scopeId } from "../../../src/types.ts";
import type { Sandbox, SandboxHandle } from "../../../src/sandbox/sandbox.ts";
import { createPostgresChannelPolicyStore } from "../../../src/surface-cache/channel-policy-store.ts";
import { createPostgresFileArtifactStore } from "../../../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "../../support/test-database.ts";

function fakeSandbox(files: Record<string, Uint8Array>): Sandbox {
  return {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      return files[p] ?? null;
    },
  } as unknown as Sandbox;
}

const handle = { rootDir: "/root/workspace" } as SandboxHandle;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

test("collectNamedOutbound: resolves workspace-relative paths into blob-backed attachments", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "reports/cover.png": bytes("PNGDATA"), "report.pdf": bytes("PDF") });
  const r = await collectNamedOutbound(sandbox, handle, ["reports/cover.png", "report.pdf"], transfer);
  assert.equal(r.attachments.length, 2, "both named files became attachments");
  assert.deepEqual(r.attachments.map((a) => a.name).sort(), ["cover.png", "report.pdf"]);
  assert.ok(
    r.attachments.every((a) => a.blobId && a.sizeBytes > 0),
    "each attachment is blob-backed",
  );
});

test("collectNamedOutbound: rejects parent traversal before reading outside the workspace", async () => {
  const transfer = createMemoryBlobTransferStore();
  const reads: string[] = [];
  const invalid = ["../.ssh/id_ed25519", "work/../../.ssh/id_ed25519"];
  const paths = ["report.pdf", ...invalid];
  const sandbox = {
    async readFileBytes(_handle: SandboxHandle, p: string) {
      reads.push(p);
      return bytes("secret");
    },
  } as unknown as Sandbox;
  await assert.rejects(collectNamedOutbound(sandbox, handle, paths, transfer), /no \.\. path segments/);
  assert.deepEqual(reads, []);
  assert.equal(await transfer.sweep(0), 0);
});

test("collectNamedOutbound: preserves POSIX filenames containing backslashes", async () => {
  const path = String.raw`reports\..\final.txt`;
  const r = await collectNamedOutbound(
    fakeSandbox({ [path]: bytes("report") }),
    handle,
    [path],
    createMemoryBlobTransferStore(),
  );
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]?.name, "final.txt");
  assert.deepEqual(r.missing, []);
});

test("surface post rejects traversal before provisioning or staging any attachment", async () => {
  const calls = { provision: 0, read: 0, put: 0, grant: 0 };
  const tools = createSurfaceToolDeps({
    deps: {
      outbound: {},
      sandbox: {
        async readFileBytes() {
          calls.read += 1;
          return bytes("file");
        },
      },
    },
    input: { surfaceTools: true },
    defaultDestination: {},
    strictReadOnly: false,
    provision: async () => {
      calls.provision += 1;
      return handle;
    },
    blobTransfer: {
      async put() {
        calls.put += 1;
        return { blobId: "blob" };
      },
    },
    fileRegistration: {
      async onRegistered() {
        calls.grant += 1;
      },
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0 },
    signal: new AbortController().signal,
  } as unknown as SurfaceToolsContext);
  const r = await tools!.post("hello", undefined, ["report.pdf", "../.ssh/id_ed25519"]);
  assert.equal(r.ok, false);
  assert.deepEqual(calls, { provision: 0, read: 0, put: 0, grant: 0 });
});

test("surface channel settings preserve and reset the stored ambient reply policy", async () => {
  const channelPolicy = createPostgresChannelPolicyStore(testDatabaseUrl());
  const tools = createSurfaceToolDeps({
    deps: { outbound: {}, channelPolicy, auditLog: { record() {} } },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel", channelRef: "C1" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: {},
    fileRegistration: {},
    provision: async () => handle,
    postProvenance() {
      return {};
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0 },
    signal: new AbortController().signal,
  } as unknown as SurfaceToolsContext)!;

  await tools.setChannelBehavior(undefined, true);
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, true);
  const enabled = await tools.getChannelBehavior();
  assert.equal(enabled.ok && enabled.ambientEnabled, true);
  await tools.setChannelBehavior({ newsbot: { mode: "ignore" } });
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, true);
  await tools.setChannelBehavior(undefined, null);
  assert.equal((await channelPolicy.get("C1"))?.ambientEnabled, undefined);
  const reset = await tools.getChannelBehavior();
  assert.equal(reset.ok && reset.ambientEnabled, undefined);
});

test("collectNamedOutbound: a missing/empty path is reported (so post can fail the WHOLE call)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const sandbox = fakeSandbox({ "reports/there.png": bytes("X"), "reports/blank.txt": bytes("") });
  const r = await collectNamedOutbound(
    sandbox,
    handle,
    ["reports/there.png", "reports/gone.png", "reports/blank.txt"],
    transfer,
  );
  assert.deepEqual(r.missing, ["reports/gone.png"], "the unresolvable path is surfaced");
  assert.deepEqual(r.empty, ["reports/blank.txt"], "the empty file is surfaced");
  assert.deepEqual(r.attachments, [], "no attachment survives a doomed call");
  assert.equal(await transfer.sweep(0), 0, "no orphaned transfer blob for the good file");
});

test("collectNamedOutbound: a doomed call's rollback never deletes an artifact an earlier call created (idempotent ids under a shared seed)", async () => {
  const transfer = createMemoryBlobTransferStore();
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const register: ArtifactRegistration = {
    store,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    seed: "run-1",
    onError: () => {},
  };
  const sandbox = fakeSandbox({ "reports/first.md": bytes("delivered earlier"), "reports/kept.md": bytes("good") });
  const ok = await collectNamedOutbound(sandbox, handle, ["reports/first.md"], transfer, register);
  assert.equal(ok.attachments.length, 1);
  const priorArtifactId = ok.attachments[0]!.artifactId!;
  assert.ok(await store.get(priorArtifactId), "post #1's artifact is registered");
  const doomed = await collectNamedOutbound(
    sandbox,
    handle,
    ["reports/kept.md", "reports/gone.md"],
    transfer,
    register,
  );
  assert.deepEqual(doomed.missing, ["reports/gone.md"]);
  assert.deepEqual(doomed.attachments, [], "the doomed call stages nothing");
  assert.ok(await store.get(priorArtifactId), "post #1's artifact survives post #2's rollback");
});

test("surface post returns the sent attachments' metadata (so surfaces can render them)", async () => {
  const sent: unknown[] = [];
  const tools = createSurfaceToolDeps({
    deps: {
      outbound: {
        async send(input: unknown) {
          sent.push(input);
        },
      },
      sandbox: fakeSandbox({ "qm-brand/cover.png": bytes("PNGDATA") }),
    },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "group" },
    session: { id: "S1" },
    scopeId: scopeId("personal", "U1"),
    defaultDestination: { type: "web", target: "web:thread" },
    strictReadOnly: false,
    provision: async () => handle,
    blobTransfer: createMemoryBlobTransferStore(),
    fileRegistration: {
      store: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      seed: "run-post",
      onError: () => {},
    },
    postProvenance() {
      return {};
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0 },
    signal: new AbortController().signal,
  } as unknown as SurfaceToolsContext)!;
  const r = await tools.post("Here they are", undefined, ["qm-brand/cover.png"]);
  assert.equal(r.ok, true);
  assert.equal(sent.length, 1, "the delivery was sent");
  assert.equal(r.attachments?.length, 1, "the post result names what it sent");
  const a = r.attachments![0]!;
  assert.equal(a.name, "cover.png");
  assert.equal(a.mimetype, "image/png");
  assert.ok(a.sizeBytes > 0);
  assert.ok(a.artifactId, "artifact id present so the web surface can serve the bytes");
  assert.ok(!("blobId" in a), "internal blob handle is not leaked to surfaces");
});

test("stored files retain metadata and need no sandbox, including replacement and failed batches", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const transfer = createMemoryBlobTransferStore();
  await store.put({
    id: "saved",
    ownerScopeId: "personal:U1",
    createdBy: "U1",
    name: "report.custom",
    path: "report.custom",
    mimetype: "text/custom",
    data: bytes("saved data"),
    direction: "out",
  });
  const staging = createAttachStaging({
    sandbox: undefined as unknown as Sandbox,
    provision: async () => {
      throw new Error("no default sandbox");
    },
    blobTransfer: transfer,
    fileRegistration: { store, ownerScopeId: "personal:U1", createdBy: "U1", seed: "new", onError: () => {} },
    openStored: async (id) => {
      const opened = await store.open(id);
      return opened ? { ...opened.artifact, stream: opened.stream } : null;
    },
  });
  assert.equal((await staging.attach([{ file_id: "saved" }])).ok, true);
  const first = staging.staged()[0]!;
  assert.equal(first.artifactId, "saved");
  assert.equal(first.mimetype, "text/custom");
  assert.equal(first.name, "report.custom");
  assert.equal((await staging.attach([{ file_id: "saved" }])).ok, true);
  assert.equal(await transfer.open(first.blobId), null);
  assert.equal(staging.staged().length, 1);
  assert.equal((await staging.attach([{ file_id: "saved" }, { file_id: "denied" }])).ok, false);
  assert.equal(staging.staged().length, 1);
  assert.ok(await store.get("saved"), "rollback never deletes the source artifact");
});

test("workspace staging selects the requested sandbox and never falls back on rejected IDs", async () => {
  const selected: Array<string | undefined> = [];
  const transfer = createMemoryBlobTransferStore();
  const staging = createAttachStaging({
    sandbox: {
      async readFileBytes(box: SandboxHandle) {
        return bytes(box.id);
      },
    } as unknown as Sandbox,
    provision: async (id) => {
      selected.push(id);
      if (id === "denied") throw new Error("unauthorized");
      return { ...handle, id: id ?? "default" };
    },
    blobTransfer: transfer,
    fileRegistration: {
      store: createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()),
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      seed: "selector",
      onError: () => {},
    },
  });
  await staging.attach(["report.txt"], "one");
  await staging.attach(["report.txt"], "two");
  assert.equal(staging.staged().length, 2, "the same path on different computers is not a replacement");
  await assert.rejects(staging.attach(["report.txt"], "denied"), /unauthorized/);
  assert.deepEqual(selected, ["one", "two", "denied"]);
});

test("stored file validation rejects malformed inputs and oversized streams", async () => {
  for (const input of [[{}], [{ file_id: "" }], [{ file_id: "id", path: "ambiguous" }], [12]])
    assert.equal(parseOutboundFiles(input).ok, false);
  assert.equal(parseOutboundFiles(Array(21).fill({ file_id: "id" })).ok, true);
  let opened = 0;
  const transfer = createMemoryBlobTransferStore();
  const result = await collectNamedOutbound(
    undefined,
    async () => {
      throw new Error("sandbox not needed");
    },
    [{ file_id: "large" }],
    transfer,
    undefined,
    [],
    async () => {
      opened++;
      return {
        name: "large.zip",
        mimetype: "application/zip",
        sizeBytes: MAX_ATTACHMENT_BYTES + 1,
        stream: Readable.from(["not read"]),
      };
    },
  );
  assert.equal(opened, 1);
  assert.deepEqual(result.oversized, ["large"]);
  assert.deepEqual(result.attachments, []);
  assert.equal(await transfer.sweep(0), 0);
});

test("a stored stream failure rolls back earlier workspace staging", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const transfer = createMemoryBlobTransferStore();
  await assert.rejects(
    collectNamedOutbound(
      fakeSandbox({ "report.txt": bytes("hello") }),
      handle,
      ["report.txt", { file_id: "broken" }],
      transfer,
      { store, ownerScopeId: "personal:U1", createdBy: "U1", seed: "rollback", onError: () => {} },
      [],
      async () => ({
        name: "broken.txt",
        mimetype: "text/plain",
        sizeBytes: 1,
        stream: Readable.from(
          (async function* () {
            yield "partial";
            throw new Error("read failed");
          })(),
        ),
      }),
    ),
    /read failed/,
  );
  assert.equal(await transfer.sweep(0), 0);
  assert.equal((await store.listOwnedByScopes(["personal:U1"])).files.length, 0);
});

test("replacing a path preserves its artifact when staged again by ID", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const staging = createAttachStaging({
    sandbox: fakeSandbox({ "report.txt": bytes("report") }),
    provision: async () => handle,
    blobTransfer: createMemoryBlobTransferStore(),
    fileRegistration: { store, ownerScopeId: "personal:U1", createdBy: "U1", seed: "reference", onError: () => {} },
    openStored: async (id) => {
      const opened = await store.open(id);
      return opened ? { ...opened.artifact, stream: opened.stream } : null;
    },
  });
  await staging.attach(["report.txt"]);
  const id = staging.staged()[0]!.artifactId!;
  await staging.attach([{ file_id: id }]);
  await staging.attach(["report.txt"]);
  assert.equal(staging.staged().length, 2);
  assert.ok(await store.open(id), "the staged file ID remains readable");
});

const MIRROR_NOTE =
  "Context comes from stored Slack events. Earlier messages, missed events, reactions, and attachment details may be absent; this is not a complete Slack history.";
const TRUNCATED_NOTE = "Slack history is truncated; older messages may be absent.";

function pagedSurface(
  messages: Array<{ ts: string; text: string }>,
  pageSize: number,
  opts: { failAfterPulls?: number; abortAfterPulls?: number; live?: boolean } = {},
) {
  const pulls: Array<{ before?: string; match?: string }> = [];
  const abort = new AbortController();
  const pull = async (_source: string, query: { before?: string; match?: string; count?: number }) => {
    pulls.push({ ...(query.before ? { before: query.before } : {}), ...(query.match ? { match: query.match } : {}) });
    if (opts.failAfterPulls !== undefined && pulls.length > opts.failAfterPulls)
      return { messages: [], note: "Slack is rate limiting history reads; try again in a minute." };
    if (opts.abortAfterPulls !== undefined && pulls.length >= opts.abortAfterPulls) abort.abort();
    const older = query.before ? messages.filter((m) => m.ts < query.before!) : messages;
    const scanned = older.slice(-pageSize);
    const scanHasMore = scanned.length < older.length;
    const needle = query.match?.trim().toLowerCase();
    const matched = needle ? scanned.filter((m) => m.text.toLowerCase().includes(needle)) : scanned;
    const kept = matched.slice(-(query.count ?? pageSize));
    const droppedMatches = matched.length > kept.length;
    let nextBefore: string | undefined;
    if (droppedMatches) nextBefore = kept[0]?.ts;
    else if (scanHasMore) nextBefore = scanned[0]?.ts;
    let note: string | undefined = MIRROR_NOTE;
    if (opts.live) note = scanHasMore ? TRUNCATED_NOTE : undefined;
    return {
      messages: kept,
      hasMore: scanHasMore || droppedMatches,
      ...(nextBefore ? { nextBefore } : {}),
      ...(note ? { note } : {}),
      selfTs: [],
    };
  };
  const tools = createSurfaceToolDeps({
    deps: { outbound: {}, surfaceContext: { pull } },
    input: { surfaceTools: true, surface: "web" },
    actor: { id: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1" },
    session: { id: "S1" },
    scopeId: "personal:U1",
    defaultDestination: { type: "web", target: "dm:U1" },
    strictReadOnly: false,
    blobTransfer: {},
    fileRegistration: {},
    provision: async () => handle,
    postProvenance() {
      return {};
    },
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0 },
    signal: abort.signal,
  } as unknown as SurfaceToolsContext)!;
  return { tools, pulls };
}

const history = (count: number, text: (i: number) => string = (i) => `m${i}`) =>
  Array.from({ length: count }, (_, i) => ({ ts: String(1000 + i).padStart(6, "0"), text: text(i) }));

test("whatsNew pages back through the surface until it reaches the caller's checkpoint", async () => {
  for (const live of [false, true]) {
    const { tools, pulls } = pagedSurface(history(1000), 200, { live });
    const result = await tools.whatsNew({ since: "001300" });
    assert.ok(result.ok);
    assert.equal(result.hereNew, 699);
    assert.doesNotMatch(result.message ?? "", /Counts cover only/, "every message after the checkpoint was counted");
    assert.equal(pulls.length, 4, `${live ? "live" : "mirror"} pages carry their standing note and still page`);
    const unanchored = await pagedSurface(history(1000), 200, { live }).tools.whatsNew();
    assert.ok(unanchored.ok);
    assert.match(unanchored.message!, /Counts cover only the newest 200 messages\./);
  }
});

test("live search pages back until it has the requested hits, and says how far it got when it stops short", async () => {
  const needles = history(1000, (i) => (i % 150 === 0 ? `needle ${"x".repeat(900)} ${i}` : `hay ${i}`));
  const { tools, pulls } = pagedSurface(needles, 200, { live: true });
  const result = await tools.search("needle", { limit: 3 });
  assert.ok(result.ok);
  assert.equal(result.hits!.length, 3);
  assert.ok(
    result.hits!.every((hit) => hit.snippet.length > 900),
    "hits carry the whole message",
  );
  assert.equal(pulls.length, 2);
  assert.match(result.message!, /Searched only the newest 400 messages\./, "the scanned count, not the matched count");
  const everything = await pagedSurface(needles, 200, { live: true }).tools.search("needle", { limit: 50 });
  assert.ok(everything.ok);
  assert.equal(everything.hits!.length, 7);
  assert.doesNotMatch(everything.message ?? "", /Searched only/);
});

test("search keeps paging through pages with no match while the surface still advances", async () => {
  const sparse = history(1000, (i) => (i === 10 ? "needle here" : `hay ${i}`));
  const { tools, pulls } = pagedSurface(sparse, 200);
  const result = await tools.search("needle", { limit: 1 });
  assert.ok(result.ok);
  assert.equal(result.hits!.length, 1);
  assert.equal(pulls.length, 5);
});

test("paging stops at the first surface failure such as a rate limit, keeping what it has", async () => {
  const { tools, pulls } = pagedSurface(history(1000), 200, { failAfterPulls: 2 });
  const result = await tools.search("m", { limit: 5000 });
  assert.ok(result.ok);
  assert.equal(pulls.length, 3, "the failing page is the last one asked for");
  assert.match(result.message!, /rate limiting/);
  assert.match(result.message!, /Searched only the newest 400 messages\./);
  assert.equal(result.hits!.length, 400);
});

test("paging stops when the turn is aborted", async () => {
  const { tools, pulls } = pagedSurface(history(1000), 200, { abortAfterPulls: 2 });
  const result = await tools.whatsNew({ since: "000000" });
  assert.ok(result.ok);
  assert.equal(pulls.length, 2);
  assert.match(result.message!, /Counts cover only the newest 400 messages\./);
});

test("one call reads at most a fifth of Slack's per-minute history budget, then says how far it got", async () => {
  const { tools, pulls } = pagedSurface(history(5000), 200);
  const result = await tools.whatsNew({ since: "000000" });
  assert.ok(result.ok);
  assert.equal(pulls.length, 10);
  assert.match(result.message!, /Counts cover only the newest 2000 messages\./);
});

test("surface readFile pages a long text file and resumes at each next offset", async () => {
  const text = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const chunks = Array.from({ length: 50 }, (_, i) => Buffer.from(text.slice(i * 1000, (i + 1) * 1000)));
  const blobId = "0".repeat(32);
  const tools = createSurfaceToolDeps({
    deps: { outbound: {} },
    input: { surfaceTools: true },
    defaultDestination: {},
    strictReadOnly: false,
    blobTransfer: {
      async open(id: string) {
        return id === blobId ? { stream: Readable.from(chunks), sizeBytes: text.length } : null;
      },
    },
    fileRegistration: {},
    postKeys: turnPostKeys("run-test"),
    spine: { surfaceOutboundCount: 0 },
    signal: new AbortController().signal,
  } as unknown as SurfaceToolsContext)!;
  let read = "";
  let offset: number | undefined = 0;
  const offsets: number[] = [];
  while (offset !== undefined) {
    offsets.push(offset);
    const page = await tools.readFile(blobId, offset);
    assert.ok(page.ok && "content" in page);
    read += page.content;
    offset = page.nextOffset;
  }
  assert.equal(read, text);
  assert.deepEqual(offsets, [0, 20_000, 40_000]);
  const past = await tools.readFile(blobId, 60_000);
  assert.deepEqual(past.ok && "content" in past ? [past.content, past.nextOffset] : null, ["", undefined]);
});
