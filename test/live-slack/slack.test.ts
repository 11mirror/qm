import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { SlackClient } from "./slack.ts";

for (const status of [429, 500]) {
  test(`Slack qualification fails promptly on HTTP ${status} without hidden retries`, async () => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(status, { "content-type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify({ ok: false, error: "qualification-test" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const client = new SlackClient("synthetic-token", `http://127.0.0.1:${address.port}`);
      await assert.rejects(client.authTest());
      assert.equal(requests, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
