import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../../../src/types.ts";
import { start, publish, type SkillView, startSecure } from "../../support/surface-skills.ts";

test("POST /v1/skills with a signing secret set rejects an unauthenticated (unsigned, no-token) request", async () => {
  const srv = await startSecure();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", name: "x", description: "d", body: "# b" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id via a capability token edits the token-actor's own skill (body principalId ignored)", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: { name: "make-digest", description: "v1", requiredCapabilities: [], body: "# v1" },
      createdBy: "U1",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({ principalId: "U2", description: "v2", body: "# v2" }),
    });
    assert.equal(res.status, 200);
    const after = await srv.skills.get(sk.id);
    assert.equal(after!.manifest.body, "# v2");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id via a capability token cannot edit another scope's skill (404)", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "secret", description: "theirs", requiredCapabilities: [], body: "# secret" },
      createdBy: "U2",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await srv.skills.get(sk.id))!.manifest.description, "theirs");
  } finally {
    await srv.close();
  }
});

async function seedChannelSkill(srv: Awaited<ReturnType<typeof startSecure>>) {
  await srv.directory.replaceChannels(
    [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
    [
      { channelId: "C9", principalId: "avery" },
      { channelId: "C9", principalId: "jordan" },
    ],
  );
  const res = await fetch(`${srv.base}/v1/skills`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-capability": await srv.cap("avery", scopeId("channel", "C9")),
    },
    body: JSON.stringify({ name: "team-thing", description: "v1", body: "# v1" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { skill: { id: string } }).skill.id;
}

test("PUT /v1/skills/:id lets a DIFFERENT member of the home channel edit it, preserving provenance and staying live", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("jordan", scopeId("channel", "C9")),
      },
      body: JSON.stringify({ body: "# v2 by jordan" }),
    });
    assert.equal(res.status, 200);
    const after = await srv.skills.get(id);
    assert.equal(after!.manifest.body, "# v2 by jordan");
    assert.equal(after!.createdBy, "avery", "edit by a member never rewrites provenance");
    assert.equal(after!.status, "published", "a membership-managed edit re-publishes — no org review needed");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id from a member's own DM (not the channel) still edits — management follows membership, not the turn's scope", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("jordan") },
      body: JSON.stringify({ description: "from jordan's DM" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.description, "from jordan's DM");
  } finally {
    await srv.close();
  }
});

test("PUT/DELETE /v1/skills/:id refuse a NON-member of the home channel (404/403)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("mallory") },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(edit.status, 404);
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("mallory") },
    });
    assert.equal(del.status, 403);
    assert.ok(await srv.skills.get(id), "the channel's skill is untouched by a non-member");
    assert.equal((await srv.skills.get(id))!.manifest.description, "v1");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id lets any member of the home channel archive it", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("jordan") },
    });
    assert.equal(res.status, 200);
    assert.equal((await srv.skills.get(id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("an author who LEAVES a private channel loses inline CRUD on its skill (membership, not authorship, decides)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "jordan" }],
    );
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("avery") },
      body: JSON.stringify({ description: "ex-member edit" }),
    });
    assert.equal(edit.status, 404, "an ex-member author cannot edit a private-channel skill");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("avery") },
    });
    assert.equal(del.status, 403, "an ex-member author cannot delete it either");
    const k = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("jordan") },
      body: JSON.stringify({ description: "still managed by the remaining member" }),
    });
    assert.equal(k.status, 200);
  } finally {
    await srv.close();
  }
});

test("management tracks CURRENT directory membership, not a stale session — a session-only non-member cannot edit", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const sess = await srv.sessions.getOrCreateByThread("C9:t1", "channel", scopeId("channel", "C9"), "avery-jordan");
    await srv.sessions.addParticipant(sess.id, "dana");
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("dana") },
      body: JSON.stringify({ description: "stale-session edit" }),
    });
    assert.equal(edit.status, 404, "a session-only non-member cannot manage — management reads current membership");
    assert.equal((await srv.skills.get(id))!.manifest.description, "v1", "untouched");
  } finally {
    await srv.close();
  }
});

test("a shared-scope skill cannot be created/edited/deleted by an automated trigger (no liveActor)", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "avery" }],
    );
    const triggerTok = await srv.cap("avery", scopeId("channel", "C9"), false);
    const create = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": triggerTok },
      body: JSON.stringify({ name: "auto-thing", description: "d", body: "# b" }),
    });
    assert.equal(create.status, 403, "an automated trigger cannot create a shared skill");
    assert.equal(
      (await srv.skills.list()).find((s) => s.manifest.name === "auto-thing"),
      undefined,
    );

    const id = await seedChannelSkill(srv);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": triggerTok },
      body: JSON.stringify({ description: "auto edit" }),
    });
    assert.equal(edit.status, 403);
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": triggerTok },
    });
    assert.equal(del.status, 403);
    assert.ok(await srv.skills.get(id), "the shared skill survives an automated trigger");

    const personalTrigger = await srv.cap("solo", scopeId("personal", "solo"), false);
    const own = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ name: "solo-skill", description: "d", body: "# b" }),
    });
    assert.equal(own.status, 201, "a trigger in its owner's own DM may still save a personal skill");
  } finally {
    await srv.close();
  }
});

