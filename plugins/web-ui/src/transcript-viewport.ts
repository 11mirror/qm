export function preserveTranscriptScroll(root: HTMLElement): () => void {
  const snapshots = [...root.querySelectorAll<HTMLElement>(".chat-scroll")]
    .filter((element) => element.clientHeight > 0)
    .map((element) => {
      const top = element.getBoundingClientRect().top;
      const anchor = [
        ...element.querySelectorAll<HTMLElement>(".message-stack :is(p, h1, h2, h3, h4, h5, h6, pre, li, table)"),
      ].find((node) => !node.closest(".user-row") && node.getBoundingClientRect().bottom > top);
      return {
        element,
        scrollTop: element.scrollTop,
        bottom: element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
        anchor,
        offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
      };
    });
  return () => {
    for (const snapshot of snapshots) {
      const { element, anchor } = snapshot;
      if (!root.contains(element) || element.clientHeight === 0) continue;
      if (snapshot.bottom) element.scrollTop = element.scrollHeight;
      else if (anchor && element.contains(anchor))
        element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - snapshot.offset;
      else element.scrollTop = snapshot.scrollTop;
    }
  };
}

const CONDENSED_LINES = 2;
const NEAR_TOP = 400;

class TranscriptViewport {
  private readonly options: { pinPrompt?: () => boolean };
  private scroller: HTMLElement | null = null;
  private pins: HTMLElement | null = null;
  private prompt: HTMLElement | null = null;
  private stack: HTMLElement | null = null;
  private content: HTMLElement | null = null;
  private promptKey: string | undefined;
  private expanded = false;
  private lastTop = 0;
  private observer: ResizeObserver | null = null;
  private following = false;
  private frame: number | null = null;
  private remeasure = true;
  private restContent = 0;
  private condensedContent = 0;
  private contentHeight = 0;
  private condensedHeight = 0;
  private gap: number | null = null;
  private contentMax = "";
  private collapseDistance = 0;
  private geometryDistance: number | null = null;
  private filledAtSize: number | null = null;
  private readonly contentUpdates = new Set<Promise<void>>();

  constructor(options: { pinPrompt?: () => boolean }) {
    this.options = options;
  }

  private setFollowing(value: boolean): void {
    this.following = value;
    if (this.scroller) this.scroller.style.overflowAnchor = value ? "none" : "";
  }

  cancelFollow(): void {
    this.setFollowing(false);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private clearPrompt(): void {
    if (this.content) this.content.scrollTop = 0;
    this.prompt?.classList.remove("stuck", "sticky-disabled", "pin-expanded", "pin-condensed", "latest-prompt");
    this.prompt?.style.removeProperty("--pin-expanded-max");
    this.prompt?.style.removeProperty("--pin-rest-height");
    this.prompt?.style.removeProperty("--pin-content-max");
    this.restContent = this.condensedContent = this.contentHeight = this.condensedHeight = 0;
    this.gap = null;
    this.contentMax = "";
    this.collapseDistance = 0;
    this.geometryDistance = null;
    this.remeasure = true;
    const toggle = this.prompt?.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) toggle.hidden = true;
    this.expanded = false;
    this.promptKey = undefined;
  }

