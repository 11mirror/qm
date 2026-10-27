export const HOSTING_PROVIDER_IDS = ["docker", "aws"] as const;

export type Target = (typeof HOSTING_PROVIDER_IDS)[number];

export const isTarget = (value: unknown): value is Target =>
  typeof value === "string" && (HOSTING_PROVIDER_IDS as readonly string[]).includes(value);

export const SANDBOX_BACKENDS = {
  local: "Docker containers on the deployment host",
  sprites: "Fly Sprites",
  e2b: "E2B sandboxes",
  modal: "Modal sandboxes",
  "do-managed-agents": "DigitalOcean Managed Agents sandboxes",
  smolmachines: "smolmachines microVMs",
} as const;

export type SandboxBackendId = keyof typeof SANDBOX_BACKENDS;

export const isSandboxBackendId = (value: unknown): value is SandboxBackendId =>
  typeof value === "string" && Object.hasOwn(SANDBOX_BACKENDS, value);

export interface SandboxBackendPolicy {
  allowed: readonly SandboxBackendId[];
  requireExplicit: boolean;
}

export const SANDBOX_BACKEND_POLICY: Record<Target, SandboxBackendPolicy> = {
  docker: {
    allowed: ["local", "sprites", "e2b", "modal", "do-managed-agents", "smolmachines"],
    requireExplicit: false,
  },
  aws: { allowed: ["sprites", "e2b", "modal", "do-managed-agents", "smolmachines"], requireExplicit: true },
};

export const targetsAllowingSandboxBackend = (backend: SandboxBackendId): Target[] =>
  HOSTING_PROVIDER_IDS.filter((target) => SANDBOX_BACKEND_POLICY[target].allowed.includes(backend));

export const hostingProviderChoices = (): string =>
  new Intl.ListFormat("en", { type: "disjunction" }).format(HOSTING_PROVIDER_IDS);
