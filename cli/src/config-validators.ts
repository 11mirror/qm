import { CliError, warn } from "./log.ts";
import { isDeclaredService, pluginNameError, type DeclaredServiceName } from "./services.ts";
import {
  isSandboxBackendId,
  SANDBOX_BACKEND_POLICY,
  SANDBOX_BACKENDS,
  targetsAllowingSandboxBackend,
  type Target,
} from "./providers.ts";
import { isEnvVarName } from "./util.ts";
import type { PluginEntry, PluginSecret, SandboxConfig, SecurityScreenConfig } from "./config.ts";

export const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
export const IAM_ROLE_ARN = /^arn:aws:iam::([0-9]{12}):role\/[A-Za-z0-9_+=,.@/-]{1,512}$/;

export const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export function validateSecurityScreen(raw: unknown, path: string): SecurityScreenConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new CliError(`${path}: "securityScreen" must be an object`);
  const allowed = new Set(["provider", "endpoint"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new CliError(`${path}: "securityScreen.${key}" is not recognized`);
  }
  if (
    typeof raw.provider !== "string" ||
    raw.provider.length > 63 ||
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(raw.provider)
  ) {
    throw new CliError(`${path}: "securityScreen.provider" must be a lowercase DNS label`);
  }
  if (raw.provider === "surface" || raw.provider === "origin") {
    throw new CliError(`${path}: "securityScreen.provider" must not collide with a security screen metadata field`);
  }
  if (typeof raw.endpoint !== "string") {
    throw new CliError(`${path}: "securityScreen.endpoint" must be an HTTPS URL`);
  }
  try {
    const endpoint = new URL(raw.endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.hostname.endsWith(".")
    ) {
      throw new Error("endpoint");
    }
  } catch {
    throw new CliError(
      `${path}: "securityScreen.endpoint" must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot`,
    );
  }
  return { provider: raw.provider, endpoint: raw.endpoint };
}

export function validatePlugins(raw: unknown, path: string): PluginEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CliError(`${path}: "plugins" must be an array`);
  const seen = new Set<string>();
  return raw.map((p, i) => {
    if (typeof p !== "object" || p === null) throw new CliError(`${path}: plugins[${i}] must be an object`);
    const e = p as Record<string, unknown>;
    if (typeof e["name"] !== "string" || !e["name"].trim()) throw new CliError(`${path}: plugins[${i}].name required`);
    const name = e["name"];
    const nameError = pluginNameError(name);
    if (nameError) throw new CliError(`${path}: plugins[${i}].name ${JSON.stringify(name)} ${nameError}`);
    if (seen.has(name)) throw new CliError(`${path}: duplicate plugin name ${JSON.stringify(name)}`);
    seen.add(name);
    const entry: PluginEntry = { name };
    if (e["image"] !== undefined) {
      if (typeof e["image"] !== "string" || !e["image"].trim()) {
        throw new CliError(`${path}: plugins[${i}].image must be a non-empty string (a pullable image ref) when set`);
      }
      entry.image = e["image"];
    }
    if (e["env"] !== undefined) entry.env = validateStringMap(e["env"], path, `plugins[${i}].env`);
    if (e["secrets"] !== undefined) entry.secrets = validatePluginSecrets(e["secrets"], path, i);
    if (e["coreAccess"] !== undefined) {
      if (typeof e["coreAccess"] !== "boolean") {
        throw new CliError(`${path}: plugins[${i}].coreAccess must be a boolean`);
      }
      entry.coreAccess = e["coreAccess"];
    }
    if (entry.coreAccess === false) {
      const forbidden = ["CORE_API_URL", "CORE_SIGNING_SECRET"].filter(
        (name) => entry.env?.[name] !== undefined || entry.secrets?.some((secret) => secret.name === name),
      );
      if (forbidden.length) {
        throw new CliError(`${path}: plugins[${i}] cannot declare ${forbidden.join(", ")} when coreAccess is false`);
      }
    }
    return entry;
  });
}

function validatePluginSecrets(raw: unknown, path: string, pluginIndex: number): PluginSecret[] {
  if (!Array.isArray(raw)) throw new CliError(`${path}: plugins[${pluginIndex}].secrets must be an array`);
  const seen = new Set<string>();
  return raw.map((value, i) => {
    const field = `plugins[${pluginIndex}].secrets[${i}]`;
    if (!isPlainObject(value)) throw new CliError(`${path}: ${field} must be an object`);
    const name = value["name"];
    if (typeof name !== "string" || !isEnvVarName(name))
      throw new CliError(`${path}: ${field}.name must be a valid env var name`);
    if (seen.has(name)) throw new CliError(`${path}: duplicate plugin secret ${JSON.stringify(name)}`);
    seen.add(name);
    const out: PluginSecret = { name };
    if (value["description"] !== undefined) {
      if (typeof value["description"] !== "string")
        throw new CliError(`${path}: ${field}.description must be a string`);
      out.description = value["description"];
    }
    if (value["required"] !== undefined) {
      if (typeof value["required"] !== "boolean") throw new CliError(`${path}: ${field}.required must be a boolean`);
      out.required = value["required"];
    }
    return out;
  });
}

