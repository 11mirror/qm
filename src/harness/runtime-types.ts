import type { RuntimeChoice } from "./harness.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";

export type RuntimeConstraint = Pick<RuntimeChoice, "harnessId" | "modelId">;

export function runtimeConstraintError(
  constraint: RuntimeConstraint,
  choice: Partial<RuntimeChoice>,
): "runtime_constraint_mismatch" | null {
  if (
    (choice.harnessId !== undefined && choice.harnessId !== constraint.harnessId) ||
    (choice.modelId !== undefined && choice.modelId !== constraint.modelId)
  )
    return "runtime_constraint_mismatch";
  return null;
}

export interface RuntimeRequest {
  action: "get" | "set" | "inherit";
  model?: string;
  harness?: string;
  effort?: string;
  fastMode?: boolean;
  lifetime?: "task" | "scope";
}

interface RuntimeHandoff {
  choice: RuntimeChoice;
  lifetime: "task" | "scope";
}

export type HarnessHandoff = RuntimeHandoff | { context: "recent" };

export type RuntimeResult =
  | { ok: false; error: string; message?: string; candidates?: string[] }
  | { ok: true; handoff?: RuntimeHandoff; [key: string]: unknown };

export type RuntimeControl = (
  active: RuntimeChoice,
  request: RuntimeRequest,
  signal?: AbortSignal,
) => Promise<RuntimeResult>;
export type RuntimeService = (
  claims: CapabilityClaims,
  active: RuntimeChoice,
  request: RuntimeRequest,
  authorizeChoice?: (choice: RuntimeChoice) => Promise<string | null>,
  individualAuth?: boolean,
  signal?: AbortSignal,
  cronFire?: boolean,
  purpose?: import("../resolution/config-store.ts").RuntimePurpose,
  defaults?: Partial<RuntimeChoice>,
) => Promise<RuntimeResult>;
