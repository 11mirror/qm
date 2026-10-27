import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createAclStore, type ScopeManagement, type GrantPersistence } from "../../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { deployRef, encodeRef, cronRef, parseRef, serviceCredRef, skillRef } from "../../src/acl/resource-ref.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import type { FileArtifactStore, FileArtifactRef } from "../../src/files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { principalEntitledToScope } from "../../src/resolution/context-filter.ts";
import { type Grant, scopeId, type Principal } from "../../src/types.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const owner = "org:default-org";
const ref = "service-cred:k";

test("conditional grant compensation preserves a newer full-tuple write", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  const original: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: owner,
    permission: "write",
    grantedBy: "original-governor",
  };
  const forward: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: "personal:alice",
    permission: "read",
    grantedBy: "editor",
  };
  const concurrent: Grant = {
    ownerScopeId: owner,
    ref,
    granteeScopeId: "team:security",
    permission: "write",
    grantedBy: "concurrent-governor",
  };
  await acl.grant(original);
  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [original], [forward], "editor"), true);
  await acl.grant(concurrent);

  assert.equal(await acl.replaceGrantsIfCurrent(owner, ref, [forward], [original], "editor"), false);
  assert.deepEqual(await acl.grantsFor(owner, ref), [forward, concurrent]);
});

const base = { ownerScopeId: "org:default-org", granteeScopeId: "personal:alice", permission: "read" } as const;

async function regrant(acl: ReturnType<typeof createAclStore>, ref: string): Promise<Grant[]> {
  await acl.grant({ ...base, ref, grantedBy: "first-admin" });
  await acl.grant({ ...base, ref, grantedBy: "second-admin" });
  return acl.grantsFor(base.ownerScopeId, ref);
}

test(
  "re-granting the same access records the latest granter (Postgres store)",
  { skip: !process.env.DATABASE_URL && "requires Postgres" },
  async () => {
    const persist = createPostgresGrantStore(process.env.DATABASE_URL!);
    const acl = createAclStore(persist, { manages: async () => true });
    const ref = `service-cred:regrant-${Date.now()}`;
    try {
      const grants = await regrant(acl, ref);
      assert.deepEqual(
        grants.map((g) => g.grantedBy),
        ["second-admin"],
      );
    } finally {
      await persist.remove({ ...base, ref, grantedBy: "second-admin" });
    }
  },
);

const revokeAuthzOwner = scopeId("personal", "U1");
const carol = scopeId("personal", "U2");
const org = scopeId("org", "default-org");
const grant = (over: Partial<Grant> = {}): Grant => ({
  ownerScopeId: revokeAuthzOwner,
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
  const acl = await fileAcl(revokeAuthzOwner);
  await acl.grant(grant());
  await assert.rejects(acl.revoke(revokeAuthzOwner, "F1", carol, "U2"), /only a manager/);
  assert.equal((await acl.grantsFor(revokeAuthzOwner, "F1")).length, 1, "the grant survives the rejected revoke");
  await acl.revoke(revokeAuthzOwner, "F1", carol, "U1");
  assert.equal((await acl.grantsFor(revokeAuthzOwner, "F1")).length, 0, "the owner can revoke");
});

test("org-owned grants have no single owner, so revoke is not owner-gated (same as grant)", async () => {
  const acl = await fileAcl(org);
  await acl.grant(grant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.revoke(org, "F1", carol, "someone-else");
  assert.equal((await acl.grantsFor(org, "F1")).length, 0);
});

const CHAN = scopeId("channel", "C1");
const GROUP = scopeId("group", "G1");
const CHAN_MEMBERS = new Set(["alice"]);
const GROUP_MEMBERS = new Set(["bob"]);

const manages: ScopeManagement = async (principalId, scope) => {
  if (scope === CHAN) return CHAN_MEMBERS.has(principalId);
  if (scope === GROUP) return GROUP_MEMBERS.has(principalId);
  return false;
};

const membershipManageRef = encodeRef(deployRef("d1"));
const membershipManageCarol = scopeId("personal", "carol");
const membershipManageGrant = (over: Partial<Grant>): Grant => ({
  ownerScopeId: CHAN,
  ref: membershipManageRef,
  granteeScopeId: membershipManageCarol,
  permission: "read",
  grantedBy: "alice",
  ...over,
});

test("a channel member may grant and revoke its artifacts (members manage)", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages });
  await acl.grant(membershipManageGrant({ grantedBy: "alice" }));
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 1);
  await acl.revoke(CHAN, membershipManageRef, membershipManageCarol, "alice");
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 0);
});

