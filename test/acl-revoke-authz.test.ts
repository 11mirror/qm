import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId, type Grant } from "../src/types.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const owner = scopeId("personal", "U1");
const carol = scopeId("personal", "U2");
const org = scopeId("org", "default-org");
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: owner,
  ref: "F1",
  granteeScopeId: carol,
  permission: "read",
  grantedBy: "U1",
  ...over,
});

async function putFile(files: FileArtifactStore, ownerScopeId: string) {
  await files.put({
    id: "F1",
    ownerScopeId,
    createdBy: "U1",
    name: "redline.md",
    path: "artifacts/F1/redline.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
}

async function fileAcl(ownerScopeId: string) {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await putFile(files, ownerScopeId);
  return createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
}

test("revoke has the same owner check as grant: a non-owner cannot revoke a personal-scope grant", async () => {
  const acl = await fileAcl(owner);
  await acl.grant(grant());
  await assert.rejects(acl.revoke(owner, "F1", carol, "U2"), /only a manager/);
  assert.equal((await acl.grantsFor(owner, "F1")).length, 1, "the grant survives the rejected revoke");
  await acl.revoke(owner, "F1", carol, "U1");
  assert.equal((await acl.grantsFor(owner, "F1")).length, 0, "the owner can revoke");
});

test("org-owned grants have no single owner, so revoke is not owner-gated (same as grant)", async () => {
  const acl = await fileAcl(org);
  await acl.grant(grant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.revoke(org, "F1", carol, "someone-else");
  assert.equal((await acl.grantsFor(org, "F1")).length, 0);
});
