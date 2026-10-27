import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeRelPath } from "./deploy-fs.ts";
import { currentVersionOf, type Deployment, type DeployEndpoint } from "./deploy-store.ts";
import type { DeployFile } from "./deploy-service.ts";

export const PUBLIC_LINKS_UNAVAILABLE =
  "This instance serves apps at /d/<app>/ on its own domain, which always requires sign-in, so a public link would still ask visitors to sign in. Public links need an apps domain: set DEPLOY_APPS_DOMAIN to a domain with a wildcard DNS record routed to the portal, and AWS_DEPLOY_GATE_SECRET.";

export type DeployAccessErrorCode =
  "not_found" | "forbidden" | "external_sharing_disabled" | "public_links_unavailable";

export class DeployAccessError extends Error {
  readonly code: DeployAccessErrorCode;
  constructor(code: DeployAccessErrorCode, message: string) {
    super(message);
    this.name = "DeployAccessError";
    this.code = code;
  }
}

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertAppSize(sizes: readonly number[], maxBytes: number | undefined): void {
  if (!maxBytes) return;
  const total = sizes.reduce((sum, n) => sum + n, 0);
  if (total > maxBytes) {
    throw new Error(
      `the app is too large to publish: ${total} bytes, maximum ${maxBytes} bytes — publish fewer or smaller files`,
    );
  }
}

export const fileSizes = (files: readonly DeployFile[] | undefined): number[] =>
  (files ?? []).map((f) => (typeof f.data === "string" ? Buffer.byteLength(f.data) : f.data.byteLength));

export function validateName(name: string): void {
  if (UUID_RE.test(name)) throw new Error(`invalid deployment name (looks like an id): ${name}`);
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid deployment name "${name}": use 2-40 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen`,
    );
  }
}

const DISPLAY_NAME_MAX = 60;
export function validateDisplayName(displayName: string): void {
  if (/[\u0000-\u001f\u007f]/.test(displayName)) throw new Error("invalid display name: no control characters");
  if (displayName.length > DISPLAY_NAME_MAX) throw new Error(`display name too long (max ${DISPLAY_NAME_MAX} chars)`);
}

export function deploymentEntrypoint(d: Deployment | null): string | undefined {
  return currentVersionOf(d)?.entrypoint || undefined;
}

export function requiredEntrypoint(input: string | undefined, d: Deployment | null): string {
  const entrypoint = input ?? deploymentEntrypoint(d);
  if (!entrypoint) throw new Error('publish requires an entrypoint, e.g. "node server.js"');
  return entrypoint;
}

export const renewDue = (d: Deployment): boolean =>
  d.endpoint?.renewAt !== undefined && Date.now() >= d.endpoint.renewAt;

export function endpointsEqual(a: DeployEndpoint, b: DeployEndpoint | null): boolean {
  return b != null && JSON.stringify(a) === JSON.stringify(b);
}

export async function snapshotFiles(deployDir: string, files: DeployFile[]): Promise<string> {
  const dir = join(deployDir, randomUUID());
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const target = resolve(dir, normalizeRelPath(f.path));
    const rel = relative(dir, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`deploy file escapes snapshot: ${f.path}`);
    await mkdir(dirname(target), { recursive: true });
    if (typeof f.data === "string") await writeFile(target, f.data, "utf8");
    else await writeFile(target, Buffer.from(f.data));
  }
  return dir;
}