test("a non-member cannot grant or revoke a channel artifact", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages });
  await assert.rejects(acl.grant(membershipManageGrant({ grantedBy: "mallory" })), /only a manager/);
  await acl.grant(membershipManageGrant({ grantedBy: "alice" }));
  await assert.rejects(acl.revoke(CHAN, membershipManageRef, membershipManageCarol, "mallory"), /only a manager/);
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 1, "grant survives the rejected revoke");
});

test("a group-DM member may manage its artifacts; a non-member may not", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages });
  await acl.grant(membershipManageGrant({ ownerScopeId: GROUP, grantedBy: "bob" }));
  assert.equal((await acl.grantsFor(GROUP, membershipManageRef)).length, 1);
  await assert.rejects(acl.grant(membershipManageGrant({ ownerScopeId: GROUP, grantedBy: "alice" })), /only a manager/);
});

test("personal-scope owner authz is unchanged: only the owner manages", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages });
  const owner = scopeId("personal", "U1");
  await assert.rejects(acl.grant(membershipManageGrant({ ownerScopeId: owner, grantedBy: "U2" })), /only a manager/);
  await acl.grant(membershipManageGrant({ ownerScopeId: owner, grantedBy: "U1" }));
  assert.equal((await acl.grantsFor(owner, membershipManageRef)).length, 1);
});

test("without a membership predicate, channel/group grants pass unguarded (narrow unit slices)", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await acl.grant(membershipManageGrant({ grantedBy: "anyone" }));
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 1);
});

test("org/team home scopes are not membership-managed: grants pass unguarded as before", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages });
  const org = scopeId("org", "default-org");
  const team = scopeId("team", "eng");
  await acl.grant(membershipManageGrant({ ownerScopeId: org, grantedBy: "admin" }));
  await acl.grant(membershipManageGrant({ ownerScopeId: team, grantedBy: "someone" }));
  assert.equal((await acl.grantsFor(org, membershipManageRef)).length, 1);
  assert.equal((await acl.grantsFor(team, membershipManageRef)).length, 1);
});

const PUBCHAN = scopeId("channel", "PUB");
const managesWithAuthorDoor: ScopeManagement = async (principalId, scope, authoredBy) => {
  if (scope === CHAN) return CHAN_MEMBERS.has(principalId);
  if (scope === PUBCHAN) return authoredBy === principalId;
  return false;
};

test("a PUBLIC-channel artifact's author may grant when the guard is told the author (authoredBy)", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages: managesWithAuthorDoor });
  await acl.grant(membershipManageGrant({ ownerScopeId: PUBCHAN, grantedBy: "U1" }), "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, membershipManageRef)).length, 1);
});

test("a non-author on a PUBLIC channel is still denied — the author door does not open for members", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages: managesWithAuthorDoor });
  await assert.rejects(
    acl.grant(membershipManageGrant({ ownerScopeId: PUBCHAN, grantedBy: "U2" }), "U1"),
    /only a manager/,
  );
  await assert.rejects(acl.grant(membershipManageGrant({ ownerScopeId: PUBCHAN, grantedBy: "U1" })), /only a manager/);
  assert.equal((await acl.grantsFor(PUBCHAN, membershipManageRef)).length, 0);
});

