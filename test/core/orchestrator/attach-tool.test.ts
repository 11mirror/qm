import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Sandbox, SandboxHandle } from "../../../src/sandbox/sandbox.ts";
import type { BlobTransferStore } from "../../../src/persistence/blob-transfer.ts";
import { MAX_REPLY_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES } from "../../../src/core/attachments.ts";
import { createAttachStaging } from "../../../src/core/orchestrator/attach-tool.ts";
import { fakeSandbox } from "../../support/attachment-sandbox.ts";
import { createMemoryBlobTransferStore } from "../../support/in-process-stores.ts";

function attachStaging(sandbox: Sandbox, handle: SandboxHandle, blobTransfer: BlobTransferStore) {
  return createAttachStaging({
    sandbox,
    provision: async () => handle,
    blobTransfer,
    fileRegistration: {
      store: null as never,
      ownerScopeId: "personal:U1",
      createdBy: "U1",
      seed: "run-1",
      onError: () => {},
    },
  });
}

test("attach stages a named workspace file as a blob attachment", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  const transfer = createMemoryBlobTransferStore();
  files.set("report.csv", new Uint8Array(Buffer.from("a,b\n1,2")));
  files.set("keep.txt", new Uint8Array(Buffer.from("not attached")));
  const staging = attachStaging(sandbox, handle, transfer);
  const r = await staging.attach(["report.csv"]);
  assert.ok(r.ok);
  assert.deepEqual(
    r.files.map((f) => [f.name, f.mimetype, f.sizeBytes]),
    [["report.csv", "text/csv", 7]],
  );
  const staged = staging.staged();
  assert.equal(staged.length, 1, "only the named file rides out");
  const blob = await transfer.open(staged[0]!.blobId);
  assert.equal((await buffer(blob!.stream)).toString("utf8"), "a,b\n1,2");
});

test("attach delivers a safe basename for a nested path (not a Slack path)", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  files.set("sub/report.csv", new Uint8Array(Buffer.from("a,b")));
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  const r = await staging.attach(["sub/report.csv"]);
  assert.ok(r.ok);
  assert.equal(r.files[0]!.name, "report.csv");
});

test("attaching a missing, empty, or traversing path stages nothing and says which", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  files.set("blank.txt", new Uint8Array(0));
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  const missing = await staging.attach(["gone.md"]);
  assert.ok(!missing.ok);
  assert.match(missing.message, /gone\.md \(not found\)/);
  const empty = await staging.attach(["blank.txt"]);
  assert.ok(!empty.ok);
  assert.match(empty.message, /blank\.txt \(empty\)/);
  const traversal = await staging.attach(["../../etc/passwd"]);
  assert.ok(!traversal.ok);
  assert.match(traversal.message, /no \.\. path segments/);
  assert.equal(staging.staged().length, 0, "a failed call stages nothing at all");
});

test("attach refuses a file past the size cap", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  files.set("huge.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  const r = await staging.attach(["huge.bin"]);
  assert.ok(!r.ok);
  assert.match(r.message, /huge\.bin \(too large\)/);
  assert.equal(staging.staged().length, 0);
});

test("attach accumulates across calls, replaces a re-named path, and carries as many files as named", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  for (let i = 0; i < 40; i++) files.set(`f${i}.txt`, new Uint8Array(Buffer.from(`x${i}`)));
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  assert.ok((await staging.attach(["f0.txt"])).ok);
  assert.ok((await staging.attach(["f1.txt"])).ok);
  assert.equal(staging.staged().length, 2, "a second call adds to the set");
  assert.ok((await staging.attach(["f0.txt"])).ok);
  assert.equal(staging.staged().length, 2, "re-naming a path replaces it instead of duplicating");
  const rest = await staging.attach(Array.from({ length: 38 }, (_, i) => `f${i + 2}.txt`));
  assert.ok(rest.ok);
  assert.equal(staging.staged().length, 40);
});

test("a reply's files are bounded by their total bytes, counting what is already staged", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  files.set("a.bin", new Uint8Array(Buffer.from("aa")));
  files.set("b.bin", new Uint8Array(Buffer.from("bb")));
  files.set("c.bin", new Uint8Array(Buffer.from("c")));
  const memory = createMemoryBlobTransferStore();
  const nearlyFull = MAX_REPLY_ATTACHMENT_BYTES - 1;
  let inflate = true;
  const transfer: BlobTransferStore = {
    ...memory,
    put: async (source, opts) => {
      const blob = await memory.put(source, opts);
      return inflate ? { ...blob, sizeBytes: nearlyFull } : blob;
    },
  };
  const staging = attachStaging(sandbox, handle, transfer);
  assert.ok((await staging.attach(["a.bin"])).ok, "the first file is recorded at nearly the whole reply budget");
  inflate = false;
  const second = await staging.attach(["b.bin"]);
  assert.ok(!second.ok);
  assert.match(second.message, /b\.bin \(too large alongside the files already attached\)/);
  assert.doesNotMatch(second.message, /b\.bin \(too large\)/);
  assert.equal(staging.staged().length, 1, "the overflowing call stages nothing");
  assert.ok((await staging.attach(["a.bin", "c.bin"])).ok, "replacing the staged file frees its bytes");
  assert.equal(staging.staged().length, 2);
});

test("re-attaching a path replaces its staged bytes and releases the superseded blob", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  const transfer = createMemoryBlobTransferStore();
  files.set("report.md", new Uint8Array(Buffer.from("draft")));
  const staging = attachStaging(sandbox, handle, transfer);
  const first = await staging.attach(["report.md"]);
  assert.ok(first.ok);
  const staleBlobId = staging.staged()[0]!.blobId;
  files.set("report.md", new Uint8Array(Buffer.from("fixed")));
  assert.ok((await staging.attach(["report.md"])).ok);
  assert.equal(staging.staged().length, 1);
  const blob = await transfer.open(staging.staged()[0]!.blobId);
  assert.equal((await buffer(blob!.stream)).toString("utf8"), "fixed", "the reply carries the rewritten file");
  assert.equal(await transfer.open(staleBlobId), null, "the superseded bytes are not left behind");
});

test("two attached files that share a basename get distinct delivered names", async () => {
  const { sandbox, handle, files } = fakeSandbox();
  files.set("drafts/notes.txt", new Uint8Array(Buffer.from("one")));
  files.set("final/notes.txt", new Uint8Array(Buffer.from("two")));
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  assert.ok((await staging.attach(["drafts/notes.txt"])).ok);
  assert.ok((await staging.attach(["final/notes.txt"])).ok);
  assert.deepEqual(
    staging.staged().map((a) => a.name),
    ["notes.txt", "notes-2.txt"],
    "a later call cannot deliver a name an earlier one already took",
  );
});

test("attach needs at least one path", async () => {
  const { sandbox, handle } = fakeSandbox();
  const staging = attachStaging(sandbox, handle, createMemoryBlobTransferStore());
  const r = await staging.attach([]);
  assert.ok(!r.ok);
  assert.match(r.message, /at least one/);
});
