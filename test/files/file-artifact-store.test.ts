import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createApp, type AppDeps } from "../../src/api/app.ts";
import { collectNamedOutbound, type ArtifactRegistration, materializeInbound } from "../../src/core/attachments.ts";
import { createAttachStaging } from "../../src/core/orchestrator/attach-tool.ts";
import {
  createMemoryDurableByteStore,
  createLocalDurableByteStore,
  ByteSourceTooLargeError,
  type DurableByteStore,
} from "../../src/files/durable-byte-store.ts";
import { fileArtifactId, type PutFileInput, type FileArtifactStore } from "../../src/files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import { collectBlob } from "../../src/persistence/blob-transfer.ts";
import { principalEntitledToScope } from "../../src/resolution/context-filter.ts";
import { defaultPublishAudience } from "../../src/resolution/publish-audience.ts";
import { carriedFileHandles } from "../../src/resolution/sharing-access.ts";
import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { createToolContext } from "../../src/tools/tool-context.ts";
import { scopeId, type Principal } from "../../src/types.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import { assertDocumentListing, assertSharedRecordIdentity } from "../support/file-document-listing.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createMemoryBlobTransferStore } from "../support/in-process-stores.ts";

const owner = scopeId("channel", "C1");
const other = scopeId("personal", "U9");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0x7f]);

async function drain(
  store: { open(id: string): Promise<{ stream: NodeJS.ReadableStream } | null> },
  id: string,
): Promise<Buffer> {
  const opened = await store.open(id);
  assert.ok(opened, "expected openable bytes");
  const chunks: Buffer[] = [];
  for await (const c of opened!.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function put(over: Partial<PutFileInput> = {}): PutFileInput {
  return {
    id: fileArtifactId("run-1", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "pirate_flag.png",
    path: "artifacts/flag.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
    createdInScope: owner,
    createdAt: 1000,
    ...over,
  };
}

test("fileArtifactId is deterministic per (seed, direction, index) and varies otherwise", () => {
  assert.equal(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "out", 0));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "out", 1));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-1", "in", 0));
  assert.notEqual(fileArtifactId("run-1", "out", 0), fileArtifactId("run-2", "out", 0));
});

test("DurableByteStore (memory) round-trips binary intact and content-addresses (dedup)", async () => {
  const bytes = createMemoryDurableByteStore();
  const a = await bytes.put(PNG);
  assert.equal(a.blobKey, `files/${a.sha256}`);
  assert.equal(a.sizeBytes, PNG.length);
  const b = await bytes.put(PNG);
  assert.equal(b.blobKey, a.blobKey);
  const back = await drain(bytes as DurableByteStore as never, a.blobKey);
  assert.deepEqual(back, PNG, "binary must survive the store byte-for-byte");
});

test("DurableByteStore (local-fs) round-trips binary intact across a fresh store instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docstore-"));
  try {
    const w = createLocalDurableByteStore(dir);
    const { blobKey } = await w.put(PNG);
    const r = createLocalDurableByteStore(dir);
    const back = await drain(r as never, blobKey);
    assert.deepEqual(back, PNG);
    const again = await w.put(PNG);
    assert.equal(again.blobKey, blobKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DurableByteStore (local-fs) accepts concurrent identical writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docstore-"));
  try {
    const bytes = createLocalDurableByteStore(dir);
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024, 7)]);
    const results = await Promise.all(Array.from({ length: 8 }, () => bytes.put(big)));
    for (const r of results) assert.equal(r.blobKey, results[0]!.blobKey);
    assert.deepEqual(await drain(bytes as never, results[0]!.blobKey), big);
    const leftovers = (await readdir(join(dir, "files"))).filter((name) => name.endsWith(".part"));
    assert.deepEqual(leftovers, [], "no orphaned partial files survive the race");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DurableByteStore enforces maxBytes mid-stream", async () => {
  const bytes = createMemoryDurableByteStore();
  await assert.rejects(bytes.put(Buffer.alloc(1000), { maxBytes: 10 }), ByteSourceTooLargeError);
});

test("DurableByteStore.open returns null for an absent or malformed key", async () => {
  const bytes = createMemoryDurableByteStore();
  assert.equal(await bytes.open("files/" + "0".repeat(64)), null);
  assert.equal(await bytes.open("not-a-key"), null);
});