test("the author door does NOT weaken a PRIVATE channel — authoredBy can't let a non-member author in", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages: managesWithAuthorDoor });
  await assert.rejects(
    acl.grant(membershipManageGrant({ ownerScopeId: CHAN, grantedBy: "U1" }), "U1"),
    /only a manager/,
  );
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 0);
  await acl.grant(membershipManageGrant({ ownerScopeId: CHAN, grantedBy: "alice" }), "U1");
  assert.equal((await acl.grantsFor(CHAN, membershipManageRef)).length, 1);
});

test("revoke honors the author door too: a PUBLIC-channel author may revoke, a non-author may not", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), { manages: managesWithAuthorDoor });
  await acl.grant(membershipManageGrant({ ownerScopeId: PUBCHAN, grantedBy: "U1" }), "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, membershipManageRef)).length, 1);
  await assert.rejects(acl.revoke(PUBCHAN, membershipManageRef, membershipManageCarol, "U2", "U1"), /only a manager/);
  assert.equal((await acl.grantsFor(PUBCHAN, membershipManageRef)).length, 1, "grant survives the rejected revoke");
  await acl.revoke(PUBCHAN, membershipManageRef, membershipManageCarol, "U1", "U1");
  assert.equal((await acl.grantsFor(PUBCHAN, membershipManageRef)).length, 0);
});

const fileGrantsOwner = "personal:alice";
const recipient = "personal:bob";
const fileGrantsOrg = "org:default-org";
const bob: Principal = { id: "bob", type: "internal", teamIds: [] };
const fileGrantsGrant: Grant = {
  ownerScopeId: fileGrantsOwner,
  ref: "F1",
  granteeScopeId: recipient,
  grantedBy: "alice",
  permission: "read",
};

async function fixture() {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await files.put({
    id: "F1",
    ownerScopeId: fileGrantsOwner,
    createdBy: "alice",
    name: "report.md",
    path: "reports/report.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
  return {
    files,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
      resolveFiles: (refs) => files.resolveByIds(refs),
    }),
  };
}

test("file grants require a real, enabled Files ID owned by the granting scope", async () => {
  const { files, acl } = await fixture();
  for (const ref of ["reports/report.md", "report.md", "artifacts/F1/report.md", "missing"]) {
    await assert.rejects(
      acl.grant({ ...fileGrantsGrant, ref }),
      /put the file in Files first using POST \/v1\/files\/uploads/,
    );
  }
  await assert.rejects(
    acl.grant({ ...fileGrantsGrant, ownerScopeId: recipient, grantedBy: "bob" }),
    /owned by the granting scope/,
  );
  await files.setEnabled("F1", false);
  await assert.rejects(acl.grant(fileGrantsGrant), /enabled Files record ID/);
  assert.deepEqual(await acl.list(), []);
  await files.setEnabled("F1", true);
  await acl.grant(fileGrantsGrant);
  assert.deepEqual(await acl.list(), [fileGrantsGrant]);
});

test("missing Files resolver fails closed for grants and replacement grants", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await assert.rejects(acl.grant(fileGrantsGrant), /Files record ID/);
  await assert.rejects(
    acl.replaceGrantsIfCurrent(fileGrantsOwner, "F1", [], [fileGrantsGrant], "alice"),
    /Files record ID/,
  );
  assert.deepEqual(await acl.list(), []);
});

test("conditional replacement validates file grants before changing persisted access", async () => {
  const { files, acl } = await fixture();
  await acl.grant(fileGrantsGrant);
  const replacement: Grant = { ...fileGrantsGrant, permission: "write" };
  await files.setEnabled("F1", false);
  await assert.rejects(
    acl.replaceGrantsIfCurrent(fileGrantsOwner, "F1", [fileGrantsGrant], [replacement], "alice"),
    /enabled Files record ID/,
  );
  assert.deepEqual(await acl.list(), [fileGrantsGrant]);
  await files.setEnabled("F1", true);
  assert.equal(
    await acl.replaceGrantsIfCurrent(fileGrantsOwner, "F1", [fileGrantsGrant], [replacement], "alice"),
    true,
  );
  assert.deepEqual(await acl.list(), [replacement]);
  await files.delete("F1");
  assert.equal(await acl.replaceGrantsIfCurrent(fileGrantsOwner, "F1", [replacement], [], "alice"), true);
});

