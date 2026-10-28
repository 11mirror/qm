import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { workPausedForApproval, type WorkBlock } from "./core-bridge.ts";
import { currentTextPhase } from "./timeline.ts";
import { workDuration, workSeconds } from "./work-duration.ts";

class LiveWorkDuration extends AsyncDirective {
  private frame: number | undefined;
  private paintedAt = 0;
  private work!: WorkBlock;
  private seconds = 0;
  private sampledAt = 0;
  private ticking = false;

  render(work: WorkBlock) {
    this.work = work;
    this.seconds = workSeconds(work);
    this.sampledAt = Date.now();
    this.ticking =
      this.isConnected &&
      (work.status === "working" || work.status === "thinking") &&
      !work.stale &&
      !workPausedForApproval(work) &&
      currentTextPhase(work)?.phase !== "final_answer";
    if (this.ticking && this.frame === undefined) this.frame = requestAnimationFrame(this.tick);
    else if (!this.ticking) this.disconnected();
    return this.label();
  }

  private readonly tick = () => {
    if (Date.now() - this.paintedAt >= 50) {
      this.paintedAt = Date.now();
      this.setValue(this.label());
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private label() {
    return workDuration(this.seconds + (this.ticking ? (Date.now() - this.sampledAt) / 1000 : 0));
  }

  protected disconnected() {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  protected reconnected() {
    this.setValue(this.render(this.work));
  }
}

export const liveWorkDuration = directive(LiveWorkDuration);