export function validateSandbox(raw: unknown, path: string, target: Target): SandboxConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "sandbox" must be an object (e.g. { "backend": "sprites" })`);
  }
  const o = raw;
  const out: SandboxConfig = {};
  if (o["backend"] !== undefined) {
    if (!isSandboxBackendId(o["backend"])) {
      const choices = Object.entries(SANDBOX_BACKENDS).map(([id, label]) => (label ? `"${id}" (${label})` : `"${id}"`));
      throw new CliError(`${path}: "sandbox.backend" must be ${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`);
    }
    out.backend = o["backend"];
  }
  if (o["image"] !== undefined) {
    if (o["backend"] === "local") {
      if (typeof o["image"] !== "string" || !o["image"].trim()) {
        throw new CliError(`${path}: "sandbox.image" must be a non-empty runnable image ref for the local backend`);
      }
      out.image = o["image"];
    } else {
      warn(
        `${path}: "sandbox.image" is retired and ignored — sandboxes boot the platform's stock image; remove the key`,
      );
    }
  }
  if (o["baseImage"] !== undefined) {
    if (typeof o["baseImage"] !== "string" || !o["baseImage"].trim()) {
      throw new CliError(`${path}: "sandbox.baseImage" must be a non-empty digest-pinned image ref`);
    }
    if (!o["baseImage"].includes("@sha256:")) {
      throw new CliError(`${path}: "sandbox.baseImage" must be pinned by digest (@sha256:...)`);
    }
    out.baseImage = o["baseImage"];
  }
  if (out.backend !== undefined && !SANDBOX_BACKEND_POLICY[target].allowed.includes(out.backend)) {
    const targets = targetsAllowingSandboxBackend(out.backend)
      .map((allowed) => JSON.stringify(allowed))
      .join(" or ");
    throw new CliError(`${path}: "sandbox.backend": ${JSON.stringify(out.backend)} requires target ${targets}`);
  }
  if (out.backend === "local") {
    const stray = (["baseImage"] as const).filter((key) => out[key] !== undefined);
    if (stray.length) {
      throw new CliError(
        `${path}: "sandbox.backend": "local" ignores ${stray.map((key) => `"sandbox.${key}"`).join(", ")} — remove them; use "sandbox.image" for the runnable local sandbox image`,
      );
    }
  }
  if (out.backend === "e2b") {
    const stray = (["baseImage"] as const).filter((key) => out[key] !== undefined);
    if (stray.length) {
      throw new CliError(
        `${path}: "sandbox.backend": "${out.backend}" ignores ${stray.map((key) => `"sandbox.${key}"`).join(", ")} — remove them`,
      );
    }
  }
  if (SANDBOX_BACKEND_POLICY[target].requireExplicit && out.backend === undefined) {
    throw new CliError(
      `${path}: target ${JSON.stringify(target)} requires an explicit "sandbox.backend" — "sprites" runs Fly Sprites; "e2b" runs E2B sandboxes`,
    );
  }
  return out;
}

export function validateStringArray(raw: unknown, path: string, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    throw new CliError(`${path}: "${field}" must be an array of strings`);
  }
  return raw as string[];
}

export function validateStringMap(raw: unknown, path: string, field: string): Record<string, string> {
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "${field}" must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") throw new CliError(`${path}: "${field}.${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

export function rejectRetiredAdminService(o: Record<string, unknown>, path: string): void {
  const hasAdmin = (v: unknown): boolean => isPlainObject(v) && Object.hasOwn(v, "admin");
  const aws = o["aws"];
  const found = [
    ...(Array.isArray(o["services"]) && o["services"].includes("admin") ? ['"admin" from services'] : []),
    ...["env", "secretEnv", "imageOverrides"].filter((field) => hasAdmin(o[field])).map((field) => `${field}.admin`),
    ...(isPlainObject(aws) && hasAdmin(aws["services"]) ? ["aws.services.admin"] : []),
  ];
  if (found.length) {
    throw new CliError(
      `${path}: the admin service no longer exists; admin settings are part of web-ui at /settings. Remove ${found.join(", ")}`,
    );
  }
}

export function validateServiceMap<T>(
  raw: unknown,
  path: string,
  field: string,
  value: (v: unknown, key: string) => T,
): Partial<Record<DeclaredServiceName, T>> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new CliError(`${path}: "${field}" must be an object keyed by service name`);
  }
  const out: Partial<Record<DeclaredServiceName, T>> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isDeclaredService(k)) throw new CliError(`${path}: "${field}" has unknown service "${k}"`);
    out[k as DeclaredServiceName] = value(v, k);
  }
  return out;
}