test("shared handles use the Files name and ID and disappear when the file is disabled or deleted", async () => {
  const { files, acl } = await fixture();
  await acl.grant(fileGrantsGrant);
  const expected = [
    { handlePath: "shared/report.md", fileId: "F1", ownerScopeId: fileGrantsOwner, permission: "read" },
  ];
  assert.deepEqual(await acl.handlesFor([recipient]), expected);
  assert.deepEqual(await acl.handlesForAudience([bob], recipient, fileGrantsOrg, principalEntitledToScope), expected);
  assert.deepEqual(await acl.handlesForAudience([], recipient, fileGrantsOrg, principalEntitledToScope), []);
  assert.deepEqual(
    await acl.handlesForAudience(
      [bob, { id: "outsider", type: "internal", teamIds: [] }],
      "channel:C1",
      fileGrantsOrg,
      principalEntitledToScope,
    ),
    [],
  );
  for (const remove of [() => files.setEnabled("F1", false), () => files.delete("F1")]) {
    await remove();
    assert.deepEqual(await acl.handlesFor([recipient]), []);
    assert.deepEqual(await acl.handlesForAudience([bob], recipient, fileGrantsOrg, principalEntitledToScope), []);
  }
});

test("legacy paths, missing Files records and wrong-owner references never produce handles", async () => {
  const { files } = await fixture();
  const persist: GrantPersistence = {
    all: async () => [
      { ...fileGrantsGrant, ref: "reports/report.md" },
      { ...fileGrantsGrant, ref: "missing" },
      { ...fileGrantsGrant, ownerScopeId: fileGrantsOrg },
    ],
    forResource: async () => [],
    put: async () => assert.fail("read-only fixture"),
    remove: async () => assert.fail("read-only fixture"),
    replaceForResourceIfCurrent: async () => assert.fail("read-only fixture"),
  };
  for (const opts of [{}, { resolveFiles: (refs: readonly FileArtifactRef[]) => files.resolveByIds(refs) }]) {
    const acl = createAclStore(persist, opts);
    assert.deepEqual(await acl.handlesFor([recipient]), []);
    assert.deepEqual(await acl.handlesForAudience([bob], recipient, fileGrantsOrg, principalEntitledToScope), []);
  }
});

const ORG = scopeId("org", "default-org");
const P = (id: string, teamIds: string[] = []): Principal => ({ id, type: "internal", teamIds });

function aclWith(grantees: string[]) {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  return Promise.all(
    grantees.map((g) =>
      acl.grant({
        ownerScopeId: ORG,
        ref: "service-cred:x",
        granteeScopeId: g,
        permission: "read",
        grantedBy: "admin",
      }),
    ),
  ).then(() => acl);
}

const slugs = (grants: { ref: string }[]) => grants.map((g) => g.ref.slice("service-cred:".length));

test("org-wide grant is usable by any audience (DM and channel)", async () => {
  const acl = await aclWith([ORG]);
  const dm = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(dm), ["x"]);
  const channel = await acl.grantsOfKind(
    "service-cred",
    [P("U1"), P("U2"), P("U3")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(channel), ["x"]);
});

