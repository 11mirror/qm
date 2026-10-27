import { JSDOM } from "jsdom";
import { createTranscriptViewport } from "../../src/transcript-viewport.ts";

export function fixture(options: Parameters<typeof createTranscriptViewport>[0] = {}) {
  const dom = new JSDOM(
    '<section><div class="pinned-strip"></div><div class="message-stack"><article class="user-row"></article></div></section>',
  );
  const s = dom.window.document.querySelector("section")!;
  const pins = s.querySelector<HTMLElement>(".pinned-strip")!;
  const prompt = s.querySelector<HTMLElement>(".user-row")!;
  let height = 1000;
  let pinsHeight = 30;
  let promptTop = 50;
  Object.defineProperties(s, { scrollHeight: { get: () => height }, clientHeight: { value: 200 } });
  s.scrollTop = 800;
  s.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  pins.getBoundingClientRect = () => ({ height: pinsHeight }) as DOMRect;
  prompt.getBoundingClientRect = () => ({ top: promptTop, height: 50 }) as DOMRect;
  const writes: number[] = [];
  let top = s.scrollTop;
  Object.defineProperty(s, "scrollTop", {
    get: () => top,
    set: (value: number) => {
      writes.push(value);
      top = Math.min(value, height - 200);
    },
  });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let resize = () => {};
  const restore = ["requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "getComputedStyle"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  Object.assign(globalThis, {
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      frames.set(++id, cb);
      return id;
    },
    cancelAnimationFrame: (n: number) => frames.delete(n),
    ResizeObserver: class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const viewport = createTranscriptViewport(options);
  viewport.sync(s);
  viewport.follow(true);
  for (const cb of frames.values()) cb(0);
  frames.clear();
  writes.length = 0;
  return {
    s,
    prompt,
    viewport,
    writes,
    resize: (pinHeight: number, top: number) => {
      pinsHeight = pinHeight;
      promptTop = top;
      resize();
    },
    fit: () => {
      height = 200;
      s.scrollTop = 0;
      s.dispatchEvent(new dom.window.Event("scroll"));
      writes.length = 0;
    },
    collapse: () => {
      height = 400;
      s.scrollTop = Math.min(s.scrollTop, 200);
    },
    grow: () => {
      height += 100;
    },
    scroll: (top: number) => {
      s.scrollTop = top;
      s.dispatchEvent(new dom.window.Event("scroll"));
    },
    wheelUp: () => s.dispatchEvent(new dom.window.WheelEvent("wheel", { deltaY: -1 })),
    flush: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(0);
    },
    close: () => {
      viewport.dispose();
      dom.window.close();
      for (const [key, descriptor] of restore) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
