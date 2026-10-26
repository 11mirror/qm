import { html, nothing, render, type TemplateResult } from "lit";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapDialogFocus(event: KeyboardEvent, close: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget as HTMLElement;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && dialog.ownerDocument.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && dialog.ownerDocument.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreDialogFocus(opener: HTMLElement | null, fallback: () => HTMLElement | null | undefined): void {
  (opener?.isConnected ? opener : fallback())?.focus();
}

export function focusDialogCancel(root: ParentNode): void {
  root.querySelector<HTMLElement>("[data-dialog-cancel]")?.focus();
}

export interface ConfirmOpts {
  id: string;
  title: TemplateResult;
  body?: TemplateResult | string;
  confirm: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function confirmDialogTpl(o: ConfirmOpts): TemplateResult {
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && o.onCancel()}
  >
    <div
      class="project-dialog ${o.id}-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby=${`${o.id}-title`}
      aria-describedby=${o.body ? `${o.id}-impact` : nothing}
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, o.onCancel)}
    >
      <div class="project-dialog-head">
        <div><h2 id=${`${o.id}-title`}>${o.title}</h2></div>
      </div>
      ${o.body ? html`<p id=${`${o.id}-impact`}>${o.body}</p>` : nothing}
      <div class="project-dialog-actions actions">
        <button class="btn" type="button" data-dialog-cancel ?disabled=${Boolean(o.busy)} @click=${o.onCancel}>
          Cancel
        </button>
        <button class="btn danger ${o.id}-confirm" type="button" ?disabled=${Boolean(o.busy)} @click=${o.onConfirm}>
          ${o.confirm}
        </button>
      </div>
    </div>
  </div>`;
}

export function askConfirm(o: Pick<ConfirmOpts, "id" | "body" | "confirm"> & { title: string }): Promise<boolean> {
  const opener = document.activeElement as HTMLElement | null;
  const host = document.createElement("div");
  document.body.append(host);
  return new Promise((resolve) => {
    const settle = (confirmed: boolean) => {
      render(nothing, host);
      host.remove();
      if (opener?.isConnected) opener.focus();
      resolve(confirmed);
    };
    render(
      confirmDialogTpl({
        ...o,
        title: html`${o.title}`,
        onCancel: () => settle(false),
        onConfirm: () => settle(true),
      }),
      host,
    );
    focusDialogCancel(host);
  });
}
