import { html, render } from "lit";
import { Archive, X } from "lucide";
import { icon } from "./icons";

let archiveToastHost: HTMLDivElement | null = null;

let archiveToastTimer: ReturnType<typeof setTimeout> | undefined;

export function closeArchiveToast(): void {
  clearTimeout(archiveToastTimer);
  archiveToastHost?.remove();
  archiveToastHost = null;
}

export function showArchiveToast(restore: () => Promise<boolean>): void {
  closeArchiveToast();
  const host = document.createElement("div");
  archiveToastHost = host;
  document.body.append(host);
  let busy = false;
  const schedule = (): void => {
    clearTimeout(archiveToastTimer);
    if (!busy && !host.matches(":hover") && !host.contains(document.activeElement)) {
      archiveToastTimer = setTimeout(() => {
        if (archiveToastHost === host) closeArchiveToast();
      }, 8000);
    }
  };
  const draw = (): void => {
    render(
      html`<div
        class="action-toast"
        role="status"
        @mouseenter=${() => clearTimeout(archiveToastTimer)}
        @mouseleave=${schedule}
        @focusin=${() => clearTimeout(archiveToastTimer)}
        @focusout=${() => queueMicrotask(schedule)}
      >
        ${icon(Archive, 16)}
        <span>Dismissed from inbox</span>
        <button
          type="button"
          ?disabled=${busy}
          @click=${async () => {
            busy = true;
            clearTimeout(archiveToastTimer);
            draw();
            const restored = await restore();
            if (archiveToastHost !== host) return;
            if (restored) closeArchiveToast();
            else {
              busy = false;
              draw();
              schedule();
            }
          }}
        >
          ${busy ? "Undoing…" : "Undo"}
        </button>
        <button class="icon-btn" type="button" aria-label="Dismiss notification" @click=${closeArchiveToast}>
          ${icon(X, 14)}
        </button>
      </div>`,
      host,
    );
  };
  draw();
  schedule();
}