test("put: deterministic id makes a requeue a no-op upsert (no dup, no byte re-store)", async () => {
  const bytes = createMemoryDurableByteStore();
  let putCount = 0;
  const counting: DurableByteStore = {
    put: (s, o) => {
      putCount++;
      return bytes.put(s, o);
    },
    open: (k) => bytes.open(k),
    delete: (k) => bytes.delete(k),
  };
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), counting);

  const first = await store.put(put());
  assert.equal(first.created, true);
  const second = await store.put(put({ name: "ignored-rename.png" }));
  assert.equal(second.created, false);
  assert.equal(second.artifact.name, "pirate_flag.png", "existing row returned unchanged");
  assert.equal(putCount, 1, "no byte re-store on requeue");

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1, "no duplicate row");
});

test("put + open round-trips binary through the artifact store", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const { artifact } = await store.put(put());
  assert.equal(artifact.mimetype, "image/png");
  assert.equal(artifact.sizeBytes, PNG.length);
  assert.equal(artifact.blobKey, `files/${artifact.sha256}`);
  const back = await drain(store, artifact.id);
  assert.deepEqual(back, PNG);
});

test("listOwnedByScopes: recency DESC, scope-filtered, keyset-paginated", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));
  await store.put(put({ id: "z", ownerScopeId: other, path: "p/z", data: Buffer.from("z"), createdAt: 999 }));

  const all = await store.listOwnedByScopes([owner]);
  assert.deepEqual(
    all.files.map((f) => f.id),
    ["c", "b", "a"],
    "newest first, other-owner excluded",
  );

  const p1 = await store.listOwnedByScopes([owner], { limit: 2 });
  assert.deepEqual(
    p1.files.map((f) => f.id),
    ["c", "b"],
  );
  assert.ok(p1.nextCursor, "expected a next cursor");
  const p2 = await store.listOwnedByScopes([owner], { limit: 2, cursor: p1.nextCursor! });
  assert.deepEqual(
    p2.files.map((f) => f.id),
    ["a"],
  );
  assert.equal(p2.nextCursor, undefined, "last page has no cursor");
});

test("listOwnedByScopes: nameQuery matches names case-insensitively across the whole set", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await store.put(put({ id: "a", name: "Quarterly Report.pdf", path: "p/a", data: Buffer.from("a"), createdAt: 100 }));
  await store.put(put({ id: "b", name: "notes.txt", path: "p/b", data: Buffer.from("b"), createdAt: 200 }));
  await store.put(put({ id: "c", name: "report-draft.txt", path: "p/c", data: Buffer.from("c"), createdAt: 300 }));

  const hit = await store.listOwnedByScopes([owner], { nameQuery: "REPORT" });
  assert.deepEqual(
    hit.files.map((f) => f.id),
    ["c", "a"],
    "matches by name regardless of case, newest first",
  );
  assert.equal((await store.listOwnedByScopes([owner], { nameQuery: "missing" })).files.length, 0);
});

test("resolveByIds returns the SHARED set by (owner, id); disabled excluded", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await store.put(put({ id: "a", path: "p/a", data: Buffer.from("a") }));
  await store.put(put({ id: "b", path: "p/b", data: Buffer.from("b") }));

  const hit = await store.resolveByIds([{ ownerScopeId: owner, id: "a" }]);
  assert.deepEqual(
    hit.map((f) => f.id),
    ["a"],
  );

  await store.setEnabled("a", false);
  assert.equal((await store.resolveByIds([{ ownerScopeId: owner, id: "a" }])).length, 0, "disabled excluded");
  assert.equal(await store.get("a"), null, "get hides disabled by default");
  assert.ok(await store.get("a", { includeDisabled: true }), "get can surface disabled");
});

test("delete removes the ROW only — bytes shared with another row stay openable", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const { artifact: out } = await store.put(put({ id: "out", direction: "out", path: "p/out", data: PNG }));
  const { artifact: inb } = await store.put(put({ id: "in", direction: "in", path: "p/in", data: PNG }));
  assert.equal(out.blobKey, inb.blobKey, "identical bytes dedup to one blob");

  await store.delete("out");
  assert.equal(await store.get("out"), null, "row gone");
  const back = await drain(store, "in");
  assert.deepEqual(back, PNG, "the surviving row's bytes are intact (no inline byte delete)");
});

