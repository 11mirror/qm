import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../../../src/core/orchestrator/sandboxes.ts";

test("Open owner computer rechecks revocation before reuse and is destroyed, never shared", async () => {
  let member = true;
  const global = { scopeId: "org:test", mode: "ro", mountPath: "global" };
  const handle = { id: "owner-test", cwd: "/tmp/owner-test" };
  const provisions: unknown[][] = [];
  const releases: unknown[][] = [];
  const audits: unknown[] = [];
  const context = {
    deps: {
      sandbox: {
        provision: async (...args: unknown[]) => {
          provisions.push(args);
          return handle;
        },
        teardown: async (...args: unknown[]) => {
          releases.push(args);
        },
      },
      auditLog: { record: (event: unknown) => audits.push(event) },
      isCurrentSharedScopeMember: async () => member,
    },
    input: {},
    actor: { id: "alice", type: "internal" },
    session: { id: "session-one" },
    resolution: { layers: [global, { scopeId: "channel:room", mode: "rw", mountPath: "." }] },
    scopeId: "channel:room",
    memoryScopeId: "channel:room",
    transferId: "turn-one",
    isolateOwnerKeychain: true,
    openSpeakerKeychain: true,
    ownerAuthAvailable: true,
    connectorEnv: {},
    credentialServices: [],
    quarantinedServices: [],
  } as unknown as TurnSandboxContext;
  const boxes = createTurnSandboxes(context);
  assert.equal(await boxes.provisionOwnerAuth!(), handle);
  assert.equal(await boxes.provisionOwnerAuth!(), handle);
  assert.equal(provisions.length, 1);
  assert.deepEqual(provisions[0]![0], [global]);
  assert.deepEqual((provisions[0]![1] as { scratch: unknown }).scratch, { key: "owner-auth:session-one:turn-one" });
  member = false;
  await assert.rejects(boxes.provisionOwnerAuth!(), /no longer authorized/);
  member = true;
  const command = boxes.ownerAuthCommand!("true");
  assert.match(command, /^unset AGENT_API_TOKEN AGENT_OAUTH_CONSENT_TOKEN; unset AGENT_CREDENTIAL_TOKEN /);
  assert.doesNotMatch(
    boxes.ownerAuthCommand!("true", { AGENT_CREDENTIAL_TOKEN: "selected" }),
    /unset [^;]*AGENT_CREDENTIAL_TOKEN/,
    "a selected broker credential survives into the owner command",
  );
  assert.ok(!JSON.stringify(audits).includes("synthetic-secret"));
  await boxes.reclaimBox();
  assert.deepEqual(releases, [[handle, { destroy: true }]]);
  assert.equal(boxes.ownerAuthBox.handle, null);
});
