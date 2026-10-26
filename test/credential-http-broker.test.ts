import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brokerCredentialHttp } from "../src/api/credential-http-broker.ts";
import { type BrokeredConnector, CAPABILITY_TTL_MS, CREDENTIAL_BROKER_AUD } from "../src/auth/capability-token.ts";
import type { BaseCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";

function req(headers: Record<string, string>, body = ""): IncomingMessage {
  const r = Readable.from(body ? [body] : []) as IncomingMessage;
  r.headers = headers;
  return r;
}

function res(): ServerResponse & PassThrough & { capturedHeaders?: Record<string, string> } {
  const r = new PassThrough() as ServerResponse & PassThrough & { capturedHeaders?: Record<string, string> };
  let sent = false;
  Object.defineProperty(r, "headersSent", { get: () => sent });
  r.getHeader = () => undefined;
  r.writeHead = ((statusCode: number, headers?: Record<string, string>) => {
    r.statusCode = statusCode;
    r.capturedHeaders = headers ?? {};
    sent = true;
    return r;
  }) as unknown as typeof r.writeHead;
  return r;
}

async function text(r: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  r.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
  await finished(r);
  return Buffer.concat(chunks).toString("utf8");
}

function ctx(
  path: string,
  method: string,
  deps: ServerDeps,
  body = "",
  extra: { headers?: Record<string, string>; connectors?: BrokeredConnector[] } = {},
): BaseCtx & { res: ReturnType<typeof res> } {
  const url = new URL(path, "http://core.test");
  const out = res();
  return {
    req: req(
      extra.headers ?? {
        "content-type": "application/x-git-receive-pack-request",
        "git-protocol": "version=2",
      },
      body,
    ),
    res: out,
    app: {} as BaseCtx["app"],
    deps,
    secret: "credential-http-broker-test",
    auth: null,
    allowUnsignedSourceAuth: false,
    url,
    pathname: url.pathname,
    method,
    params: {},
    capability: {
      actorId: "U1",
      scopeId: "personal:U1",
      aud: CREDENTIAL_BROKER_AUD,
      credentials: ["gitlab"],
      ...(extra.connectors ? { connectors: extra.connectors } : {}),
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
  };
}

test("git HTTP broker streams a smart-HTTP request through the pinned service credential", async () => {
  let seen: { url: string; method: string; headers: Record<string, string>; body: string } | undefined;
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => ({
        slug: "gitlab",
        name: "GitLab git",
        secret: "dXNlcjp0b2tlbg==",
        host: "gitlab.example",
        injection: { scheme: "Basic " },
        allowedMethods: ["GET", "POST"],
        allowedPathPrefixes: ["/acme/repo.git"],
        enabled: true,
      }),
    } as unknown as ServerDeps["serviceCreds"],
    credentialHttpFetch: async (url, init) => {
      const chunks: Buffer[] = [];
      if (init.body)
        for await (const chunk of init.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      seen = { url, method: init.method, headers: init.headers, body: Buffer.concat(chunks).toString("utf8") };
      return {
        status: 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
        body: Readable.from(["0000"]),
      };
    },
  };
  const c = ctx("/v1/credentials/git/gitlab/acme/repo.git/git-receive-pack", "POST", deps, "PACK");
  await brokerCredentialHttp(c);

  assert.equal(await text(c.res), "0000");
  assert.equal(c.res.statusCode, 200);
  assert.equal(c.res.capturedHeaders?.["content-type"], "application/x-git-receive-pack-result");
  assert.deepEqual(seen, {
    url: "https://gitlab.example/acme/repo.git/git-receive-pack",
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      "git-protocol": "version=2",
      Authorization: "Basic dXNlcjp0b2tlbg==",
    },
    body: "PACK",
  });
});