test("document listing groups authorized copies before pagination", async () => {
  await assertDocumentListing(createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()));
});

test("document listing keeps unknown hashes separate and picks deterministic representatives", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const { artifact: b } = await store.put(put({ id: "b", path: "b", createdAt: 100 }));
  await store.put(put({ id: "a", path: "a", createdAt: 100 }));
  for (const id of ["unknown-1", "unknown-2"]) {
    const { data: _data, ...input } = put({ id, path: id, createdAt: 100 });
    await store.publish({ ...input, blobKey: b.blobKey!, sizeBytes: b.sizeBytes, sha256: null });
  }
  assert.deepEqual(
    (await store.listDocuments([owner], [])).files.map((f) => f.id),
    ["unknown-2", "unknown-1", "a"],
  );
});

test("local stream failure removes partial bytes and publishes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qm-file-failure-"));
  try {
    const bytes = createLocalDurableByteStore(dir);
    async function* failing() {
      yield Buffer.alloc(1024);
      throw new Error("source disconnected");
    }
    await assert.rejects(bytes.put(failing()), /source disconnected/);
    assert.deepEqual(await readdir(join(dir, "files")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared file refs authorize only the exact record ID", async () => {
  await assertSharedRecordIdentity(createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore()));
});

const person = (id: string, teamIds?: string[]): Principal => ({
  id,
  type: "internal",
  ...(teamIds ? { teamIds } : {}),
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff]);
const fileShareOwner = scopeId("personal", "U1");
const grantee = scopeId("personal", "U2");

function fixture() {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  return {
    files,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
      resolveFiles: (refs) => files.resolveByIds(refs),
    }),
  };
}

async function fileSharePut(files: FileArtifactStore, ownerScopeId: string, name: string, data: Uint8Array) {
  const id = fileArtifactId(`${ownerScopeId}:${name}`, "in", 0);
  return (
    await files.put({
      id,
      ownerScopeId,
      createdBy: "U1",
      name,
      path: name,
      mimetype: name.endsWith(".jpg") ? "image/jpeg" : "text/plain",
      data,
      direction: "in",
    })
  ).artifact;
}

for (const carried of [false, true]) {
  test(`${carried ? "carried" : "explicitly shared"} Files records read inline or return a sendable binary ID without a computer`, async () => {
    const { files, acl } = fixture();
    const image = await fileSharePut(files, fileShareOwner, "orange.jpg", JPEG);
    const text = await fileSharePut(files, fileShareOwner, "notes.txt", Buffer.from("the plan"));
    for (const file of [image, text])
      await acl.grant({
        ownerScopeId: fileShareOwner,
        ref: file.id,
        granteeScopeId: grantee,
        permission: "read",
        grantedBy: "U1",
      });
    const handles = carried ? await carriedFileHandles([fileShareOwner], files) : await acl.handlesFor([grantee]);
    const noComputer = async (): Promise<never> => {
      throw new Error("must not provision a computer");
    };
    const ctx = createToolContext({
      sandbox: {} as Sandbox,
      provision: noComputer,
      layers: [{ scopeId: grantee, mountPath: "", mode: "rw" }],
      commandPolicy: () => ({}) as never,
      authorizeCommand: () => false,
      grantedHandles: handles,
      workspace: createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "fshare-"))),
      files,
      deploy: {} as never,
      acl,
      createdBy: "U2",
    });
    const textHandle = handles.find((handle) => handle.fileId === text.id)!;
    assert.deepEqual(await ctx.read(textHandle.handlePath), {
      content: "the plan",
      sourceScopeId: fileShareOwner,
      shared: true,
    });
    const imageHandle = handles.find((handle) => handle.fileId === image.id)!;
    assert.deepEqual(await ctx.read(imageHandle.handlePath), {
      content: `[binary file orange.jpg, Files ID ${image.id}; send it by ID]`,
      sourceScopeId: fileShareOwner,
      shared: true,
    });
    const transfer = createMemoryBlobTransferStore();
    const staging = createAttachStaging({
      sandbox: {} as Sandbox,
      provision: noComputer,
      blobTransfer: transfer,
      fileRegistration: { store: files, ownerScopeId: grantee, createdBy: "U2", seed: "send", onError: () => {} },
      openStored: async (id) => {
        if (!handles.some((handle) => handle.fileId === id)) return null;
        const file = await files.get(id);
        const opened = await files.open(id);
        return file && opened ? { ...opened, name: file.name, mimetype: file.mimetype } : null;
      },
    });
    assert.equal((await staging.attach([{ file_id: image.id }])).ok, true);
    const sent = await transfer.open(staging.staged()[0]!.blobId);
    assert.deepEqual(await collectBlob(sent!.stream), Buffer.from(JPEG));
  });
}