test("a PERSONAL-scope trigger (no liveActor) cannot edit or delete a skill homed in a private channel it is a member of", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const personalTrigger = await srv.cap("avery", scopeId("personal", "avery"), false);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ body: "# rewritten by a personal-scope trigger" }),
    });
    assert.equal(edit.status, 403, "a personal-scope trigger cannot rewrite a shared skill");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": personalTrigger },
    });
    assert.equal(del.status, 403, "a personal-scope trigger cannot delete a shared skill");
    const survivor = await srv.skills.get(id);
    assert.ok(survivor, "the shared skill survives the personal-scope trigger");
    assert.equal(survivor!.manifest.body, "# v1", "and its body is untouched");
  } finally {
    await srv.close();
  }
});

test("a LIVE member of a private channel may edit + delete its skill from their own DM (personal token, liveActor)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const liveJordan = await srv.cap("jordan");
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": liveJordan },
      body: JSON.stringify({ description: "edited live by a member" }),
    });
    assert.equal(edit.status, 200, "a live member may edit the shared skill");
    assert.equal((await srv.skills.get(id))!.manifest.description, "edited live by a member");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": liveJordan },
    });
    assert.equal(del.status, 200, "and delete it");
    assert.equal((await srv.skills.get(id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("a PERSONAL-scope trigger (no liveActor) may still edit + delete its OWNER'S OWN personal skill", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "solo"),
      manifest: { name: "solo-skill", description: "v1", requiredCapabilities: [], body: "# v1" },
      createdBy: "solo",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);
    const personalTrigger = await srv.cap("solo", scopeId("personal", "solo"), false);
    const edit = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ body: "# v2 by the owner's trigger" }),
    });
    assert.equal(edit.status, 200, "an owner's trigger may edit its own personal skill");
    assert.equal((await srv.skills.get(sk.id))!.manifest.body, "# v2 by the owner's trigger");
    const del = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": personalTrigger },
    });
    assert.equal(del.status, 200, "and delete it");
    assert.equal((await srv.skills.get(sk.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("a group-DM skill is editable by any group member (the group-DM analog of a private channel)", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceGroups([
      { groupId: "G7", principalId: "ann" },
      { groupId: "G7", principalId: "bob" },
    ]);
    const created = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("ann", scopeId("group", "G7")),
      },
      body: JSON.stringify({ name: "grouped", description: "v1", body: "# v1" }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { skill: { id: string } }).skill.id;
    assert.equal((await srv.skills.get(id))!.scopeId, scopeId("group", "G7"));

    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("bob") },
      body: JSON.stringify({ body: "# v2 by bob" }),
    });
    assert.equal(edit.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.body, "# v2 by bob");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills refuses to home a skill directly in an org or team scope (promotion path only)", async () => {
  const srv = await startSecure();
  try {
    for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
      const res = await fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("author", home) },
        body: JSON.stringify({ name: `wide-${home}`, description: "d", body: "# b" }),
      });
      assert.equal(res.status, 403, `${home}: must refuse inline create into a promotion-gated scope`);
      assert.equal(
        (await srv.skills.list()).find((s) => s.manifest.name === `wide-${home}`),
        undefined,
        `${home}: nothing created`,
      );
    }
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills shows a group-DM skill to a member known only via directory membership", async () => {
  const srv = start();
  try {
    await srv.directory.replaceGroups([
      { groupId: "G7", principalId: "ann" },
      { groupId: "G7", principalId: "bob" },
    ]);
    await publish(srv.skills, scopeId("group", "G7"), "grouped", "shared in the group DM");
    const forBob = (await (await fetch(`${srv.base}/v1/skills?principalId=bob`)).json()) as { skills: SkillView[] };
    const g = forBob.skills.find((s) => s.name === "grouped");
    assert.ok(g, "the group skill shows up for a directory-only group member");
    assert.equal(g!.editable, true, "and a group member may edit it");
    const forCarol = (await (await fetch(`${srv.base}/v1/skills?principalId=carol`)).json()) as { skills: SkillView[] };
    assert.equal(
      forCarol.skills.find((s) => s.name === "grouped"),
      undefined,
    );
  } finally {
    await srv.close();
  }
});

