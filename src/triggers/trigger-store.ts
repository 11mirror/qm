import type { Destination, ScopeId, TriggerBase } from "../types.ts";
import { cols } from "../persistence/typed-table.ts";
import { samePerson } from "../directory/person.ts";
import { canonicalJson } from "../../cli/src/canonical-json.ts";

export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
}

export const TRIGGER_COLUMNS =
  cols(`ownerScopeId text!, owner text!, createdBy text!, ownerConsentedAt bigint, destination jsonb,
    enabled boolean!, createdAt bigint!, lastFiredAt bigint`);

export function contentPart(value: unknown): string {
  return canonicalJson(value);
}

export function assertNoEscalation(input: { owner: string; createdBy: string; ownerConsentedAt?: number }): void {
  if (!samePerson(input.owner, input.createdBy) && !input.ownerConsentedAt) {
    throw new Error("assigning a different owner requires that owner's consent");
  }
}

export function buildTriggerBase(input: CreateTriggerInput, id: string, createdAt: number): TriggerBase {
  return {
    id,
    ownerScopeId: input.ownerScopeId,
    owner: input.owner,
    createdBy: input.createdBy,
    enabled: true,
    createdAt,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.ownerConsentedAt ? { ownerConsentedAt: input.ownerConsentedAt } : {}),
  };
}
