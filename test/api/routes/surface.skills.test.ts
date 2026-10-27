import "../../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeId } from "../../../src/types.ts";
import { start, publish, type SkillView, startSecure } from "../../support/surface-skills.ts";

test("GET /v1/skills returns metadata only; authorized detail fetch returns the body", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "deploy-bot", "ship the bot to prod");
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");

    const res = await fetch(`${srv.base}/v1/skills?principalId=${encodeURIComponent("U1")}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { skills: SkillView[] };
    const byName = new Map(body.skills.map((s) => [s.name, s]));

    const mine = byName.get("make-digest")!;
    assert.equal(mine.scope, "personal");
    assert.equal(mine.body, undefined, "list rows do not eagerly expose instruction bodies");
    const detail = (await (await fetch(`${srv.base}/v1/skills/${mine.id}?principalId=U1`)).json()) as {
      skill: SkillView;
    };
    assert.equal(detail.skill.body, "# make-digest");
    assert.equal(mine.editable, true);
    assert.ok(mine.id);
    assert.equal(byName.get("deploy-bot")?.scope, "org");
    assert.equal(byName.get("deploy-bot")?.editable, false);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills marks a private-channel skill editable for a member and not for a non-member", async () => {
  const srv = start();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [
        { channelId: "C9", principalId: "avery" },
        { channelId: "C9", principalId: "jordan" },
      ],
    );
    await publish(srv.skills, scopeId("channel", "C9"), "team-thing", "shared in the channel");

    const forJordan = (await (await fetch(`${srv.base}/v1/skills?principalId=jordan`)).json()) as {
      skills: SkillView[];
    };
    const k = forJordan.skills.find((s) => s.name === "team-thing");
    assert.ok(k, "the channel skill is visible to a member");
    assert.equal(k!.scope, "channel");
    assert.equal(k!.editable, true, "a member may edit it");

    const forMallory = (await (await fetch(`${srv.base}/v1/skills?principalId=mallory`)).json()) as {
      skills: SkillView[];
    };
    assert.equal(
      forMallory.skills.find((s) => s.name === "team-thing"),
      undefined,
      "a non-member doesn't even see it",
    );
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id edits an owned personal skill in place and keeps it live", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
    const before = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = before.skills.find((s) => s.name === "make-digest")!.id;

    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", description: "a better digest", body: "# make-digest v2" }),
    });
    assert.equal(res.status, 200);

    const after = (await (await fetch(`${srv.base}/v1/skills/${id}?principalId=U1`)).json()) as { skill: SkillView };
    const mine = after.skill;
    assert.equal(mine.description, "a better digest");
    assert.equal(mine.body, "# make-digest v2");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id refuses to edit a skill the caller doesn't own", async () => {
  const srv = start();
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", description: "hijacked" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id archives an owned personal skill", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
    const before = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = before.skills.find((s) => s.name === "make-digest")!.id;

    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 200);

    assert.equal((await srv.skills.get(id))?.status, "archived", "record remains as a reversible tombstone");
    const after = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    assert.equal(
      after.skills.find((s) => s.name === "make-digest")?.status,
      "archived",
      "manager can discover and restore it",
    );
  } finally {
    await srv.close();
  }
});

test("an archived skill can be restored by its manager", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "recover-me", "recoverable");
    const listed = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = listed.skills.find((skill) => skill.name === "recover-me")!.id;
    await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    const restored = await fetch(`${srv.base}/v1/skills/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await srv.skills.get(id))?.status, "published");
  } finally {
    await srv.close();
  }
});

