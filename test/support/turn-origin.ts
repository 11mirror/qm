import type { TurnOrigin, TurnRequest } from "../../src/types.ts";

export function automationOrigin(
  request: Pick<TurnRequest, "origin"> | undefined,
): Extract<TurnOrigin, { kind: "automation" }> | undefined {
  return request?.origin.kind === "automation" ? request.origin : undefined;
}
