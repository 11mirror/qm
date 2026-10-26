import { signedHeaders, withSourceAuthNonce } from "./core-client.ts";
import { errMessage } from "./errors.ts";

const EMAIL_ALLOWED_PATH = "/v1/auth/broker/email-allowed";
const EMAIL_ALLOWED_TIMEOUT_MS = 4_000;

export class ExternalMemberLookupUnavailableError extends Error {
  constructor() {
    super("couldn't check whether this email may sign in right now, please try again");
    this.name = "ExternalMemberLookupUnavailableError";
  }
}

export interface EmailAdmission {
  allowed: boolean;
  appOnly?: true;
}

export async function coreEmailAdmission(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
  label = "chassis",
): Promise<EmailAdmission> {
  const path = withSourceAuthNonce(`${EMAIL_ALLOWED_PATH}?email=${encodeURIComponent(email)}`, signingSecret);
  let r: Response;
  let parsed: { allowed?: unknown; appOnly?: unknown };
  try {
    r = await fetch(`${coreApiUrl}${path}`, {
      headers: signedHeaders(signingSecret, "GET", path),
      signal: AbortSignal.timeout(EMAIL_ALLOWED_TIMEOUT_MS),
    });
    parsed = (r.ok ? ((await r.json()) as typeof parsed | null) : null) ?? {};
  } catch (e) {
    console.error(`[${label}] core external-member lookup failed: ${errMessage(e)}`);
    throw new ExternalMemberLookupUnavailableError();
  }
  if (r.status >= 500) {
    console.error(`[${label}] core external-member lookup failed: HTTP ${r.status}`);
    throw new ExternalMemberLookupUnavailableError();
  }
  if (!r.ok) {
    console.error(`[${label}] core refused an external-member lookup: HTTP ${r.status}`);
    return { allowed: false };
  }
  if (parsed.allowed !== true || (parsed.appOnly !== undefined && typeof parsed.appOnly !== "boolean"))
    return { allowed: false };
  return { allowed: true, ...(parsed.appOnly === true ? { appOnly: true } : {}) };
}

export async function coreEmailAllowed(
  coreApiUrl: string,
  signingSecret: string | undefined,
  email: string,
  label = "chassis",
): Promise<boolean> {
  try {
    return (await coreEmailAdmission(coreApiUrl, signingSecret, email, label)).allowed;
  } catch (e) {
    if (e instanceof ExternalMemberLookupUnavailableError) return false;
    throw e;
  }
}