test("an archived skill name can be reused for a replacement", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "replace-me", "old version");
    const listed = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const oldId = listed.skills.find((skill) => skill.name === "replace-me")!.id;
    await fetch(`${srv.base}/v1/skills/${oldId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });

    const replacement = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        name: "replace-me",
        description: "new version",
        body: "# replacement",
      }),
    });
    assert.equal(replacement.status, 201);
    const created = (await replacement.json()) as { skill: SkillView };
    assert.notEqual(created.skill.id, oldId);
    assert.equal(await srv.skills.get(oldId), null, "the reused name retires its archived tombstone");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id refuses a skill the caller doesn't own with 403", async () => {
  const srv = start();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "secret", description: "theirs", requiredCapabilities: [], body: "# secret" },
      createdBy: "U2",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 403);
    assert.ok(await srv.skills.get(sk.id), "the other owner's skill is untouched");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id is a 404 for a skill that doesn't exist", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills/no-such-id`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills without principalId is a 400", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills`);
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills surfaces the shadowed flag when a personal skill overrides an org one", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "notes", "org notes");
    await publish(srv.skills, scopeId("personal", "U1"), "notes", "U1 notes");

    const res = await fetch(`${srv.base}/v1/skills?principalId=U1`);
    const body = (await res.json()) as { skills: Array<{ name: string; scope: string; shadowed: boolean }> };
    const notes = body.skills.filter((s) => s.name === "notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.scope, "personal");
    assert.equal(notes[0]!.shadowed, true);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills can include every active scope variant without changing the default projection", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "notes", "org notes");
    await publish(srv.skills, scopeId("personal", "U1"), "notes", "personal notes");

    const normal = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    assert.equal(normal.skills.filter((skill) => skill.name === "notes").length, 1);

    const expanded = (await (await fetch(`${srv.base}/v1/skills?principalId=U1&includeShadowed=1`)).json()) as {
      skills: SkillView[];
    };
    const notes = expanded.skills.filter((skill) => skill.name === "notes");
    assert.deepEqual(
      notes.map((skill) => skill.scope),
      ["personal", "org"],
    );
    assert.equal(notes[0]!.shadowed, true);
    assert.equal(notes[1]!.shadowed, false);
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills creates a personal skill that is then visible and editable", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        name: "watch-ci",
        description: "watch the CI pipeline",
        body: "# watch-ci\nPoll the pipeline and report.",
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { skill: SkillView };
    assert.equal(created.skill.name, "watch-ci");
    assert.equal(created.skill.status, "published");
    assert.ok(created.skill.id);

    const list = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const mine = list.skills.find((s) => s.name === "watch-ci")!;
    assert.equal(mine.scope, "personal");
    assert.equal(mine.editable, true);
    assert.equal(mine.body, undefined);
    const detail = (await (await fetch(`${srv.base}/v1/skills/${mine.id}?principalId=U1`)).json()) as {
      skill: SkillView;
    };
    assert.equal(detail.skill.body, "# watch-ci\nPoll the pipeline and report.");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills rejects a duplicate name in the caller's personal scope with 409", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "watch-ci", "first one");
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", name: "watch-ci", description: "dup", body: "# dup" }),
    });
    assert.equal(res.status, 409);
    const err = (await res.json()) as { error: string };
    assert.equal(err.error, "exists");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills is a 400 when a required field is missing or blank", async () => {
  const srv = start();
  try {
    for (const bad of [
      { principalId: "U1", name: "x", description: "d" },
      { principalId: "U1", name: "  ", description: "d", body: "b" },
      { name: "x", description: "d", body: "b" },
    ]) {
      const res = await fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  } finally {
    await srv.close();
  }
});

test("a personal skill of the same name does NOT collide across principals", async () => {
  const srv = start();
  try {
    const mk = (pid: string) =>
      fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: pid, name: "shared-name", description: `${pid} skill`, body: `# ${pid}` }),
      });
    assert.equal((await mk("U1")).status, 201);
    assert.equal((await mk("U2")).status, 201);
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills via a capability token authors as the token's own principal (body principalId ignored)", async () => {
  const srv = await startSecure();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({
        principalId: "U2",
        name: "watch-ci",
        description: "watch the pipeline",
        body: "# watch-ci",
      }),
    });
    assert.equal(res.status, 201);

    const all = await srv.skills.list();
    const watch = all.find((sk) => sk.manifest.name === "watch-ci");
    assert.ok(watch, "the skill was created");
    assert.equal(
      watch!.scopeId,
      scopeId("personal", "U1"),
      "authored as the token's actor, not the spoofed body principalId",
    );
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills via a capability token from a private-channel scope homes the skill there, authored by the actor", async () => {
  const srv = await startSecure();
  try {
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
      body: JSON.stringify({ name: "team-thing", description: "d", body: "# b" }),
    });
    assert.equal(res.status, 201);
    const all = await srv.skills.list();
    const sk = all.find((s) => s.manifest.name === "team-thing");
    assert.ok(sk, "the skill was created");
    assert.equal(sk!.scopeId, scopeId("channel", "C9"), "homed in the channel, not avery's personal scope");
    assert.equal(sk!.createdBy, "avery", "provenance is the real author, never the scope");
    assert.equal(sk!.status, "published", "a membership-managed shared skill auto review+publishes");
  } finally {
    await srv.close();
  }
});
