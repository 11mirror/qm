import { createHmac, timingSafeEqual } from "node:crypto";

export type TokenKey = string | Buffer;

export function deriveKey(secret: string, label: string): Buffer {
  return createHmac("sha256", secret).update(label).digest();
}

const mac = (key: TokenKey, body: string): Buffer => createHmac("sha256", key).update(body).digest();

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function seal(payload: unknown, key: TokenKey): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${mac(key, body).toString("base64url")}`;
}

export function open(token: string | null | undefined, key: TokenKey | TokenKey[]): Record<string, unknown> | null {
  const [body, signature, ...rest] = token?.split(".") ?? [];
  if (!body || !signature || rest.length) return null;
  const signedWith = (candidate: TokenKey): boolean => {
    const digest = mac(candidate, body);
    return sameText(digest.toString("base64url"), signature) || sameText(digest.toString("hex"), signature);
  };
  if (!(Array.isArray(key) ? key : [key]).some(signedWith)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