test("workspace paths cannot be granted even when a Files record has that path", async () => {
  const { files, acl } = fixture();
  const file = await fileSharePut(files, fileShareOwner, "notes.txt", Buffer.from("the plan"));
  await assert.rejects(
    acl.grant({
      ownerScopeId: fileShareOwner,
      ref: file.path,
      granteeScopeId: grantee,
      permission: "read",
      grantedBy: "U1",
    }),
    /Files record ID/,
  );
  assert.deepEqual(await acl.list(), []);
  await acl.grant({
    ownerScopeId: fileShareOwner,
    ref: file.id,
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "U1",
  });
  assert.deepEqual(await acl.handlesFor([grantee]), [
    { handlePath: "shared/notes.txt", ownerScopeId: fileShareOwner, fileId: file.id, permission: "read" },
  ]);
});

test("a person-grant resolves in a shared room of {owner, grantee} — but never leaks to an unentitled member", async () => {
  const { files, acl } = fixture();
  const alice = scopeId("personal", "U1");
  const carol = scopeId("personal", "U2");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const image = await fileSharePut(files, alice, "orange.jpg", JPEG);
  await acl.grant({
    ownerScopeId: alice,
    ref: image.id,
    granteeScopeId: carol,
    permission: "read",
    grantedBy: "U1",
  });

  const inRoom = await acl.handlesForAudience([person("U1"), person("U2")], channel, org, principalEntitledToScope);
  assert.deepEqual(
    inRoom.map((h) => h.handlePath),
    ["shared/orange.jpg"],
  );
  assert.equal(inRoom[0]!.ownerScopeId, alice);

  const withAlicePresent = await acl.handlesForAudience(
    [person("U1"), person("U2"), person("U3")],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(withAlicePresent, []);

  assert.equal((await acl.handlesForAudience([person("U2")], carol, org, principalEntitledToScope)).length, 1);
  assert.equal((await acl.handlesForAudience([person("U1")], alice, org, principalEntitledToScope)).length, 0);
});

test("an org grant surfaces for the whole audience; a team grant only when every member is in the team", async () => {
  const { files, acl } = fixture();
  const alice = scopeId("personal", "U1");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const poster = await fileSharePut(files, alice, "poster.png", JPEG);
  const playbook = await fileSharePut(files, alice, "playbook.md", Buffer.from("plan"));
  await acl.grant({ ownerScopeId: alice, ref: poster.id, granteeScopeId: org, permission: "read", grantedBy: "U1" });
  await acl.grant({
    ownerScopeId: alice,
    ref: playbook.id,
    granteeScopeId: scopeId("team", "T1"),
    permission: "read",
    grantedBy: "U1",
  });

  const mixed = await acl.handlesForAudience(
    [person("U1", ["T1"]), person("U2")],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(mixed.map((h) => h.handlePath).sort(), ["shared/poster.png"]);

  const allInTeam = await acl.handlesForAudience(
    [person("U1", ["T1"]), person("U2", ["T1"])],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(allInTeam.map((h) => h.handlePath).sort(), ["shared/playbook.md", "shared/poster.png"]);
});

const ORG = "default-org";
const initiator = "U1";
const HANDLE = { id: "h", rootDir: "/workspace" } as SandboxHandle;
const FILE_CHANNEL_SHARE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

function memSandbox(files: Record<string, Uint8Array>): Sandbox {
  const map = new Map(Object.entries(files));
  return {
    async listDir(_h: SandboxHandle, dir: string) {
      return [...map.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return map.get(rel) ?? null;
    },
  } as unknown as Sandbox;
}

function registration(
  store: FileArtifactStore,
  acl: ReturnType<typeof createAclStore>,
  isPrivate: boolean | undefined,
  kind: "dm" | "channel",
): ArtifactRegistration {
  const grantees = defaultPublishAudience({
    kind,
    ...(isPrivate !== undefined ? { isPrivate } : {}),
    orgScopeId: scopeId("org", ORG),
    ownerId: initiator,
  }).grantees;
  return {
    store,
    ownerScopeId: scopeId("personal", initiator),
    createdBy: initiator,
    createdInScope: kind === "channel" ? scopeId("channel", "C1") : scopeId("personal", initiator),
    seed: "run-1",
    onError: () => {},
    ...(grantees.length
      ? {
          onRegistered: async ({ ownerScopeId, id }) => {
            for (const granteeScopeId of grantees) {
              await acl.grant({ ownerScopeId, ref: id, granteeScopeId, permission: "read", grantedBy: initiator });
            }
          },
        }
      : {}),
  };
}

function makeApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  return createApp({
    acl,
    files,
    identity: createIdentityService(testDatabaseUrl()),
  } as unknown as AppDeps);
}

test("a file delivered in a PUBLIC channel is auto-shared (read) with the org — visible to other members", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  await collectNamedOutbound(
    memSandbox({ "flag.png": FILE_CHANNEL_SHARE_PNG }),
    HANDLE,
    ["flag.png"],
    createMemoryBlobTransferStore(),
    registration(files, acl, false, "channel"),
  );

  const u1 = await makeApp(files, acl).listFilesForViewer(initiator);
  assert.equal(u1.owned.length, 1);
  assert.equal(u1.owned[0]!.name, "flag.png");

  const app = makeApp(files, acl);
  const u2 = await app.listFilesForViewer("U2");
  assert.equal(u2.owned.length, 0, "U2 doesn't own it");
  assert.equal(u2.shared.length, 1, "the org read grant surfaces it to U2");
  const opened = await app.openFileForViewer(u2.shared[0]!.id, "U2");
  assert.ok(opened, "the org grant authorizes the bytes");
});

test("a file delivered in a DM stays owner-only — no auto-share", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  await collectNamedOutbound(
    memSandbox({ "note.txt": Buffer.from("private") }),
    HANDLE,
    ["note.txt"],
    createMemoryBlobTransferStore(),
    registration(files, acl, undefined, "dm"),
  );

  assert.equal((await makeApp(files, acl).listFilesForViewer(initiator)).owned.length, 1, "owner sees it");
  const u2 = await makeApp(files, acl).listFilesForViewer("U2");
  assert.equal(u2.owned.length + u2.shared.length, 0, "nobody else sees a DM file");
});

const FILE_STORE_POPULATION_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

function fileStorePopulationMemSandbox(seed: Record<string, Uint8Array | string> = {}): {
  sandbox: Sandbox;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) files.set(k, typeof v === "string" ? Buffer.from(v) : v);
  const sandbox = {
    async listDir(_h: SandboxHandle, dir: string) {
      return [...files.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      files.set(rel, data);
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, Buffer.from(data));
    },
    async readFile(_h: SandboxHandle, rel: string) {
      const b = files.get(rel);
      return b ? Buffer.from(b).toString("utf8") : null;
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

function reg(store: FileArtifactStore, over: Partial<ArtifactRegistration> = {}): ArtifactRegistration {
  return {
    store,
    ownerScopeId: owner,
    createdBy: "U1",
    createdInScope: owner,
    seed: "run-1",
    onError: () => {},
    ...over,
  };
}

async function fileStorePopulationDrain(store: FileArtifactStore, id: string): Promise<Buffer> {
  const o = await store.open(id);
  assert.ok(o, "expected openable bytes");
  const chunks: Buffer[] = [];
  for await (const c of o!.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("collectNamedOutbound registers an 'out' artifact at the registration owner, openable", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const { sandbox } = fileStorePopulationMemSandbox({ "flag.png": FILE_STORE_POPULATION_PNG });

  const out = await collectNamedOutbound(sandbox, HANDLE, ["flag.png"], createMemoryBlobTransferStore(), reg(store));
  assert.equal(out.attachments.length, 1, "the file is still delivered");

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1);
  const a = page.files[0]!;
  assert.equal(out.attachments[0]!.artifactId, a.id, "delivery attachment points at its durable artifact");
  assert.equal(out.attachments[0]!.artifactViewerId, "U1", "surface replay can re-open as the creator");
  assert.equal(a.direction, "out");
  assert.equal(a.ownerScopeId, owner);
  assert.equal(a.name, "flag.png");
  assert.deepEqual(
    await fileStorePopulationDrain(store, a.id),
    FILE_STORE_POPULATION_PNG,
    "bytes captured into the doc store",
  );
});

test("collectNamedOutbound is idempotent on re-run with the same seed (G6 requeue: no dup row)", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const { sandbox } = fileStorePopulationMemSandbox({ "a.txt": "one", "b.txt": "two" });

  await collectNamedOutbound(sandbox, HANDLE, ["a.txt", "b.txt"], createMemoryBlobTransferStore(), reg(store));
  await collectNamedOutbound(sandbox, HANDLE, ["a.txt", "b.txt"], createMemoryBlobTransferStore(), reg(store));
  assert.equal((await store.listOwnedByScopes([owner])).files.length, 2, "two files, not four");
});

test("a doc-store fault does NOT break delivery (best-effort registration)", async () => {
  const throwing = {
    put: async () => {
      throw new Error("doc store down");
    },
  } as unknown as FileArtifactStore;
  const { sandbox } = fileStorePopulationMemSandbox({ "report.csv": "a,b,c" });
  const errors: unknown[] = [];

  const out = await collectNamedOutbound(
    sandbox,
    HANDLE,
    ["report.csv"],
    createMemoryBlobTransferStore(),
    reg(throwing, { onError: (e) => errors.push(e) }),
  );
  assert.equal(out.attachments.length, 1, "delivery still succeeds despite the store fault");
  assert.equal(errors.length, 1, "the fault is reported, not swallowed silently");
});

test("materializeInbound registers an 'in' artifact, openable", async () => {
  const store = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const transfer = createMemoryBlobTransferStore();
  const { blobId } = await transfer.put(FILE_STORE_POPULATION_PNG);
  const { sandbox } = fileStorePopulationMemSandbox();

  const inb = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "shared.png", mimetype: "image/png", sizeBytes: FILE_STORE_POPULATION_PNG.length, blobId }],
    transfer,
    reg(store),
  );
  assert.equal(inb.metas.length, 1);

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1);
  assert.equal(page.files[0]!.direction, "in");
  assert.deepEqual(await fileStorePopulationDrain(store, page.files[0]!.id), FILE_STORE_POPULATION_PNG);
  assert.equal(
    inb.metas[0]!.artifactId,
    page.files[0]!.id,
    "the persisted meta points at its durable artifact (surfaces re-render from it)",
  );
  assert.equal(
    inb.images[0]!.artifactId,
    page.files[0]!.id,
    "the exact model image carries the same durable ref for replay",
  );
});

test("materializeInbound omits artifactId when registration fails or is absent", async () => {
  const transfer = createMemoryBlobTransferStore();
  const { blobId } = await transfer.put(FILE_STORE_POPULATION_PNG);
  const { sandbox } = fileStorePopulationMemSandbox();
  const noReg = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "a.png", mimetype: "image/png", sizeBytes: FILE_STORE_POPULATION_PNG.length, blobId }],
    transfer,
  );
  assert.equal(noReg.metas[0]!.artifactId, undefined);

  const throwing = {
    put: async () => {
      throw new Error("doc store down");
    },
  } as unknown as FileArtifactStore;
  const { blobId: blob2 } = await transfer.put(FILE_STORE_POPULATION_PNG);
  const errors: unknown[] = [];
  const failed = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "b.png", mimetype: "image/png", sizeBytes: FILE_STORE_POPULATION_PNG.length, blobId: blob2 }],
    transfer,
    reg(throwing, { onError: (e) => errors.push(e) }),
  );
  assert.equal(failed.metas.length, 1, "the file still reaches the inbox");
  assert.equal(failed.metas[0]!.artifactId, undefined, "no artifactId is fabricated on a store fault");
  assert.equal(errors.length, 1);
});
