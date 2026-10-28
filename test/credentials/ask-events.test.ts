import assert from "node:assert/strict";
import test from "node:test";
import { askResolutionEvents } from "../../src/credentials/ask-events.ts";
import type { KeychainAsk, KeychainCredentialMeta } from "../../src/credentials/keychain.ts";

const base = {
  id: "ask",
  credentialId: "secret",
  ownerId: "owner",
  requesterId: "requester",
  requesterScopeId: "personal:requester",
  purpose: "Work",
  createdAt: 1,
  expiresAt: 1000,
} as const;

test("access events report only resolutions newer than the last user entry in order", async () => {
  const asks: KeychainAsk[] = [
    { ...base, status: "pending" },
    { ...base, status: "denied", resolvedAt: 4 },
    { ...base, status: "approved", resolvedAt: 8 },
    { ...base, credentialId: "deleted", status: "denied", resolvedAt: 6 },
  ];
  const events = await askResolutionEvents(
    asks,
    4,
    () => "Ada",
    async (id) => (id === "secret" ? ({ service: "GitHub" } as KeychainCredentialMeta) : null),
  );
  assert.equal(
    events,
    "Access request to Ada for deleted credential `deleted` was denied.\nAccess request to Ada for `GitHub` was approved.",
  );
  assert.equal(
    await askResolutionEvents(
      asks,
      8,
      () => "Ada",
      async () => null,
    ),
    "",
  );
});
