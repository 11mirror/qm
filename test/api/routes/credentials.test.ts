import "../../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { start, putCred, getCfg } from "../../support/service-credentials.ts";

test("admin creates a credential (default org-wide); GET projects it WITHOUT the secret", async () => {
  const srv = start();
  try {
    const r = await putCred(srv.base, {
      slug: "x-firehose",
      name: "X firehose",
      secret: "super-secret-bearer",
      host: "api.x.com",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/2/tweets/search/"],
    });
    assert.equal(r.status, 200);

    const cfg = await getCfg(srv.base);
    const cred = cfg.serviceCredentials.find((c) => c.slug === "x-firehose");
    assert.ok(cred);
    assert.equal(cred!.hasSecret, true);
    assert.deepEqual(cred!.grantees, ["org:default-org"]);
    assert.equal("usageCount" in cred, false);
    assert.doesNotMatch(JSON.stringify(cfg), /super-secret-bearer/);
  } finally {
    await srv.close();
  }
});

test("env-delivery credential: envKey validated, host refused, duplicates refused; projection carries delivery", async () => {
  const srv = start();
  try {
    assert.equal(
      (await putCred(srv.base, { slug: "browse-steel", name: "Steel", delivery: "env", secret: "s1" })).status,
      400,
      "envKey required",
    );
    assert.equal(
      (await putCred(srv.base, { slug: "browse-steel", name: "Steel", delivery: "env", envKey: "lower", secret: "s1" }))
        .status,
      400,
      "UPPER_SNAKE only",
    );
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "browse-steel",
          name: "Steel",
          delivery: "env",
          envKey: "AGENT_X",
          secret: "s1",
        })
      ).status,
      400,
      "AGENT_* reserved",
    );
    assert.equal(
      (
        await putCred(srv.base, {
          slug: "browse-steel",
          name: "Steel",
          delivery: "env",
          envKey: "STEEL_API_KEY",
          host: "steel.dev",
          secret: "s1",
        })
      ).status,
      400,
      "host is broker-only",
    );
    assert.equal(
      (await putCred(srv.base, { slug: "x", name: "X", envKey: "X_KEY", host: "api.x.com", secret: "s" })).status,
      400,
      "envKey is env-only",
    );

    const ok = await putCred(srv.base, {
      slug: "browse-steel",
      name: "Steel",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s1",
    });
    assert.equal(ok.status, 200);
    const dup = await putCred(srv.base, {
      slug: "browse-other",
      name: "Other",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s2",
    });
    assert.equal(dup.status, 400);
    assert.match(await dup.text(), /already delivered by credential/);

    const cfg = await getCfg(srv.base);
    const cred = cfg.serviceCredentials.find(
      (c) => c.slug === "browse-steel",
    ) as (typeof cfg.serviceCredentials)[number] & { delivery?: string; envKey?: string };
    assert.equal(cred?.delivery, "env");
    assert.equal(cred?.envKey, "STEEL_API_KEY");
    assert.doesNotMatch(JSON.stringify(cfg), /s1/);
  } finally {
    await srv.close();
  }
});

test("env-delivery accepts person/team grantees — grants now gate env injection like broker calls", async () => {
  const srv = start();
  try {
    const narrowed = await putCred(srv.base, {
      slug: "browse-steel",
      name: "Steel",
      delivery: "env",
      envKey: "STEEL_API_KEY",
      secret: "s1",
      grantees: ["personal:alice@default-org"],
    });
    assert.equal(narrowed.status, 200, "a person grant on an env credential is allowed");

    const orgWide = await putCred(srv.base, {
      slug: "browse-steel-wide",
      name: "Steel wide",
      delivery: "env",
      envKey: "STEEL_WIDE_API_KEY",
      secret: "s1",
      grantees: ["org:default-org"],
    });
    assert.equal(orgWide.status, 200, "the org grant is fine too");
  } finally {
    await srv.close();
  }
});

