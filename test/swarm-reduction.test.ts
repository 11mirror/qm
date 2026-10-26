import { test } from "node:test";
import assert from "node:assert/strict";
import { swarmFixture } from "./support/swarm-fixture.ts";
import { claimTurn, finishTurn } from "./support/turns.ts";

type Fixture = Awaited<ReturnType<typeof swarmFixture>>;
const endings: Record<string, (f: Fixture, turn: Parameters<typeof finishTurn>[0]) => Promise<unknown>> = {
  completed: (_f, turn) => finishTurn(turn, { status: "ok", reply: "Done" }),
  failed: (_f, turn) => finishTurn(turn, { status: "failed", reason: "Failed" }, "failed"),
  "handed back": (f, turn) => f.ledger.handBack(turn.run, turn.token, { stop: { kind: "shutdown" } }),
  replaced: async (f, turn) => {
    await f.ledger.handBack(turn.run, turn.token, { stop: { kind: "shutdown" } });
    await claimTurn(f.ledger, turn.run.id);
  },
};
for (const [name, end] of Object.entries(endings)) {
  for (const atCommit of [false, true]) {
    test(`${name} run is rejected at ${atCommit ? "commit" : "admission"}`, async () => {
      const f = await swarmFixture();
      if (f.caller.kind !== "agent") throw new Error("wrong caller");
      await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
      const before = await f.store.get(f.root.id);
      const run = (await f.runs.get(f.caller.claims.runId!))!;
      let ended: Promise<unknown> | undefined;
      const invalidate = () => (ended ??= end(f, { run, token: f.caller.claims.runLeaseToken!, ledger: f.ledger }));
      if (atCommit) {
        const update = f.store.update.bind(f.store);
        f.store.update = async (...args) => {
          await invalidate();
          return update(...args);
        };
      } else await invalidate();
      await assert.rejects(f.service.context(f.caller, { changed: true }), /active capability run required/);
      assert.deepEqual(await f.store.get(f.root.id), before);
    });
  }
}

for (const conflict of [false, true]) {
  test(`simultaneous sends ${conflict ? "reject changed content" : "deduplicate"} at commit`, async () => {
    const f = await swarmFixture();
    await f.service.spawn(f.caller, { requestId: "initial", text: "work" });
    await f.service.sweep();
    const initial = (await f.service.read(f.caller, {}))[0]!;
    const before = (await f.store.get(f.root.id))!;
    const update = f.store.update.bind(f.store);
    const ready = Promise.withResolvers<void>();
    let arrivals = 0;
    f.store.update = async (...args) => {
      if (++arrivals === 2) ready.resolve();
      await ready.promise;
      return update(...args);
    };
    const input = { requestId: "note", text: "reply", audience: "all" as const, replyTo: initial.id, notify: false };
    const results = await Promise.allSettled([
      f.service.send(f.caller, input),
      f.service.send(f.caller, { ...input, text: conflict ? "changed" : input.text }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, conflict ? 1 : 2);
    const failed = results.find((r) => r.status === "rejected");
    if (conflict) assert.match(String(failed?.reason), /requestId reused/);
    else assert.deepEqual(results[0], results[1]);
    const swarm = (await f.store.get(f.root.id))!;
    assert.equal(swarm.messages.length, before.messages.length + 1);
    assert.equal(swarm.notificationCount, before.notificationCount);
    const message = swarm.messages.at(-1)!;
    assert.equal(message.seq, initial.seq + 1);
    assert.equal(message.senderId, f.root.id);
    assert.equal(message.senderSessionId, f.root.id);
    assert.equal(message.author, "agent");
    assert.equal(message.actorId, initial.actorId);
    assert.equal(message.replyTo, initial.id);
    assert.deepEqual(message.audience, swarm.members.map((m) => m.id).sort());
    assert.deepEqual(message.notifications, {});
  });
}
