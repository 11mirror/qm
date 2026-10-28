import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebClient } from "@slack/web-api";
import { validateSlackInstallation } from "../../src/surfaces/slack-installation.ts";
import type { SlackWebClientFactory } from "../../src/slack/web-client.ts";

const botToken = "xoxb-test-secret";
const appToken = "xapp-test-secret";

async function slackApi(
  t: test.TestContext,
  reply: (method: string) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<SlackWebClientFactory> {
  const server = createServer((req, res) => {
    const { status = 200, headers = {}, body } = reply((req.url ?? "").replace(/^\/+/, ""));
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return (token, options) => new WebClient(token, { ...options, slackApiUrl: base });
}

test("Slack validation explains provider throttling without trying to parse a non-JSON response", async (t) => {
  const client = await slackApi(t, () => ({ status: 429, headers: { "retry-after": "30" }, body: "slow down" }));
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, client),
    /in 30 seconds.*existing connection has not changed/,
  );
});

test("Slack validation identifies which token needs a scope", async (t) => {
  const client = await slackApi(t, (method) => ({
    body: JSON.stringify(method === "auth.test" ? { ok: true, app_id: "A1" } : { ok: false, error: "missing_scope" }),
  }));
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, client),
    /App-level token needs connections:write/,
  );
});

test("Slack validation gives a recoverable bot-token error without revealing credentials", async (t) => {
  const client = await slackApi(t, () => ({ body: JSON.stringify({ ok: false, error: "token_revoked" }) }));
  await assert.rejects(validateSlackInstallation(botToken, appToken, client), (error: Error) => {
    assert.match(error.message, /Bot token was rejected.*current token/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});

test("Slack validation resolves the app id through bots.info and checks it against the socket hello", async (t) => {
  const replies: Record<string, object> = {
    "auth.test": { ok: true, bot_id: "B1", team_id: "T1", team: "Acme" },
    "bots.info": { ok: true, bot: { app_id: "A1" } },
    "apps.connections.open": { ok: true, url: "wss://wss-primary.slack.com/link" },
  };
  const client = await slackApi(t, (method) => ({ body: JSON.stringify(replies[method]) }));
  assert.deepEqual(await validateSlackInstallation(botToken, appToken, client, async () => "A1"), {
    teamId: "T1",
    teamName: "Acme",
  });
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, client, async () => "A2"),
    /belong to different Slack apps/,
  );
});

test("an HTTP-events tenant installs with only a bot token and never opens a socket", async (t) => {
  const called: string[] = [];
  const client = await slackApi(t, (method) => {
    called.push(method);
    return { body: JSON.stringify({ ok: true, app_id: "A1", team_id: "T1", team: "Acme" }) };
  });
  const noSocket = async (): Promise<string> => assert.fail("no socket for an HTTP-events tenant");
  assert.deepEqual(await validateSlackInstallation(botToken, "", client, noSocket, true), {
    teamId: "T1",
    teamName: "Acme",
  });
  assert.deepEqual(called, ["auth.test"]);
  await assert.rejects(validateSlackInstallation(botToken, "", client), /App token must start with xapp-/);
});
