import test from "node:test";
import assert from "node:assert/strict";
import { gmailToken } from "../src/inbox/sources/gmail.ts";
import type { InboxItem } from "../src/types.ts";

test("refresh and send read a Gmail item with the account it came from", async () => {
  const asked: Array<string | undefined> = [];
  const tokens = {
    connectorAccessToken: async (_host: string, _owner: string, account?: string) => {
      asked.push(account);
      return account === "company" ? "company-token" : null;
    },
  };
  const item = { sourcePayload: { gmail: { threadId: "t1", accountType: "company" } } } as unknown as InboxItem;
  assert.equal(await gmailToken(tokens, "owner", item), "company-token");
  assert.deepEqual(asked, ["company"]);
});
