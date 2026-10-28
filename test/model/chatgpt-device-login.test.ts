import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { pollChatGPTDeviceLogin, startChatGPTDeviceLogin } from "../../src/model/subscription-oauth.ts";

function accessToken(accountId: string): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "RS256", typ: "JWT" })}.${seg({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

function fakeAuthServer(t: TestContext, opts: { userCodeStatus?: number } = {}) {
  let decision: "pending" | "slow" | "approved" | "denied" = "pending";
  const calls: Array<{ url: string; body: string }> = [];
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/api/accounts/deviceauth/usercode")) {
      if (opts.userCodeStatus) return json(opts.userCodeStatus, { error: "unavailable" });
      return json(200, { device_auth_id: "device-1", user_code: "ABCD-1234", interval: "1" });
    }
    if (url.endsWith("/api/accounts/deviceauth/token")) {
      if (decision === "approved")
        return json(200, { authorization_code: "code-1", code_challenge: "c", code_verifier: "verifier-1" });
      if (decision === "denied") return json(400, { error: { code: "access_denied", message: "denied by user" } });
      if (decision === "slow") return json(400, { error: "slow_down" });
      return json(400, { error: { code: "deviceauth_authorization_pending" } });
    }
    if (url.endsWith("/oauth/token"))
      return json(200, { access_token: accessToken("acct_9"), refresh_token: "ref-1", expires_in: 3600 });
    return json(404, {});
  });
  return {
    approve: () => (decision = "approved"),
    deny: () => (decision = "denied"),
    slow: () => (decision = "slow"),
    calls,
  };
}

test("device login: start returns the provider's device code and any poll redeems it once approved", async (t) => {
  const server = fakeAuthServer(t);
  const prompt = await startChatGPTDeviceLogin();
  assert.equal(prompt.deviceAuthId, "device-1");
  assert.equal(prompt.userCode, "ABCD-1234");
  assert.equal(prompt.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(prompt.intervalMs, 1000);
  assert.ok(prompt.expiresAt > Date.now());
  assert.equal(await pollChatGPTDeviceLogin(prompt.deviceAuthId, prompt.userCode), "pending");
  server.approve();
  const tokens = await pollChatGPTDeviceLogin(prompt.deviceAuthId, prompt.userCode);
  assert.ok(typeof tokens === "object");
  assert.equal(tokens.accessToken, accessToken("acct_9"));
  assert.equal(tokens.refreshToken, "ref-1");
  assert.equal(tokens.accountId, "acct_9");
  const poll = server.calls.find((call) => call.url.endsWith("/deviceauth/token"));
  assert.deepEqual(JSON.parse(poll!.body), { device_auth_id: "device-1", user_code: "ABCD-1234" });
  const exchange = server.calls.find((call) => call.url.endsWith("/oauth/token"));
  assert.match(exchange?.body ?? "", /code_verifier=verifier-1/);
  assert.match(exchange?.body ?? "", /deviceauth%2Fcallback/);
});

test("device login: a denied login surfaces the provider error", async (t) => {
  const server = fakeAuthServer(t);
  const prompt = await startChatGPTDeviceLogin();
  server.deny();
  await assert.rejects(() => pollChatGPTDeviceLogin(prompt.deviceAuthId, prompt.userCode), /denied by user/);
});

test("device login: a provider failure before the prompt rejects start", async (t) => {
  fakeAuthServer(t, { userCodeStatus: 500 });
  await assert.rejects(() => startChatGPTDeviceLogin(), /device code request failed \(500\)/);
});

test("device login: slow_down holds the poll reply back so the browser's next poll comes later", async (t) => {
  const server = fakeAuthServer(t);
  const prompt = await startChatGPTDeviceLogin();
  server.slow();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const poll = pollChatGPTDeviceLogin(prompt.deviceAuthId, prompt.userCode).finally(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.equal(await poll, "pending");
});
