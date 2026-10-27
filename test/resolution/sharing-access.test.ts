import { readContextFile } from "../../src/resolution/context-files.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { carriedFileHandles, isOpenScopeMember, sharingSourcesForTurn } from "../../src/resolution/sharing-access.ts";
import { scopeId, type Principal } from "../../src/types.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createIsCurrentSharedScopeMember } from "../../src/resolution/scope-membership.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import type { ParticipantScope } from "../../src/sessions/session-store.ts";

test("Open membership re-checks current room membership and never treats a personal scope as a room", async () => {
  const personal = scopeId("personal", "U1");
  const room = scopeId("channel", "C1");
  let member = true;
  const input = { actorId: "U1", scope: room, isCurrentSharedScopeMember: async () => member };
  assert.equal(await isOpenScopeMember(input), true);
  member = false;
  assert.equal(await isOpenScopeMember(input), false);
  member = true;
  assert.equal(await isOpenScopeMember({ ...input, scope: personal }), false);
});

test("open sources accept live human-authored ambient turns and bind carry to the authenticated actor", async () => {
  const sessions = { participantScopes: async () => [] };
  const targetScope = scopeId("channel", "C1");
  const actor: Principal = { id: "U2", type: "internal" };
  const base = {
    actor,
    trustedLiveHuman: true,
    targetScope,
    sessions,
    isCurrentSharedScopeMember: async () => true,
  };
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "human" } }), [scopeId("personal", "U2")]);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "automation" } }), []);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient", live: true } }), [
    scopeId("personal", "U2"),
  ]);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient" } }), []);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient", live: false } }), []);
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, trustedLiveHuman: false, origin: { kind: "ambient", live: true } }),
    [],
  );
  assert.deepEqual(
    await sharingSourcesForTurn({
      ...base,
      isCurrentSharedScopeMember: async () => false,
      origin: { kind: "ambient", live: true },
    }),
    [],
  );
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "direct" } }), []);
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, actor: { id: "U2", type: "guest" }, origin: { kind: "human" } }),
    [],
  );
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, isCurrentSharedScopeMember: async () => false, origin: { kind: "human" } }),
    [],
  );
  assert.deepEqual(await sharingSourcesForTurn({ ...base, trustedLiveHuman: false, origin: { kind: "human" } }), []);
});

test("current membership resolves directory identity aliases and fails closed when none match", async () => {
  const member = createIsCurrentSharedScopeMember({
    identity: { classify: () => ({ type: "internal" }) },
    directory: {
      get: async (principalId) =>
        principalId === "u1@example.com" ? { principalId: "u1@example.com", slackId: "U1" } : null,
      channelMember: async (_channelId, principalId) => principalId === "U1",
      groupMember: async () => false,
    },
  });
  assert.equal(await member("u1@example.com", scopeId("channel", "C1")), true);
  assert.equal(await member("unknown@example.com", scopeId("channel", "C1")), false);
  assert.equal(await member("u1@example.com", scopeId("personal", "u1@example.com")), false);
});

test("DM carry covers every room the actor is in, most recent first, non-transitive, and revoked by current membership", async () => {
  const actor: Principal = { id: "U1", type: "internal" };
  const personal = scopeId("personal", actor.id);
  const scopes: ParticipantScope[] = Array.from({ length: 300 }, (_, index) => ({
    scopeId: scopeId("channel", `C${index}`),
    sessionCount: 1,
    lastActivityAt: index,
  }));
  scopes.push({ scopeId: personal, sessionCount: 1, lastActivityAt: 1000 });
  const removed = scopeId("channel", "C299");
  const sources = await sharingSourcesForTurn({
    actor,
    origin: { kind: "human" },
    trustedLiveHuman: true,
    targetScope: personal,
    sessions: { participantScopes: async () => scopes },
    isCurrentSharedScopeMember: async (_actorId, source) => source !== removed,
  });
  assert.equal(sources.length, 299);
  assert.equal(sources.includes(removed), false);
  assert.equal(sources.includes(personal), false);
  assert.deepEqual(sources.slice(0, 2), [scopeId("channel", "C298"), scopeId("channel", "C297")]);
});

test("carried file handles expose only selected source scopes read-only without mounting them", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const personal = scopeId("personal", "U1");
  const teammate = scopeId("personal", "U2");
  await files.put({
    id: "1".repeat(32),
    ownerScopeId: personal,
    createdBy: "U1",
    name: "artifact.txt",
    path: `artifacts/${"1".repeat(32)}/artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("artifact"),
    direction: "in",
  });
  await files.put({
    id: "3".repeat(32),
    ownerScopeId: teammate,
    createdBy: "U2",
    name: "secret.txt",
    path: "secret.txt",
    mimetype: "text/plain",
    data: Buffer.from("theirs"),
    direction: "in",
  });
  const handles = await carriedFileHandles([personal], files);
  assert.deepEqual(
    handles.map((handle) => [handle.ownerScopeId, handle.fileId, handle.permission]),
    [[personal, "1".repeat(32), "read"]],
  );
  assert.equal(
    handles.some((handle) => handle.ownerScopeId === teammate),
    false,
  );
  const secondArtifactId = "2".repeat(32);
  await files.put({
    id: secondArtifactId,
    ownerScopeId: personal,
    createdBy: "U1",
    name: "artifact.txt",
    path: `artifacts/${secondArtifactId}/artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("second artifact"),
    direction: "in",
  });
  const handlesAgain = await carriedFileHandles([personal], files);
  assert.equal(new Set(handlesAgain.map((handle) => handle.handlePath)).size, 2);
  for (const handle of handlesAgain) {
    const read = await readContextFile(handle.handlePath, handlesAgain, files);
    assert.ok(read && "bytes" in read);
    assert.equal(read.bytes?.toString(), handle.fileId === secondArtifactId ? "second artifact" : "artifact");
  }
  assert.equal(
    handlesAgain.some((handle) => handle.fileId === secondArtifactId),
    true,
  );
});

test("Open file enumeration pages every selected scope to completion", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const scopes = [scopeId("personal", "U1"), scopeId("channel", "C1")];
  for (let i = 0; i < 210; i++) {
    await files.put({
      id: i.toString(16).padStart(32, "0"),
      ownerScopeId: scopes[i % 2]!,
      createdBy: "U1",
      name: `file-${i}.txt`,
      path: `file-${i}.txt`,
      mimetype: "text/plain",
      data: Buffer.from("file"),
      direction: "in",
    });
  }
  const handles = await carriedFileHandles(scopes, files);
  assert.equal(handles.length, 210);
  assert.equal(new Set(handles.map((handle) => handle.ownerScopeId)).size, 2);
});
