import "../../support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createInsecureTestServer } from "../../../src/api/server.ts";
import { projectGroupRef, projectScopeId } from "../../../src/projects/project-store.ts";
import { buildApp } from "../../support/build-app.ts";
import { testConfig } from "../../support/test-config.ts";
import { runNowSettled } from "../../support/settle.ts";
import { listen } from "../../support/project-routes.ts";
test("linking a just-created channel refreshes the surface directory and retries", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  await built.app.upsertChannels(
    [{ channelId: "C-OLD", name: "old", isPrivate: false }],
    [{ channelId: "C-OLD", principalId: "owner" }],
  );
  const project = await built.app.createProject("owner", "Fresh");
  assert.ok(project);
  // Fulfil the on-demand sync the way the Slack surface would: push the new channel.
  const unlisten = built.app.onContextRequestCreated((r) => {
    if (!r.query.syncDirectory) return;
    void built.app
      .upsertChannels(
        [
          { channelId: "C-OLD", name: "old", isPrivate: false },
          { channelId: "C-NEW", name: "brand-new", isPrivate: false },
        ],
        [
          { channelId: "C-OLD", principalId: "owner" },
          { channelId: "C-NEW", principalId: "owner" },
        ],
      )
      .then(() => built.app.fulfillContextRequest(r.id, { result: { messages: [] } }));
  });
  try {
    const linked = await built.app.setProjectSlackChannel(project!.id, "owner", "#brand-new");
    assert.equal(linked.status, "ok");
    assert.equal(linked.status === "ok" && linked.project.slackChannel?.channelId, "C-NEW");
  } finally {
    unlisten();
  }
});

