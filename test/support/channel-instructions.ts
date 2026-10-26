import { scopeId } from "../../src/types.ts";
import type { BotPolicy, ChannelPolicyStore } from "../../src/surface-cache/channel-policy-store.ts";
import type { ScopedConfigStore } from "../../src/resolution/config-store.ts";
import type { SurfaceCache } from "../../src/surface-cache/types.ts";

/**
 * Set a channel's instructions and its ambient settings — what a person does through the
 * instructions tool or the channel settings panel.
 */
export async function setChannelInstructions(
  built: { config: ScopedConfigStore; channelPolicy: ChannelPolicyStore; surfaceCache?: SurfaceCache },
  container: string,
  instructions: string,
  setBy?: string,
  bots?: Record<string, BotPolicy>,
  sessionId?: string,
  ambientEnabled?: boolean | null,
): Promise<void> {
  const kind = (await built.surfaceCache?.containerState(container).catch(() => null))?.kind;
  if (instructions)
    await built.config.setInstructions(scopeId(kind === "group" ? "group" : "channel", container), instructions, setBy);
  await built.channelPolicy.set(container, {
    ...(setBy ? { setBy } : {}),
    ...(bots ? { bots } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(ambientEnabled !== undefined ? { ambientEnabled } : {}),
  });
}