test("an ORG- or TEAM-homed skill is never inline-managed, even by its author (promotion/admin only)", async () => {
  const srv = await startSecure();
  try {
    for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
      const sk = await srv.skills.create({
        scopeId: home,
        manifest: { name: `wide-${home.replace(":", "-")}`, description: "v1", requiredCapabilities: [], body: "# v1" },
        createdBy: "author",
      });
      await srv.skills.review(sk.id, "reviewer-1", []);
      await srv.skills.publish(sk.id);

      const edit = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("author") },
        body: JSON.stringify({ description: "inline edit" }),
      });
      assert.equal(edit.status, 404, `${home}: author cannot inline-edit a wide-scope skill`);
      const after = await srv.skills.get(sk.id);
      assert.equal(after!.manifest.description, "v1", `${home}: untouched`);
      assert.equal(after!.status, "published", `${home}: still published, not silently demoted`);

      const del = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
        method: "DELETE",
        headers: { "x-agent-capability": await srv.cap("author") },
      });
      assert.equal(del.status, 403, `${home}: author cannot inline-delete a wide-scope skill`);
      assert.ok(await srv.skills.get(sk.id), `${home}: the org/team copy survives`);
    }
  } finally {
    await srv.close();
  }
});

test("a PUBLIC channel (self-joinable) stays owner-only — a non-author member cannot edit it", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "CPUB", name: "general", isPrivate: false }],
      ["owner", "rando"].map((principalId) => ({ channelId: "CPUB", principalId })),
    );
    const created = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("owner", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ name: "pub-skill", description: "v1", body: "# v1" }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { skill: { id: string } }).skill.id;

    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("rando", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(edit.status, 404);
    const own = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("owner", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ description: "owner edit" }),
    });
    assert.equal(own.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.description, "owner edit");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id via a capability token archives the token-actor's own skill; cannot cross scopes", async () => {
  const srv = await startSecure();
  try {
    const mine = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: { name: "mine", description: "d", requiredCapabilities: [], body: "# mine" },
      createdBy: "U1",
    });
    const theirs = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "theirs", description: "d", requiredCapabilities: [], body: "# theirs" },
      createdBy: "U2",
    });

    const cross = await fetch(`${srv.base}/v1/skills/${theirs.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("U1") },
    });
    assert.equal(cross.status, 403);
    assert.ok(await srv.skills.get(theirs.id), "another principal's skill survives");

    const own = await fetch(`${srv.base}/v1/skills/${mine.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("U1") },
    });
    assert.equal(own.status, 200);
    assert.equal((await srv.skills.get(mine.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("a capability token reads and restores its archived skill without losing identity, files, or version", async () => {
  const srv = await startSecure();
  try {
    const created = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: {
        name: "recover-me",
        description: "recoverable",
        requiredCapabilities: [],
        body: "# recover-me",
        files: [{ path: "scripts/run.sh", content: "exit 0", executable: true }],
      },
      createdBy: "U1",
    });
    await srv.skills.review(created.id, "reviewer-1", []);
    await srv.skills.publish(created.id);
    const before = (await srv.skills.get(created.id))!;
    const token = await srv.cap("U1");

    const archived = await fetch(`${srv.base}/v1/skills/${created.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": token },
    });
    assert.equal(archived.status, 200);

    const detail = await fetch(`${srv.base}/v1/skills/${created.id}`, {
      headers: { "x-agent-capability": token },
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      skill: { id: string; body: string; status: string; version: number; files: Array<{ path: string }> };
    };
    assert.equal(detailBody.skill.id, before.id);
    assert.equal(detailBody.skill.body, before.manifest.body);
    assert.equal(detailBody.skill.status, "archived");
    assert.equal(detailBody.skill.version, before.version);
    assert.deepEqual(detailBody.skill.files, [{ path: "scripts/run.sh", executable: true }]);

    const restored = await fetch(`${srv.base}/v1/skills/${created.id}/restore`, {
      method: "POST",
      headers: { "x-agent-capability": token },
    });
    assert.equal(restored.status, 200);
    const after = (await srv.skills.get(created.id))!;
    assert.equal(after.id, before.id);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.manifest.files, before.manifest.files);
    assert.equal(after.status, "published");
  } finally {
    await srv.close();
  }
});

test("skill detail and restore capability calls hide other principals' skills and require identity", async () => {
  const srv = await startSecure();
  try {
    const skill = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "private", description: "theirs", requiredCapabilities: [], body: "# private" },
      createdBy: "U2",
    });
    await srv.skills.review(skill.id, "reviewer-1", []);
    await srv.skills.publish(skill.id);
    await srv.skills.archive(skill.id);

    const headers = { "x-agent-capability": await srv.cap("U1") };
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}`, { headers })).status, 404);
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}/restore`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}?principalId=U2`)).status, 401);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/skills/${skill.id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principalId: "U2" }),
        })
      ).status,
      401,
    );
    assert.equal((await srv.skills.get(skill.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});