  private syncPrompt(): void {
    if (!this.scroller || !this.prompt || !this.content) return;
    this.prompt.classList.toggle("pin-expanded", this.expanded);
    const clipped = !this.expanded && this.content.scrollHeight > this.content.clientHeight + 1;
    const toggle = this.prompt.querySelector<HTMLButtonElement>(".pin-toggle");
    if (toggle) {
      toggle.hidden = !clipped && !this.expanded;
      const label = this.expanded ? "Show less" : "Show more";
      const text = toggle.querySelector<HTMLElement>(".pin-toggle-label") ?? toggle;
      if (text.textContent !== label) text.textContent = label;
      toggle.setAttribute("aria-expanded", String(this.expanded));
    }
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.nodeType !== 1) return;
    const toggle = target.closest<HTMLButtonElement>(".pin-toggle");
    if (!toggle || !this.prompt?.contains(toggle)) return;
    this.cancelFollow();
    this.expanded = !this.expanded;
    if (!this.expanded && this.content) this.content.scrollTop = 0;
    this.syncSticky();
  };

  private syncSticky(): void {
    if (!this.scroller) return;
    this.syncPrompt();
    const top = this.pins?.getBoundingClientRect().height ?? 0;
    this.scroller.style.setProperty("--chat-sticky-top", `${top}px`);
    const style = getComputedStyle(this.scroller);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingBottom = parseFloat(style.paddingBottom) || 0;
    const promptStyle = this.prompt ? getComputedStyle(this.prompt) : null;
    const promptMargin = promptStyle ? parseFloat(promptStyle.marginBottom) || 0 : 0;
    if (this.prompt && this.content && promptStyle && this.remeasure && !this.expanded) this.measureRest(promptStyle);
    if (this.prompt && this.content) {
      const chrome = this.prompt.getBoundingClientRect().height - this.content.getBoundingClientRect().height;
      const available = this.scroller.clientHeight - top - paddingTop - paddingBottom - promptMargin - chrome;
      this.prompt.style.setProperty("--pin-expanded-max", `${Math.max(0, Math.floor(available))}px`);
    }
    const canStick =
      !!this.prompt &&
      this.prompt.getBoundingClientRect().height + promptMargin + top + paddingTop + paddingBottom <=
        this.scroller.clientHeight;
    this.prompt?.classList.toggle("sticky-disabled", !canStick);
    const line = this.scroller.getBoundingClientRect().top + this.scroller.clientTop + paddingTop + top;
    const stuck =
      !!this.prompt && canStick && this.scroller.scrollTop > 0 && this.prompt.getBoundingClientRect().top <= line + 0.5;
    this.prompt?.classList.toggle("stuck", stuck);
    if (!this.prompt || !this.content || !promptStyle) return;
    const edge = this.anchorEdge();
    if (!stuck) this.gap = this.prompt.getBoundingClientRect().top - edge;
    this.condense(stuck && !this.expanded, line - edge - (this.gap ?? this.restingGap(promptStyle)));
    this.syncPrompt();
  }

  private precedingBlock(): Element | null {
    let node: Element | null = this.prompt;
    while (node && node !== this.stack) {
      let previous = node.previousElementSibling;
      while (previous && getComputedStyle(previous).display === "contents")
        previous = previous.lastElementChild ?? previous.previousElementSibling;
      if (previous) return previous;
      node = node.parentElement;
    }
    return null;
  }

  private anchorEdge(): number {
    const previous = this.precedingBlock();
    if (previous) return previous.getBoundingClientRect().bottom;
    return this.stack?.getBoundingClientRect().top ?? 0;
  }

  private restingGap(promptStyle: CSSStyleDeclaration): number {
    const previous = this.precedingBlock();
    let before = 0;
    if (previous) before = parseFloat(getComputedStyle(previous).marginBottom) || 0;
    else if (this.stack) before = parseFloat(getComputedStyle(this.stack).paddingTop) || 0;
    return before + (parseFloat(promptStyle.marginTop) || 0);
  }

  private measureRest(promptStyle: CSSStyleDeclaration): void {
    if (!this.prompt || !this.content) return;
    this.remeasure = false;
    this.prompt.classList.remove("pin-condensed");
    this.prompt.style.removeProperty("--pin-content-max");
    this.prompt.style.setProperty("--pin-rest-height", "0px");
    this.contentMax = "";
    this.restContent = this.content.getBoundingClientRect().height;
    this.contentHeight = this.content.scrollHeight;
    const inner =
      this.prompt.getBoundingClientRect().height -
      (promptStyle.boxSizing === "border-box"
        ? 0
        : (parseFloat(promptStyle.paddingTop) || 0) + (parseFloat(promptStyle.paddingBottom) || 0));
    this.prompt.style.setProperty("--pin-rest-height", `${Math.max(0, inner)}px`);
    const contentStyle = getComputedStyle(this.content);
    const lineHeight = parseFloat(contentStyle.lineHeight) || (parseFloat(contentStyle.fontSize) || 0) * 1.5;
    this.condensedContent = CONDENSED_LINES * lineHeight;
  }

  private contentChanged(): boolean {
    if (!this.content) return false;
    return (
      this.content.scrollHeight !==
      (this.prompt?.classList.contains("pin-condensed") ? this.condensedHeight : this.contentHeight)
    );
  }

  private condense(active: boolean, distance: number): void {
    if (!this.prompt || !this.content) return;
    if (!active) {
      this.collapseDistance = 0;
      this.geometryDistance = null;
    } else {
      if (this.geometryDistance === null) this.collapseDistance = Math.max(0, distance);
      else if (this.following) this.collapseDistance = Math.max(this.collapseDistance, distance);
      else this.collapseDistance = Math.max(0, this.collapseDistance + distance - this.geometryDistance);
      this.geometryDistance = distance;
    }
    distance = this.collapseDistance;
    const span = this.restContent - this.condensedContent;
    const settled = span <= 0.5 || span - distance < 0.5;
    if (active && settled && !this.prompt.classList.contains("pin-condensed")) {
      this.prompt.classList.add("pin-condensed");
      this.condensedHeight = this.content.scrollHeight;
    } else if (!(active && settled)) this.prompt.classList.remove("pin-condensed");
    let max = "";
    if (active) max = `${settled ? this.condensedContent : this.restContent - Math.max(0, distance)}px`;
    if (max === this.contentMax) return;
    this.contentMax = max;
    if (max) this.prompt.style.setProperty("--pin-content-max", max);
    else this.prompt.style.removeProperty("--pin-content-max");
  }

  private readonly onScroll = (): void => {
    if (!this.scroller || this.contentUpdates.size > 0) return;
    const movingUp = this.scroller.scrollTop < this.lastTop;
    const atBottom = this.scroller.scrollHeight - this.scroller.clientHeight - this.scroller.scrollTop <= 1;
    const resumeFollowing = atBottom && (this.following || !movingUp);
    if (!resumeFollowing && movingUp) this.cancelFollow();
    this.lastTop = this.scroller.scrollTop;
    this.syncSticky();
    if (resumeFollowing) this.setFollowing(true);
    if (movingUp) this.loadEarlier();
  };

  private earlierButton(): HTMLButtonElement | null {
    return this.scroller?.querySelector<HTMLButtonElement>(".earlier-messages-btn:not(:disabled)") ?? null;
  }

  private loadEarlier(): void {
    if (!this.scroller || this.scroller.scrollTop > NEAR_TOP) return;
    const button = this.earlierButton();
    if (!button) return;
    this.cancelFollow();
    button.click();
  }

  private fillViewport(): void {
    const button = this.earlierButton();
    if (!button || !this.scroller || this.scroller.clientHeight === 0) return;
    if (this.scroller.scrollHeight - this.scroller.clientHeight > NEAR_TOP) return;
    const size = (this.stack ?? this.scroller).getElementsByTagName("*").length;
    if (size === this.filledAtSize) return;
    this.filledAtSize = size;
    button.click();
  }

  beforeRender(): void {
    if (!this.scroller || this.contentUpdates.size > 0) return;
    if (this.scroller.scrollTop !== this.lastTop) this.onScroll();
  }

  private readonly onContentUpdating = (event: Event): void => {
    this.beforeRender();
    const completion = (event as CustomEvent<Promise<void>>).detail;
    this.contentUpdates.add(completion);
    const complete = (): void => {
      if (this.contentUpdates.delete(completion) && this.contentUpdates.size === 0) this.afterRender();
    };
    void completion.then(complete, complete);
  };

  afterRender(): void {
    if (!this.scroller || !this.following || this.contentUpdates.size > 0) return;
    this.lastTop = this.scroller.scrollTop;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.follow();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.scroller) return;
    if (event.deltaY < 0) this.loadEarlier();
    if (event.deltaY < 0 && this.scroller.scrollTop > 0) this.cancelFollow();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target !== this.scroller || event.key !== "End" || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.follow(true);
  };

  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer?.disconnect();
    this.observer = null;
    this.scroller?.removeEventListener("qm-content-updating", this.onContentUpdating);
    this.scroller?.removeEventListener("scroll", this.onScroll);
    this.scroller?.removeEventListener("wheel", this.onWheel);
    this.scroller?.removeEventListener("click", this.onClick);
    this.scroller?.removeEventListener("keydown", this.onKeyDown);
    this.scroller?.style.removeProperty("--chat-sticky-top");
    this.scroller?.style.removeProperty("overflow-anchor");
    this.clearPrompt();
    this.scroller = this.pins = this.prompt = this.stack = this.content = null;
    this.lastTop = 0;
    this.following = false;
    this.filledAtSize = null;
    this.contentUpdates.clear();
  }

  private observe(previous: HTMLElement | null, next: HTMLElement | null): HTMLElement | null {
    if (previous) this.observer?.unobserve(previous);
    if (next) this.observer?.observe(next);
    return next;
  }

  sync(element: HTMLElement | null): void {
    let changed = false;
    if (this.scroller !== element) {
      changed = true;
      this.dispose();
      this.scroller = element;
      this.lastTop = this.scroller?.scrollTop ?? 0;
      this.setFollowing(false);
      this.scroller?.addEventListener("qm-content-updating", this.onContentUpdating);
      this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
      this.scroller?.addEventListener("wheel", this.onWheel, { passive: true });
      this.scroller?.addEventListener("click", this.onClick);
      this.scroller?.addEventListener("keydown", this.onKeyDown);
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver((entries = []) => {
          if (entries.some((entry) => entry.target === this.scroller) || this.contentChanged()) this.remeasure = true;
          this.beforeRender();
          this.syncSticky();
          this.follow();
          this.fillViewport();
        });
        if (this.scroller) this.observer.observe(this.scroller);
      }
    }
    const nextStack = this.scroller?.querySelector<HTMLElement>(".message-stack") ?? null;
    if (this.stack !== nextStack) {
      changed = true;
      this.filledAtSize = null;
      this.stack = this.observe(this.stack, nextStack);
    }
    const nextPins = this.scroller?.querySelector<HTMLElement>(".pinned-strip") ?? null;
    const prompts = this.stack?.querySelectorAll<HTMLElement>(":scope > .user-row, .inline-steer > .user-row");
    const pinPrompt = this.options.pinPrompt?.() ?? true;
    const nextPrompt = pinPrompt ? (prompts?.item(prompts.length - 1) ?? null) : null;
    if (this.pins !== nextPins) {
      changed = true;
      this.pins = this.observe(this.pins, nextPins);
    }
    if (this.prompt !== nextPrompt || this.promptKey !== nextPrompt?.dataset.index) {
      changed = true;
      this.clearPrompt();
      this.prompt = this.observe(this.prompt, nextPrompt);
      this.promptKey = this.prompt?.dataset.index;
    }
    this.prompt?.classList.add("latest-prompt");
    const nextContent = this.prompt?.querySelector<HTMLElement>(".pin-content") ?? null;
    if (this.content !== nextContent) {
      changed = true;
      this.remeasure = true;
      this.content = this.observe(this.content, nextContent);
    }
    if (changed) this.syncSticky();
    this.fillViewport();
  }

  follow(force = false): void {
    if (force) {
      this.setFollowing(true);
      this.lastTop = this.scroller?.scrollTop ?? 0;
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (!this.scroller || !this.following || this.contentUpdates.size > 0 || this.frame !== null) return;
    const element = this.scroller;
    const priorTop = element.scrollTop;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (element !== this.scroller || !element.isConnected || !this.following || this.contentUpdates.size > 0) return;
      if (element.scrollTop < priorTop && element.scrollHeight - element.clientHeight - element.scrollTop > 1)
        return this.cancelFollow();
      element.scrollTop = element.scrollHeight;
      this.lastTop = this.scroller?.scrollTop ?? 0;
      this.syncSticky();
    });
  }

  refresh(): void {
    if (this.scroller) this.sync(this.scroller);
  }
}

export function createTranscriptViewport(options: { pinPrompt?: () => boolean } = {}) {
  return new TranscriptViewport(options);
}