test("git HTTP broker sends a credential's fixed headers over a caller's case variant", async () => {
  let seen: Record<string, string> | undefined;
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => ({
        slug: "gitlab",
        name: "GitLab git",
        secret: "dXNlcjp0b2tlbg==",
        host: "gitlab.example",
        injection: { scheme: "Basic ", headers: { "Git-Protocol": "version=1", "x-tenant": "acme" } },
        allowedMethods: ["GET", "POST"],
        allowedPathPrefixes: ["/acme/repo.git"],
        enabled: true,
      }),
    } as unknown as ServerDeps["serviceCreds"],
    credentialHttpFetch: async (_url, init) => {
      seen = init.headers;
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  };
  const c = ctx("/v1/credentials/git/gitlab/acme/repo.git/git-receive-pack", "POST", deps, "PACK");
  await brokerCredentialHttp(c);
  await text(c.res);
  assert.deepEqual(seen, {
    "content-type": "application/x-git-receive-pack-request",
    "Git-Protocol": "version=1",
    "x-tenant": "acme",
    Authorization: "Basic dXNlcjp0b2tlbg==",
  });
});

test("git HTTP broker refuses an env-delivery record like a missing credential", async () => {
  let fetched = false;
  const deps: ServerDeps = {
    control: {} as ServerDeps["control"],
    serviceCreds: {
      getServiceCredentialSecret: async () => ({
        slug: "gitlab",
        name: "GitLab git",
        secret: "dXNlcjp0b2tlbg==",
        delivery: "env",
        envKey: "GITLAB_TOKEN",
        host: "gitlab.example",
        enabled: true,
      }),
    } as unknown as ServerDeps["serviceCreds"],
    credentialHttpFetch: async () => {
      fetched = true;
      return { status: 200, headers: {}, body: Readable.from(["0000"]) };
    },
  };
  const c = ctx("/v1/credentials/git/gitlab/acme/repo.git/info/refs?service=git-upload-pack", "GET", deps);
  await brokerCredentialHttp(c);
  assert.equal(c.res.statusCode, 404);
  assert.equal(fetched, false, "no upstream git fetch happens");
});

test("git HTTP broker refuses encoded parent traversal past the repo path", async () => {
  for (const path of [
    "/v1/credentials/git/gitlab/acme/repo.git/..%2fother-repo.git/info/refs",
    "/v1/credentials/git/gitlab/acme/repo.git/%2e%2e%2fother-repo.git/info/refs",
    "/v1/credentials/git/gitlab/acme/repo.git/%252e%252e%252fother/info/refs",
  ]) {
    let fetched = false;
    const deps: ServerDeps = {
      control: {} as ServerDeps["control"],
      serviceCreds: {
        getServiceCredentialSecret: async () => ({
          slug: "gitlab",
          name: "GitLab git",
          secret: "dXNlcjp0b2tlbg==",
          host: "gitlab.example",
          injection: { scheme: "Basic " },
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/acme/repo.git"],
          enabled: true,
        }),
      } as unknown as ServerDeps["serviceCreds"],
      credentialHttpFetch: async () => {
        fetched = true;
        return { status: 200, headers: {}, body: Readable.from(["0000"]) };
      },
    };
    const c = ctx(path, "GET", deps);
    await brokerCredentialHttp(c);
    assert.equal(c.res.statusCode, 403, path);
    assert.match(await text(c.res), /path_not_allowed/);
    assert.equal(fetched, false, "no upstream git fetch happens");
  }
});

test("git HTTP broker cannot use a Composio key for project-wide discovery or execution", async () => {
  for (const method of ["GET", "POST"]) {
    let contacted = false;
    const deps = {
      control: {},
      serviceCreds: {
        getServiceCredentialSecret: async () => ({
          slug: "gitlab",
          name: "legacy",
          secret: "project-key",
          enabled: true,
          delivery: "broker",
          host: "backend.composio.dev",
          allowedMethods: ["GET", "POST"],
        }),
      },
      credentialHttpFetch: async () => {
        contacted = true;
        throw new Error("must not contact upstream");
      },
    } as unknown as ServerDeps;
    const c = ctx("/v1/credentials/git/gitlab/api/v3.1/connected_accounts", method, deps);
    await brokerCredentialHttp(c);
    await text(c.res);
    assert.equal(c.res.statusCode, 403);
    assert.equal(contacted, false);
  }
});

const GMAIL: BrokeredConnector = {
  handle: "connector:gmail.googleapis.com:default",
  host: "gmail.googleapis.com",
  ownerId: "U1",
};