test("personal grant: usable in the grantee's DM, FAILS CLOSED in a mixed channel", async () => {
  const acl = await aclWith([scopeId("personal", "bob")]);
  const bobDm = await acl.grantsOfKind(
    "service-cred",
    [P("bob")],
    scopeId("personal", "bob"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(bobDm), ["x"]);
  const mixed = await acl.grantsOfKind(
    "service-cred",
    [P("bob"), P("alice")],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(mixed), []);
  const aliceDm = await acl.grantsOfKind(
    "service-cred",
    [P("alice")],
    scopeId("personal", "alice"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(aliceDm), []);
});

test("team grant: usable when every member is on the team, fails closed otherwise", async () => {
  const acl = await aclWith([scopeId("team", "eng")]);
  const allEng = await acl.grantsOfKind(
    "service-cred",
    [P("U1", ["eng"]), P("U2", ["eng"])],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(allEng), ["x"]);
  const oneOutsider = await acl.grantsOfKind(
    "service-cred",
    [P("U1", ["eng"]), P("U2", ["sales"])],
    scopeId("channel", "C"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(oneOutsider), []);
});

test("channel grant: usable in that channel's conversations regardless of who is present, nowhere else", async () => {
  const acl = await aclWith([scopeId("channel", "C1")]);
  const inChannel = await acl.grantsOfKind(
    "service-cred",
    [P("U1"), P("U2"), P("U3")],
    scopeId("channel", "C1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(inChannel), ["x"]);
  const otherChannel = await acl.grantsOfKind(
    "service-cred",
    [P("U1"), P("U2")],
    scopeId("channel", "C2"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(otherChannel), []);
  const memberDm = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(memberDm), []);
});

test("empty audience is entitled to nothing (fail closed)", async () => {
  const acl = await aclWith([ORG]);
  assert.deepEqual(
    await acl.grantsOfKind("service-cred", [], scopeId("personal", "U1"), ORG, principalEntitledToScope),
    [],
  );
});

test("a service-cred grant owned by a NON-org scope is ignored (anti self-grant via the open /v1/grants route)", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await acl.grant({
    ownerScopeId: scopeId("personal", "attacker"),
    ref: "service-cred:foo",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "attacker",
  });
  const sneaky = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(sneaky), []);
  await acl.grant({
    ownerScopeId: ORG,
    ref: "service-cred:foo",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const legit = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(legit), ["foo"]);
});

test("the prefix filters: a deployment grant is never returned for the service-cred prefix", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await acl.grant({
    ownerScopeId: ORG,
    ref: "deployment:d1",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: "service-cred:x",
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const got = await acl.grantsOfKind(
    "service-cred",
    [P("U1")],
    scopeId("personal", "U1"),
    ORG,
    principalEntitledToScope,
  );
  assert.deepEqual(slugs(got), ["x"]);
});

test("file handles exclude non-file grants — a skill/cron/deploy grant never becomes a bogus shared/ file", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  await files.put({
    id: "F1",
    ownerScopeId: ORG,
    createdBy: "admin",
    name: "doc.md",
    path: "artifacts/F1/doc.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const grantee = scopeId("channel", "C");
  await acl.grant({
    ownerScopeId: ORG,
    ref: "F1",
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "admin",
  });
  for (const r of [skillRef("s1"), cronRef("c1"), deployRef("d1"), serviceCredRef("x")]) {
    await acl.grant({
      ownerScopeId: ORG,
      ref: encodeRef(r),
      granteeScopeId: grantee,
      permission: "read",
      grantedBy: "admin",
    });
  }
  const handles = await acl.handlesFor([grantee]);
  assert.deepEqual(
    handles.map((h) => h.fileId),
    ["F1"],
    "only the file grant materializes as a handle",
  );
  const audienceHandles = await acl.handlesForAudience([P("U1")], grantee, ORG, principalEntitledToScope);
  assert.deepEqual(
    audienceHandles.map((h) => h.fileId),
    ["F1"],
    "audience handles exclude skill/cron/deploy/service-cred grants",
  );
});

test("grantsOfKind selects by kind across all artifact families (one store, four kinds)", async () => {
  const acl = createAclStore(createPostgresGrantStore(testDatabaseUrl()));
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(skillRef("s1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(deployRef("d1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(cronRef("c1")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  await acl.grant({
    ownerScopeId: ORG,
    ref: encodeRef(serviceCredRef("x")),
    granteeScopeId: ORG,
    permission: "read",
    grantedBy: "admin",
  });
  const kinds = ["skill", "deploy", "cron", "service-cred"] as const;
  for (const kind of kinds) {
    const got = await acl.grantsOfKind(kind, [P("U1")], scopeId("personal", "U1"), ORG, principalEntitledToScope);
    assert.deepEqual(
      got.map((g) => parseRef(g.ref).kind),
      [kind],
      `only ${kind} grants come back for kind=${kind}`,
    );
  }
});
