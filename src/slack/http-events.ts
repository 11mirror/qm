import type { IncomingMessage, ServerResponse } from "node:http";
import bolt from "@slack/bolt";
import type { Receiver, App as BoltApp } from "@slack/bolt";
import { processEnvelope } from "./deferred-ack.ts";
import type { EnvelopeStaging } from "./envelope-staging.ts";
import type { SlackEventsEndpoint, SlackNative } from "../surfaces/slack-surface.ts";
import { PayloadTooLargeError, readBody } from "../../plugins/chassis/src/http.ts";

const { isValidSlackRequest } = bolt;

const MAX_BODY_BYTES = 5_000_000;

type SlackBody = Record<string, unknown>;

function respond(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : (JSON.stringify(body) ?? ""));
}

async function verifiedSlackBody(
  req: IncomingMessage,
  res: ServerResponse,
  signingSecret: string,
): Promise<SlackBody | undefined> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (error) {
    const large = error instanceof PayloadTooLargeError;
    respond(res, large ? 413 : 400, { error: large ? "body_too_large" : "invalid_body" });
    return undefined;
  }
  const signature = header(req, "x-slack-signature");
  const timestamp = Number(header(req, "x-slack-request-timestamp"));
  if (
    !signature ||
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 5 * 60 ||
    !isValidSlackRequest({
      signingSecret,
      body: raw,
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
    })
  ) {
    respond(res, 401, { error: "invalid_signature" });
    return undefined;
  }
  let body: SlackBody;
  try {
    const form = raw.startsWith("payload=") ? new URLSearchParams(raw).get("payload") : null;
    body = JSON.parse(form ?? raw) as SlackBody;
  } catch {
    respond(res, 400, { error: "invalid_json" });
    return undefined;
  }
  if (body.type === "url_verification") {
    respond(res, 200, { challenge: body.challenge });
    return undefined;
  }
  return body;
}

export async function receiveSlackRequest(
  slack: SlackNative,
  account: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const signingSecret = slack.signingSecret(account);
  if (!signingSecret) return false;
  const body = await verifiedSlackBody(req, res, signingSecret);
  if (!body) return true;
  await slack.ready();
  const endpoint = slack.events(account);
  if (!endpoint) respond(res, 503, { error: "slack_not_ready" });
  else await endpoint.dispatch(req, res, body);
  return true;
}

export function createHttpEventsReceiver(opts: {
  signingSecret: string;
  capMs?: number | undefined;
  staging?: EnvelopeStaging | undefined;
  serve: (endpoint: SlackEventsEndpoint) => () => void;
}): Receiver & { handle(req: IncomingMessage, res: ServerResponse): Promise<void> } {
  let app: BoltApp | undefined;
  let release: (() => void) | undefined;

  async function dispatch(req: IncomingMessage, res: ServerResponse, body: SlackBody): Promise<void> {
    const retryNum = Number(header(req, "x-slack-retry-num"));
    await processEnvelope(app, body, async (response?: unknown) => respond(res, 200, response ?? {}), {
      capMs: opts.capMs,
      staging: opts.staging,
      onWithhold: () => respond(res, 503, { error: "not_persisted" }),
      retryNum: Number.isFinite(retryNum) ? retryNum : undefined,
      retryReason: header(req, "x-slack-retry-reason") || undefined,
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await verifiedSlackBody(req, res, opts.signingSecret);
    if (body) await dispatch(req, res, body);
  }

  return {
    handle,
    init(a: BoltApp) {
      app = a;
    },
    async start() {
      release = opts.serve({ signingSecret: opts.signingSecret, dispatch });
    },
    async stop() {
      release?.();
      release = undefined;
    },
  } as Receiver & { handle(req: IncomingMessage, res: ServerResponse): Promise<void> };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