function connectorDeps(
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>,
  extra: Partial<ServerDeps> = {},
): ServerDeps {
  return {
    control: {} as ServerDeps["control"],
    connectorTokens: {
      connectorAccessToken: async (host: string, ownerId: string, accountType?: string) =>
        `tok:${host}:${ownerId}:${accountType ?? "default"}`,
    } as unknown as ServerDeps["connectorTokens"],
    credentialHttpFetch: async (url, init) => {
      const chunks: Buffer[] = [];
      if (init.body)
        for await (const chunk of init.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      calls.push({ url, method: init.method, headers: init.headers, body: Buffer.concat(chunks).toString("utf8") });
      return { status: 201, headers: { "content-type": "application/json" }, body: Readable.from(['{"ok":true}']) };
    },
    ...extra,
  };
}

test("connected-app broker injects the owner's OAuth token for the connector host", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const c = ctx(
    "/v1/credentials/http/gmail.googleapis.com/gmail/v1/users/me/drafts?alt=json",
    "PUT",
    connectorDeps(calls),
    '{"raw":"x"}',
    {
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sandbox-guess",
        "x-agent-capability": "cap",
        "x-goog-upload-protocol": "multipart",
      },
      connectors: [GMAIL],
    },
  );
  await brokerCredentialHttp(c);
  assert.equal(await text(c.res), '{"ok":true}');
  assert.equal(c.res.statusCode, 201);
  assert.deepEqual(calls, [
    {
      url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts?alt=json",
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-goog-upload-protocol": "multipart",
        authorization: "Bearer tok:gmail.googleapis.com:U1:default",
      },
      body: '{"raw":"x"}',
    },
  ]);
});

test("connected-app broker needs the handle when two selected accounts share a host", async () => {
  const company = { ...GMAIL, handle: "connector:gmail.googleapis.com:company", accountType: "company" };
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const ambiguous = ctx(
    "/v1/credentials/http/gmail.googleapis.com/gmail/v1/users/me/profile",
    "GET",
    connectorDeps(calls),
    "",
    {
      headers: {},
      connectors: [GMAIL, company],
    },
  );
  await brokerCredentialHttp(ambiguous);
  assert.equal(ambiguous.res.statusCode, 409);
  assert.match(await text(ambiguous.res), /ambiguous_connector/);
  const named = ctx(
    `/v1/credentials/http/${encodeURIComponent(company.handle)}/gmail/v1/users/me/profile`,
    "GET",
    connectorDeps(calls),
    "",
    { headers: {}, connectors: [GMAIL, company] },
  );
  await brokerCredentialHttp(named);
  await text(named.res);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.authorization, "Bearer tok:gmail.googleapis.com:U1:company");
});

test("connected-app broker refuses revoked grants, lost tokens, and hosts the capability does not name", async () => {
  const granted = { ...GMAIL, handle: "gmail.googleapis.com:abc", grantId: "g1" };
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const revoked = ctx(
    "/v1/credentials/http/gmail.googleapis.com/gmail/v1/users/me/profile",
    "GET",
    connectorDeps(calls, {
      keychain: { getGrant: async () => ({ id: "g1", status: "revoked" }) } as unknown as ServerDeps["keychain"],
    }),
    "",
    { headers: {}, connectors: [granted] },
  );
  await brokerCredentialHttp(revoked);
  assert.equal(revoked.res.statusCode, 403);
  assert.match(await text(revoked.res), /grant_revoked/);

  const lost = ctx(
    "/v1/credentials/http/gmail.googleapis.com/gmail/v1/users/me/profile",
    "GET",
    connectorDeps(calls, {
      connectorTokens: { connectorAccessToken: async () => null } as unknown as ServerDeps["connectorTokens"],
    }),
    "",
    { headers: {}, connectors: [GMAIL] },
  );
  await brokerCredentialHttp(lost);
  assert.equal(lost.res.statusCode, 410);
  assert.match(await text(lost.res), /connector_unavailable/);

  const other = ctx("/v1/credentials/http/slack.com/api/auth.test", "GET", connectorDeps(calls), "", {
    headers: {},
    connectors: [GMAIL],
  });
  await brokerCredentialHttp(other);
  assert.ok(other.res.statusCode >= 400);
  await text(other.res);
  assert.deepEqual(calls, [], "no upstream request is made");
});
