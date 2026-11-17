import type { ApprovalDecision, PendingApproval } from "./core-bridge.ts";

export interface FinnyPlanDetail {
  plan?: {
    title: string;
    summary?: string;
    phases: Array<{ name: string; owner: string; dependencies: string[] }>;
    certification: string;
    deliverable: string;
    destination: string;
    clarifications?: Array<{ question: string; answer: string }>;
  };
  materialClarification?: {
    question: string;
    options: Array<{ id: string; label: string; description?: string }>;
    recommendedOptionId: string;
  };
}

export interface FinnyClarificationChoice {
  label: string;
  recommended: boolean;
  decision: ApprovalDecision;
}

export function parseFinnyPlanDetail(detail?: string): FinnyPlanDetail | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && parsed.plan && Array.isArray(parsed.plan.phases)) return parsed;
  } catch {
    return null;
  }
  return null;
}

export function finnyClarificationChoices(approval: PendingApproval): FinnyClarificationChoice[] {
  if (approval.reason !== "Finny Governance Clarification") return [];
  const clarification = parseFinnyPlanDetail(approval.summaryDetail)?.materialClarification;
  if (!clarification) return [];
  return [
    ...clarification.options.map((option) => ({
      label: option.label,
      recommended: option.id === clarification.recommendedOptionId,
      decision: { requestId: approval.requestId, approved: true, optionId: option.id },
    })),
    { label: "Other", recommended: false, decision: { requestId: approval.requestId, approved: false } },
  ];
}
