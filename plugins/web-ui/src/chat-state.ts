import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { CoreSession, SessionPin, TurnRuntime, WorkBlock } from "./core-bridge";
import type { GoalStripState } from "./goal-strip";

export function createChatState() {
  return {
    agent: null as Agent | null,
    host: null as HTMLElement | null,
    threadRef: null as string | null,
    sessionId: null as string | null,
    scopeId: null as string | null,
    contextName: null as string | null,
    rememberedThreadRef: null as string | null,
    rememberedSessionId: null as string | null,
    liveWork: null as WorkBlock | null,
    goal: null as GoalStripState | null,
    turnRuntime: null as TurnRuntime | null,
    pendingSend: null as string | null,
    normalStreamFn: null as Agent["streamFn"] | null,
    onWork: null as ((work: WorkBlock) => void) | null,
    resolvingApprovals: new Set<string>(),
    transcriptAnchorSeq: null as number | null,
    earlierCount: 0,
    loadingEarlier: false,
    forkSession: null as CoreSession | null,
    inheritedMessages: [] as AgentMessage[],
    inheritedExpanded: false,
    inheritedLoaded: false,
    pins: [] as SessionPin[],
    pinsExpanded: false,
    labelSpeakers: false,
    assistantSpeakerLabel: "",
  };
}

export type ChatState = ReturnType<typeof createChatState>;