test("a non-admin cannot vend a credential (authz unchanged)", async () => {
  const srv = start();
  try {
    const denied = await putCred(
      srv.base,
      { slug: "k", name: "K", secret: "s", host: "h.example" },
      { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
    );
    assert.equal(denied.status, 403);
  } finally {
    await srv.close();
  }
});

test("service credentials are org-scoped — a non-org target is rejected", async () => {
  const srv = start();
  try {
    const r = await fetch(`${srv.base}/v1/admin/scopes/personal:U1/service-credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" },
      body: JSON.stringify({ slug: "k", name: "K", secret: "s", host: "h.example" }),
    });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /org-scoped/);
  } finally {
    await srv.close();
  }
});

test("a new credential without a secret is rejected; an update may omit it", async () => {
  const srv = start();
  try {
    assert.equal((await putCred(srv.base, { slug: "k", name: "K", host: "h.example" })).status, 400);
    assert.equal((await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" })).status, 200);
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "K2", host: "h.example", expectedUpdatedAt: version })).status,
      200,
    );
    assert.equal((await getCfg(srv.base)).serviceCredentials.find((c) => c.slug === "k")!.name, "K2");
  } finally {
    await srv.close();
  }
});

test("partial credential updates preserve capability lists while explicit empty lists clear them", async () => {
  const srv = start();
  try {
    await putCred(srv.base, {
      slug: "k",
      name: "K",
      secret: "s",
      host: "h.example",
      injection: { header: "X-Key", scheme: "Token", actor: true },
      allowedMethods: ["POST"],
      allowedPathPrefixes: ["/v1/"],
      enabled: true,
    });
    let loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "Renamed", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(loaded.allowedMethods, ["POST"]);
    assert.deepEqual(loaded.allowedPathPrefixes, ["/v1/"]);
    assert.deepEqual(loaded.injection, { header: "X-Key", scheme: "Token", actor: true });
    assert.equal(loaded.enabled, true);

    assert.equal(
      (
        await putCred(srv.base, {
          slug: "k",
          name: "Renamed",
          host: "h.example",
          injection: {},
          allowedMethods: [],
          allowedPathPrefixes: [],
          enabled: false,
          expectedUpdatedAt: loaded.updatedAt,
        })
      ).status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(loaded.allowedMethods, []);
    assert.deepEqual(loaded.allowedPathPrefixes, []);
    assert.equal(loaded.injection, undefined);
    assert.equal(loaded.enabled, false);

    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "Again", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(loaded.enabled, false, "omitting enabled preserves a disabled credential");
  } finally {
    await srv.close();
  }
});

test("a credential whose injection only adds fixed headers keeps them", async () => {
  const srv = start();
  try {
    const injection = { headers: { "x-api-version": "2025-11-01" } };
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example", injection })).status,
      200,
    );
    assert.deepEqual((await getCfg(srv.base)).serviceCredentials[0]!.injection, injection);
  } finally {
    await srv.close();
  }
});

test("admin credential edits reject a stale loaded revision", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", name: "K2", host: "h.example", expectedUpdatedAt: loaded.updatedAt }))
        .status,
      200,
    );
    const stale = await putCred(srv.base, {
      slug: "k",
      name: "stale",
      host: "h.example",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(stale.status, 409);
    assert.match(await stale.text(), /changed after this editor was loaded/);
  } finally {
    await srv.close();
  }
});

test("an editor whose credential was remotely deleted cannot recreate it with its stale edit token", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const loaded = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(
      (await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: loaded.updatedAt })).status,
      200,
    );

    const staleEdit = await putCred(srv.base, {
      slug: "k",
      name: "Resurrected",
      host: "h.example",
      expectedUpdatedAt: loaded.updatedAt,
    });
    assert.equal(staleEdit.status, 409);
    assert.match(await staleEdit.text(), /changed after this editor was loaded/);
    assert.equal(
      (await getCfg(srv.base)).serviceCredentials.some((credential) => credential.slug === "k"),
      false,
    );
  } finally {
    await srv.close();
  }
});

test("existing credential edits and deletes require the loaded revision", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const edit = await putCred(srv.base, { slug: "k", name: "Changed", host: "h.example" });
    assert.equal(edit.status, 400);
    assert.match(await edit.text(), /require the version you loaded/);
    const deletion = await putCred(srv.base, { slug: "k", delete: true });
    assert.equal(deletion.status, 400);
    assert.match(await deletion.text(), /require the version you loaded/);
    assert.equal((await getCfg(srv.base)).serviceCredentials[0]!.name, "K");
  } finally {
    await srv.close();
  }
});

test("a partial ACL failure rolls a credential edit and its grants back to the verified snapshot", async () => {
  let failGrant = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (failGrant) {
        failGrant = false;
        throw new Error("injected grant failure");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    await srv.built.acl.revoke("org:default-org", "service-cred:k", "org:default-org", "seed");
    await srv.built.acl.grant({
      ownerScopeId: "org:default-org",
      ref: "service-cred:k",
      granteeScopeId: "org:default-org",
      permission: "write",
      grantedBy: "original-governor",
    });
    const grantsBefore = await srv.built.acl.grantsFor("org:default-org", "service-cred:k");
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    failGrant = true;
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /previous credential and grants were restored/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "K");
    assert.deepEqual(after.grantees, ["org:default-org"]);
    assert.deepEqual(await srv.built.acl.grantsFor("org:default-org", "service-cred:k"), grantsBefore);
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("credential rollback preserves a concurrent credential update", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent credential write");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    concurrentWrite = async () => {
      const current = (await srv.built.serviceCreds.listServiceCredentials("org:default-org")).find(
        (credential) => credential.slug === "k",
      )!;
      const updatedAt = await srv.built.serviceCreds.setServiceCredentialIfCurrent(
        "org:default-org",
        {
          slug: "k",
          name: "Concurrent",
          host: "concurrent.example",
          updatedBy: "concurrent-governor",
        },
        current.updatedAt,
      );
      assert.notEqual(updatedAt, null);
    };
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /rollback could not be verified/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "Concurrent");
    assert.equal(after.host, "concurrent.example");
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("failed credential creation does not delete a concurrent update of the new record", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent create update");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    concurrentWrite = async () => {
      const created = (await srv.built.serviceCreds.listServiceCredentials("org:default-org")).find(
        (credential) => credential.slug === "new",
      )!;
      assert.notEqual(
        await srv.built.serviceCreds.setServiceCredentialIfCurrent(
          "org:default-org",
          {
            slug: "new",
            name: "Concurrent",
            host: "concurrent.example",
            updatedBy: "concurrent-governor",
          },
          created.updatedAt,
        ),
        null,
      );
    };
    const response = await putCred(srv.base, { slug: "new", name: "New", secret: "s", host: "new.example" });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /rollback could not be verified/);
    const saved = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "new")!;
    assert.equal(saved.name, "Concurrent");
    assert.equal(saved.host, "concurrent.example");
  } finally {
    await srv.close();
  }
});

test("failed credential deletion does not overwrite a concurrent recreation", async () => {
  let concurrentWrite: (() => Promise<void>) | null = null;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (concurrentWrite) {
        const write = concurrentWrite;
        concurrentWrite = null;
        await write();
        throw new Error("failure after concurrent recreation");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "Original", secret: "old", host: "old.example" });
    const original = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "k")!;
    concurrentWrite = async () => {
      assert.notEqual(
        await srv.built.serviceCreds.setServiceCredentialIfAbsent("org:default-org", {
          slug: "k",
          name: "Concurrent",
          secret: "new",
          host: "concurrent.example",
          updatedBy: "concurrent-governor",
        }),
        null,
      );
    };
    const response = await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: original.updatedAt });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /rollback could not be verified/);
    const saved = (await getCfg(srv.base)).serviceCredentials.find((credential) => credential.slug === "k")!;
    assert.equal(saved.name, "Concurrent");
    assert.equal(saved.host, "concurrent.example");
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "new");
  } finally {
    await srv.close();
  }
});

test("credential rollback preserves a concurrent grant tuple instead of replacing it with the snapshot", async () => {
  let injectConcurrentGrant = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (injectConcurrentGrant) {
        injectConcurrentGrant = false;
        await acl.grant({
          ownerScopeId,
          ref,
          granteeScopeId: "team:concurrent",
          permission: "write",
          grantedBy: "concurrent-governor",
        });
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    injectConcurrentGrant = true;
    const edit = await putCred(srv.base, {
      slug: "k",
      name: "Changed",
      host: "h.example",
      grantees: ["personal:alice"],
      expectedUpdatedAt: before.updatedAt,
    });
    assert.equal(edit.status, 500);
    assert.match(await edit.text(), /rollback could not be verified/);
    assert.deepEqual(
      (await srv.built.acl.grantsFor("org:default-org", "service-cred:k")).find(
        (grant) => grant.granteeScopeId === "team:concurrent",
      ),
      {
        ownerScopeId: "org:default-org",
        ref: "service-cred:k",
        granteeScopeId: "team:concurrent",
        permission: "write",
        grantedBy: "concurrent-governor",
      },
    );
  } finally {
    await srv.close();
  }
});

test("an ACL failure after conditional delete recreates and verifies the credential plus grants", async () => {
  let failRevoke = false;
  const srv = start((acl) => ({
    ...acl,
    async replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy) {
      if (failRevoke) {
        failRevoke = false;
        throw new Error("injected revoke failure");
      }
      return acl.replaceGrantsIfCurrent(ownerScopeId, ref, expected, replacement, changedBy, authoredBy);
    },
  }));
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const before = (await getCfg(srv.base)).serviceCredentials[0]!;
    failRevoke = true;
    const deletion = await putCred(srv.base, { slug: "k", delete: true, expectedUpdatedAt: before.updatedAt });
    assert.equal(deletion.status, 500);
    assert.match(await deletion.text(), /previous credential and grants were restored/);
    const after = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.equal(after.name, "K");
    assert.deepEqual(after.grantees, ["org:default-org"]);
    assert.equal((await srv.built.serviceCreds.getServiceCredentialSecret("org:default-org", "k"))?.secret, "s");
  } finally {
    await srv.close();
  }
});

test("parallel credential edits from one loaded revision allow one winner and one conflict", async () => {
  const srv = start();
  try {
    await putCred(srv.base, { slug: "k", name: "K", secret: "s", host: "h.example" });
    const version = (await getCfg(srv.base)).serviceCredentials[0]!.updatedAt;
    const responses = await Promise.all([
      putCred(srv.base, {
        slug: "k",
        name: "Left",
        host: "h.example",
        grantees: ["personal:left"],
        expectedUpdatedAt: version,
      }),
      putCred(srv.base, {
        slug: "k",
        name: "Right",
        host: "h.example",
        grantees: ["personal:right"],
        expectedUpdatedAt: version,
      }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const saved = (await getCfg(srv.base)).serviceCredentials[0]!;
    assert.deepEqual(saved.grantees, [saved.name === "Left" ? "personal:left" : "personal:right"]);
  } finally {
    await srv.close();
  }
});
