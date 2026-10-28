import { isBearerSecret, isStrongSigningSecret } from "../auth/source-auth.ts";
import { SANDBOX_BACKEND_NAMES, type SandboxBackendName } from "../sandbox/sandbox-routing.ts";

type SecretGate =
  | SandboxBackendName
  | "production"
  | "background-work-control"
  | "fly-deploy"
  | "porter-deploy"
  | "e2b-deploy"
  | "aws-deploy-gate"
  | "google-oauth"
  | "dropbox-oauth"
  | "linear-oauth"
  | "email-auth"
  | "model-anthropic"
  | "model-openai"
  | "model-openrouter";

export interface RuntimeSecretSpec {
  name: string;
  requiredWhen: SecretGate | readonly SecretGate[];
  reason?: string;
}

export const CORE_SECRET_SPECS: readonly RuntimeSecretSpec[] = [
  { name: "CAPABILITY_SECRET", requiredWhen: "production" },
  { name: "CONNECTOR_SECRET_KEY", requiredWhen: "production" },
  { name: "CORE_SIGNING_SECRET", requiredWhen: "production" },
  { name: "DEPLOYMENT_CONTROL_SECRET", requiredWhen: "background-work-control" },
  { name: "PORTAL_IDENTITY_SECRET", requiredWhen: "production" },
  { name: "AUTH_ALLOWED_EMAILS", requiredWhen: "email-auth" },
  { name: "OPENAI_API_KEY", requiredWhen: ["model-openai"] },
  { name: "ANTHROPIC_API_KEY", requiredWhen: "model-anthropic" },
  { name: "OPENROUTER_API_KEY", requiredWhen: "model-openrouter" },
  {
    name: "DATABASE_URL",
    requiredWhen: "production",
    reason:
      "sessions, runs, approvals, audit, locks and leases must survive restarts and be shared across instances, or a blue-green rollout can destroy a scope's resident disk",
  },
  { name: "SPRITES_TOKEN", requiredWhen: "sprites" },
  { name: "SMOLMACHINES_TOKEN", requiredWhen: "smolmachines" },
  { name: "E2B_API_KEY", requiredWhen: ["e2b", "e2b-deploy"] },
  { name: "DO_AGENTS_API_TOKEN", requiredWhen: "do-managed-agents" },
  { name: "MODAL_TOKEN_ID", requiredWhen: "modal" },
  { name: "MODAL_TOKEN_SECRET", requiredWhen: "modal" },
  { name: "SUPERSERVE_API_KEY", requiredWhen: "superserve" },
  { name: "FLY_DEPLOY_API_TOKEN", requiredWhen: "fly-deploy" },
  { name: "PORTER_DEPLOY_API_TOKEN", requiredWhen: "porter-deploy" },
  { name: "AWS_DEPLOY_GATE_SECRET", requiredWhen: "aws-deploy-gate" },
  { name: "GOOGLE_OAUTH_CLIENT_SECRET", requiredWhen: "google-oauth" },
  { name: "DROPBOX_OAUTH_CLIENT_SECRET", requiredWhen: "dropbox-oauth" },
  { name: "LINEAR_OAUTH_CLIENT_SECRET", requiredWhen: "linear-oauth" },
];

const GATE_PREDICATES: Readonly<Record<SecretGate, (env: NodeJS.ProcessEnv) => boolean>> = {
  production: (env) => env.NODE_ENV === "production",
  "background-work-control": (env) => Boolean(env.BACKGROUND_DEPLOYMENT_ID?.trim()),
  ...(Object.fromEntries(
    SANDBOX_BACKEND_NAMES.map((backend) => [
      backend,
      (env: NodeJS.ProcessEnv) => env.SANDBOX_BACKEND?.trim() === backend,
    ]),
  ) as Record<SandboxBackendName, (env: NodeJS.ProcessEnv) => boolean>),
  "fly-deploy": (env) => env.DEPLOY_PROVIDER === "fly",
  "porter-deploy": (env) => env.DEPLOY_PROVIDER === "porter",
  "e2b-deploy": (env) => env.DEPLOY_PROVIDER === "e2b",
  "aws-deploy-gate": (env) => Boolean(env.DEPLOY_APPS_DOMAIN),
  "google-oauth": (env) => Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
  "dropbox-oauth": (env) => Boolean(env.DROPBOX_OAUTH_CLIENT_ID),
  "linear-oauth": (env) => Boolean(env.LINEAR_OAUTH_CLIENT_ID),
  "email-auth": (env) => env.AUTH_ALLOWED_EMAILS !== undefined,
  "model-anthropic": (env) => env.MODEL_PROVIDER?.trim() === "anthropic",
  "model-openai": (env) => env.MODEL_PROVIDER?.trim() === "openai" && !env.CODEX_AUTH_CREDENTIAL?.trim(),
  "model-openrouter": (env) => env.MODEL_PROVIDER?.trim() === "openrouter",
};

export function validateCoreSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const enabled = (spec: RuntimeSecretSpec): boolean => {
    const gates = typeof spec.requiredWhen === "string" ? [spec.requiredWhen] : spec.requiredWhen;
    return gates.some((gate) => GATE_PREDICATES[gate](env));
  };
  return CORE_SECRET_SPECS.filter((spec) => enabled(spec) && isInvalidSecret(spec.name, env[spec.name])).map(
    (spec) => spec.name,
  );
}

function isInvalidSecret(name: string, value: string | undefined): boolean {
  const candidate = value?.trim();
  if (!candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate)) return true;
  if (name === "DEPLOYMENT_CONTROL_SECRET" && !isBearerSecret(value)) return true;
  return (
    (name === "CONNECTOR_SECRET_KEY" ||
      name === "CORE_SIGNING_SECRET" ||
      name === "DEPLOYMENT_CONTROL_SECRET" ||
      name === "AWS_DEPLOY_GATE_SECRET") &&
    !isStrongSigningSecret(candidate)
  );
}
