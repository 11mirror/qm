import { defineHarness, type Harness } from "../../src/harness/harness.ts";
import { createMockModels } from "./mock-harness/models.ts";
import { createMockHarnessState } from "./mock-harness/shared.ts";
import { runMockTurn } from "./mock-harness/turn.ts";

export function createMockHarness(): Harness {
  const state = createMockHarnessState();
  return defineHarness({ runTurn: (input) => runMockTurn(input, state), ...createMockModels(state.flakyScreens) });
}