test("Project slack-channel routes gate on visibility and workspace use, and sync the channel roster", async (t) => {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, {});
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
    { principalId: "chan-pal", displayName: "Channel Pal", type: "internal" },
  ]);
  const channels = [
    { channelId: "C-ENG", name: "eng", isPrivate: false },
    { channelId: "C-SECRET", name: "war-room", isPrivate: true },
    { channelId: "C-BUSY", name: "busy", isPrivate: false },
  ];
  await built.app.upsertChannels(channels, [
    { channelId: "C-SECRET", principalId: "member" },
    { channelId: "C-ENG", principalId: "owner" },
    { channelId: "C-ENG", principalId: "chan-pal" },
  ]);

  const put = (id: string, principalId: string, channel: string) =>
    fetch(`${base}/v1/projects/${id}/slack-channel`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId, channel }),
    });

  const create = await fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "owner", name: "Linked" }),
  });
  assert.equal(create.status, 201);
  const project = ((await create.json()) as { project: { id: string } }).project;
  const groupRef = projectGroupRef(project.id);
  const scope = projectScopeId(project.id);
  await fetch(`${base}/v1/projects/${project.id}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "owner", memberId: "member" }),
  });

  // a session predating the link, so channel-derived members should inherit it
  await built.app.turn({
    origin: { kind: "direct" },
    surface: "web",
    actor: { externalId: "owner" },
    conversation: { kind: "group", channelRef: groupRef, threadRef: "web:owner:pre", audience: [] },
    text: "before the link",
  });

  // a non-member of the project can't link even a channel they can see
  assert.equal((await put(project.id, "outsider", "eng")).status, 403);
  // a private channel the actor can't see reads as invalid
  assert.equal((await put(project.id, "owner", "war-room")).status, 400);
  assert.equal((await put(project.id, "owner", "no-such-channel")).status, 400);
  assert.equal((await put("missing", "owner", "eng")).status, 404);

  // a channel that already has its own workspace can't become a home channel
  await built.sessions.getOrCreateByThread("ch:C-BUSY:1", "channel", "channel:C-BUSY", "busy", "slack");
  const busy = await put(project.id, "owner", "busy");
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { error: string }).error, "channel_in_use");

  // linking by #name resolves through the directory and pulls in the channel roster
  const linked = await put(project.id, "owner", "#eng");
  assert.equal(linked.status, 200);
  const linkedProject = (
    (await linked.json()) as {
      project: {
        memberIds: string[];
        slackChannel?: { channelId: string; channelName: string; linkedBy: string };
        members: Array<{ principalId: string; viaChannel?: boolean }>;
      };
    }
  ).project;
  assert.equal(linkedProject.slackChannel?.channelId, "C-ENG");
  assert.equal(linkedProject.slackChannel?.linkedBy, "owner");
  assert.ok(linkedProject.memberIds.includes("chan-pal"), "channel roster joins the project");
  assert.equal(linkedProject.members.find((m) => m.principalId === "chan-pal")?.viaChannel, true);
  assert.equal(linkedProject.members.find((m) => m.principalId === "member")?.viaChannel, undefined);
  assert.equal(await built.projects.membership(groupRef, "chan-pal"), true);
  // ...including the conversations that predate the link
  assert.ok((await built.app.listSessions("chan-pal")).some((s) => s.scopeId === scope));

  // the roster keeps following the channel through directory syncs
  await built.app.upsertChannels(channels, [
    { channelId: "C-SECRET", principalId: "member" },
    { channelId: "C-ENG", principalId: "owner" },
  ]);
  assert.equal(await built.projects.membership(groupRef, "chan-pal"), false, "leaving the channel leaves the project");
  await built.app.upsertChannels(channels, [
    { channelId: "C-SECRET", principalId: "member" },
    { channelId: "C-ENG", principalId: "owner" },
    { channelId: "C-ENG", principalId: "chan-pal" },
  ]);
  assert.equal(
    await built.projects.membership(groupRef, "chan-pal"),
    true,
    "rejoining the channel rejoins the project",
  );

  // manual members never ride the channel roster
  assert.equal(await built.projects.membership(groupRef, "member"), true);

  // unlink: project members only; derived members leave with the link
  const outsiderUnlink = await fetch(`${base}/v1/projects/${project.id}/slack-channel`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "outsider" }),
  });
  assert.equal(outsiderUnlink.status, 403);
  const unlink = await fetch(`${base}/v1/projects/${project.id}/slack-channel`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "member" }),
  });
  assert.equal(unlink.status, 200);
  assert.equal(await built.projects.slackChannel(groupRef), undefined);
  assert.equal(await built.projects.membership(groupRef, "chan-pal"), false);
  assert.equal(await built.projects.membership(groupRef, "member"), true);
  assert.ok(!(await built.app.listSessions("chan-pal")).some((s) => s.scopeId === scope));
});

test("a project can add a signed-in principal on a deployment whose directory is never populated", async () => {
  const built = buildApp(testConfig({ emailAuthPrincipals: ["dana@acme.com"] }));
  const session = await built.sessions.getOrCreateByThread("web:rex", "dm", "personal:rex@acme.com");
  await built.sessions.addParticipant(session.id, "rex@acme.com");

  const project = (await built.app.createProject("dana@acme.com", "demo"))!;
  const added = await built.app.addProjectMember(project.id, "dana@acme.com", "rex@acme.com");

  assert.equal(added.status, "ok");
  assert.ok(added.project!.memberIds.includes("rex@acme.com"));
});

test("Slack-linked project turns use the inherited channel roster", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "chan-pal", displayName: "Channel Pal", type: "internal" },
    { principalId: "chan-gone", displayName: "Channel Gone", type: "internal" },
  ]);
  const channels = [{ channelId: "C-ENG", name: "eng", isPrivate: false }];
  await built.app.upsertChannels(channels, [
    { channelId: "C-ENG", principalId: "owner" },
    { channelId: "C-ENG", principalId: "chan-pal" },
  ]);
  const project = await built.app.createProject("owner", "Linked Roster");
  assert.ok(project);
  const groupRef = projectGroupRef(project.id);
  const linked = await built.app.setProjectSlackChannel(project.id, "owner", "#eng");
  assert.equal(linked.status, "ok");
  assert.equal(await built.projects.membership(groupRef, "chan-pal"), true);

  const turn = (actor: string, threadRef: string, text = "hello linked project") =>
    built.app.turn({
      origin: { kind: "direct" },
      surface: "web",
      actor: { externalId: actor },
      conversation: {
        kind: "group",
        channelRef: groupRef,
        threadRef,
        audience: [{ externalId: "outsider" }],
      },
      text,
    });
  const rosterOf = async (threadRef: string) => {
    const run = (await built.runs.list()).findLast(
      (candidate) => candidate.request.conversation.threadRef === threadRef,
    );
    assert.ok(run);
    const session = await built.sessions.getByThread(threadRef);
    assert.ok(session);
    return {
      participants: new Set(run.request.sessionParticipantIds),
      audience: new Set(run.request.conversation.audience.map((member) => member.id)),
      session: new Set(await built.sessions.participantsOf(session.id)),
    };
  };
  const assertRoster = async (threadRef: string, expected: string[]) => {
    const roster = await rosterOf(threadRef);
    const wanted = new Set(expected);
    assert.deepEqual(roster.participants, wanted);
    assert.deepEqual(roster.audience, wanted);
    assert.deepEqual(roster.session, wanted);
  };

  assert.equal((await turn("owner", "web:owner:linked")).status, "ok");
  await assertRoster("web:owner:linked", ["owner", "chan-pal"]);
  assert.equal((await turn("chan-pal", "web:chan-pal:linked")).status, "ok");
  await assertRoster("web:chan-pal:linked", ["owner", "chan-pal"]);

  const ownerCron = await built.app.createCron({
    ownerScopeId: project.scopeId,
    owner: "owner",
    createdBy: "owner",
    action: "linked roster work",
    schedule: { everyMs: 60_000 },
  });
  const inheritedCron = await built.app.createCron({
    ownerScopeId: project.scopeId,
    owner: "chan-pal",
    createdBy: "chan-pal",
    action: "inherited member work",
    schedule: { everyMs: 60_000 },
  });
  const cronRoster = async (cronId: string) => {
    const fire = (await built.crons.listFires(cronId)).runs.at(-1);
    assert.ok(fire);
    const run = (await built.runs.list()).find(
      (candidate) => candidate.request.conversation.threadRef === fire.threadRef,
    );
    assert.ok(run);
    return { fire, participants: new Set(run.request.sessionParticipantIds) };
  };
  await runNowSettled(built.scheduler, built.crons, ownerCron.id);
  const linkedCron = await cronRoster(ownerCron.id);
  assert.equal(linkedCron.fire.status, "ok");
  assert.deepEqual(linkedCron.participants, new Set(["owner", "chan-pal"]));

  await built.app.upsertChannels(channels, [{ channelId: "C-ENG", principalId: "owner" }]);
  assert.equal(await built.projects.membership(groupRef, "chan-pal"), false);
  assert.equal((await turn("chan-pal", "web:chan-pal:revoked")).status, "refused");
  assert.equal((await turn("owner", "web:owner:after-revoke")).status, "ok");
  await assertRoster("web:owner:after-revoke", ["owner"]);

  await runNowSettled(built.scheduler, built.crons, ownerCron.id);
  const revokedOwnerCron = await cronRoster(ownerCron.id);
  assert.equal(revokedOwnerCron.fire.status, "ok");
  assert.deepEqual(revokedOwnerCron.participants, new Set(["owner"]));
  await runNowSettled(built.scheduler, built.crons, inheritedCron.id);
  assert.equal(await built.crons.get(inheritedCron.id), null, "leaving the project deletes the member's cron");

  await built.app.upsertChannels(channels, [
    { channelId: "C-ENG", principalId: "owner" },
    { channelId: "C-ENG", principalId: "chan-gone" },
  ]);
  assert.equal(await built.projects.membership(groupRef, "chan-gone"), true);
  const inactiveCron = await built.app.createCron({
    ownerScopeId: project.scopeId,
    owner: "chan-gone",
    createdBy: "chan-gone",
    action: "inactive member work",
    schedule: { everyMs: 60_000 },
  });
  await built.identity.deactivate("chan-gone");
  assert.equal(await built.projects.membership(groupRef, "chan-gone"), false);
  assert.equal((await turn("chan-gone", "web:chan-gone:inactive")).status, "refused");
  assert.equal((await turn("owner", "web:owner:after-inactive")).status, "ok");
  await assertRoster("web:owner:after-inactive", ["owner"]);

  await runNowSettled(built.scheduler, built.crons, ownerCron.id);
  const inactiveOwnerCron = await cronRoster(ownerCron.id);
  assert.equal(inactiveOwnerCron.fire.status, "ok");
  assert.deepEqual(inactiveOwnerCron.participants, new Set(["owner"]));
  await runNowSettled(built.scheduler, built.crons, inactiveCron.id);
  assert.equal((await built.crons.get(inactiveCron.id))?.enabled, false);
});
