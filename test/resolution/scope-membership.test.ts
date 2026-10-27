import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rosterAdmits,
  withLiveTurnMembership,
  createCanManageScope,
  createManagesArtifactHome,
} from "../../src/resolution/scope-membership.ts";
import type { ScopeId } from "../../src/types.ts";

const room = "group:C0NEW" as ScopeId;
const otherRoom = "group:C0OTHER" as ScopeId;
const stored = async (principalId: string, scope: ScopeId) =>
  scope === otherRoom && principalId === "regan@example.com";

test("a verified live turn proves the speaker's membership in its own scope while the store lags", async () => {
  const check = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await check("josh@example.com", room), true);
  assert.equal(await check("JOSH@example.com", room), true);
  assert.equal(await check("regan@example.com", room), false);
});

test("the live turn says nothing about other scopes or unverified turns", async () => {
  const verified = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await verified("josh@example.com", otherRoom), false);
  assert.equal(await verified("regan@example.com", otherRoom), true);
  const unverified = withLiveTurnMembership(stored, { actorId: "josh@example.com", scopeId: room, verified: false });
  assert.equal(await unverified("josh@example.com", room), false);
  const noStore = withLiveTurnMembership(undefined, { actorId: "josh@example.com", scopeId: room, verified: true });
  assert.equal(await noStore("josh@example.com", otherRoom), false);
});

test("a roster admits its members and its own conversation, never another conversation's actor", () => {
  const project = "group:web-project-p1" as ScopeId;
  assert.equal(rosterAdmits(["alice"], "alice", project), true);
  assert.equal(rosterAdmits(["alice"], "bob", project), false);
  assert.equal(rosterAdmits(["alice"], "system:group:web-project-p1", project), true);
  assert.equal(rosterAdmits(["alice"], "system:group:web-project-p2", project), false);
});

const alpha = new Set(["bo@x.com", "ann@x.com"]);
const deps = {
  teams: { isMember: async (principalId: string, teamId: string) => teamId === "alpha" && alpha.has(principalId) },
  identity: {
    classify: (principalId: string) => ({
      type: principalId.startsWith("ext") ? ("external" as const) : ("internal" as const),
    }),
  },
};

test("a team-owned artifact is managed by the team's current members, not only its creator", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  assert.equal(await manages("team:alpha", "ann@x.com", "ann@x.com"), true);
  assert.equal(await manages("team:alpha", "ann@x.com", "bo@x.com"), true);
});

test("a team-owned artifact is not manageable by non-members, including a creator who is no longer on the team", async () => {
  const manages = createManagesArtifactHome(deps as never, createCanManageScope(deps as never));
  assert.equal(await manages("team:alpha", "ann@x.com", "outsider@x.com"), false);
  assert.equal(await manages("team:alpha", "former@x.com", "former@x.com"), false);
  assert.equal(await manages("team:other", "bo@x.com", "bo@x.com"), false);
  assert.equal(await manages("team:alpha", "ann@x.com", "ext@x.com"), false);
});

test("without a team store, team-owned artifacts stay unmanageable (fails closed)", async () => {
  const noTeams = { identity: deps.identity };
  const manages = createManagesArtifactHome(noTeams as never, createCanManageScope(noTeams as never));
  assert.equal(await manages("team:alpha", "bo@x.com", "bo@x.com"), false);
});
