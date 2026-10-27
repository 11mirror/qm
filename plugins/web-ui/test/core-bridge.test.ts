import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalBlocksComposer,
  type PendingApproval,
  fetchSessionApprovals,
  resolveApproval,
  unresolvedApprovals,
  slackThreadUrl,
} from "../src/core-bridge.ts";
import { attachPendingApprovals } from "../src/transcript-messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

test("only approvals that block input lock the composer", () => {
  const blocking = { requestId: "a", command: "rm x" } as PendingApproval;
  const explicit = { requestId: "b", command: "rm y", blocksInput: true } as PendingApproval;
  const nonBlocking = { requestId: "c", command: "send it?", blocksInput: false } as PendingApproval;
  assert.equal(approvalBlocksComposer(blocking), true);
  assert.equal(approvalBlocksComposer(explicit), true);
  assert.equal(approvalBlocksComposer(nonBlocking), false);
});

const approval = (id: string): PendingApproval => ({
  requestId: `keychain:${id}`,
  command: "aws",
  reason: "Credential approval",
});

test("accepted credential decisions survive failed refreshes and late pending responses", async () => {
  const pending = approval("refresh-race");
  const other = approval("unrelated");
  const original = globalThis.fetch;
  let finishRead!: (response: Response) => void;
  let posts = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return Response.json({ ask: { status: "approved" } });
    }
    return new Promise<Response>((resolve) => {
      finishRead = resolve;
    });
  }) as typeof fetch;
  try {
    const staleRead = fetchSessionApprovals("parent");
    await resolveApproval({ requestId: pending.requestId, approved: true, scope: "always" });
    assert.deepEqual(unresolvedApprovals([pending, other]), [other]);
    finishRead(Response.json({ approvals: [pending, other] }));
    assert.deepEqual(await staleRead, { approvals: [other] });
    globalThis.fetch = (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch;
    assert.equal(await fetchSessionApprovals("child"), null);
    assert.deepEqual(unresolvedApprovals([pending, other]), [other]);
    const messages: AgentMessage[] = [];
    attachPendingApprovals(messages, [pending]);
    assert.deepEqual(messages, []);
    await resolveApproval({ requestId: pending.requestId, approved: true, scope: "always" });
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("failed and still-pending decisions remain retryable", async () => {
  const pending = approval("retryable");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
    await assert.rejects(resolveApproval({ requestId: pending.requestId, approved: true, scope: "once" }));
    assert.deepEqual(unresolvedApprovals([pending]), [pending]);
    globalThis.fetch = (async () => Response.json({ ask: { status: "pending" } })) as typeof fetch;
    await assert.rejects(
      resolveApproval({ requestId: pending.requestId, approved: true, scope: "once" }),
      /still pending/,
    );
    assert.deepEqual(unresolvedApprovals([pending]), [pending]);
    globalThis.fetch = (async () => Response.json({ ask: { status: "declined" } })) as typeof fetch;
    await resolveApproval({ requestId: pending.requestId, approved: false });
    assert.deepEqual(unresolvedApprovals([pending]), []);
  } finally {
    globalThis.fetch = original;
  }
});

test("slackThreadUrl builds archive permalinks from threadRefs", () => {
  const base = "https://acme.slack.com";
  assert.equal(slackThreadUrl(base, "ch:C0AB12CD3:1699999999.000100"), `${base}/archives/C0AB12CD3/p1699999999000100`);
  assert.equal(slackThreadUrl(base, "dm:D0AB12CD3"), `${base}/archives/D0AB12CD3`);
  assert.equal(slackThreadUrl(null, "dm:D0AB12CD3"), null, "no workspace URL → no link");
  assert.equal(slackThreadUrl(base, "web:alice:t1"), null, "web threadRefs are not Slack-linkable");
});
