import assert from "node:assert/strict";
import { test } from "node:test";
import { signInMembers } from "../src/directory/sign-in-members.ts";

test("sign-in member fallback reports user-store failures", async (t) => {
  const diagnostics: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void diagnostics.push(args.map(String).join(" ")));
  const members = await signInMembers({
    identity: {
      listExternalMembers: async () => [],
      classify: () => ({ type: "internal" }) as never,
    },
    sessions: { distinctParticipants: async () => ["U1"] },
    users: { resolve: async () => Promise.reject(new Error("user store unavailable")) },
  });
  assert.deepEqual(
    members.map(({ principalId }) => principalId),
    ["U1"],
  );
  assert.match(diagnostics.join("\n"), /directory: resolve sign-in member users.*user store unavailable/);
});
