import type { Lease, SessionStore } from "../../sessions/session-store.ts";
import { swallowAs } from "../../util/errors.ts";

export function startLeaseKeepalive(
  sessions: Pick<SessionStore, "renewLease">,
  lease: Lease,
  intervalMs: number,
  releaseExpected: () => boolean,
  onLeaseLost?: () => void,
): () => void {
  const timer = setInterval(() => {
    void sessions
      .renewLease(lease)
      .then((renewed) => {
        if (renewed) return;
        clearInterval(timer);
        if (releaseExpected()) return;
        console.error(`[orchestrator] lease keepalive stopped: lease lost mid-turn session=${lease.sessionId}`);
        onLeaseLost?.();
      })
      .catch(swallowAs("orchestrator: lease keepalive", undefined));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
