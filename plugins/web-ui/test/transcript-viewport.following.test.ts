import { createTranscriptViewport } from "../src/transcript-viewport.ts";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./support/transcript-viewport-fixture.ts";

test("returning to the bottom before a streamed render resumes follow before its scroll event", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.scrollTop = 800;
    f.viewport.beforeRender();
    f.grow();
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a pre-render check leaves readers above the bottom alone", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.s.scrollTop = 798;
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 798);
  } finally {
    f.close();
  }
});

test("a pre-render check respects an upward wheel whose scroll has not arrived", () => {
  const f = fixture();
  try {
    f.wheelUp();
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("a pre-render check handles an upward scroll before its event", () => {
  const f = fixture();
  try {
    f.s.scrollTop = 790;
    f.viewport.beforeRender();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 790);
  } finally {
    f.close();
  }
});

test("a downward scroll that reaches only the previous bottom does not resume following", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("a downward wheel gesture that lands short of the bottom is left alone", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.WheelEvent("wheel", { deltaY: 300 }));
    f.grow();
    f.resize(30, 50);
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("passing the previous bottom without reaching the new bottom does not resume follow", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.scroll(850);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 850);
  } finally {
    f.close();
  }
});

test("asynchronous growth leaves a reader in place", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 600);
    f.scroll(800);
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 800);
  } finally {
    f.close();
  }
});

test("reaching the real bottom by hand resumes following", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.grow();
    f.scroll(900);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("closing live work preserves following through delayed final markdown layout", () => {
  const f = fixture();
  try {
    f.viewport.beforeRender();
    f.viewport.follow();
    f.collapse();
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 300);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 400);
  } finally {
    f.close();
  }
});

test("a reader who left the bottom is not pulled back when work closes", () => {
  const f = fixture();
  try {
    f.scroll(100);
    f.viewport.beforeRender();
    f.collapse();
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 100);
  } finally {
    f.close();
  }
});

test("a shrink that clamps a reader to the bottom does not resume following", () => {
  const f = fixture();
  try {
    f.scroll(700);
    f.viewport.beforeRender();
    f.collapse();
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 200);
  } finally {
    f.close();
  }
});

test("a bottom-pinned reader keeps following when the browser clamps a shrink", () => {
  const f = fixture();
  try {
    f.viewport.beforeRender();
    f.collapse();
    f.s.dispatchEvent(new f.s.ownerDocument.defaultView!.Event("scroll"));
    f.viewport.afterRender();
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 300);
  } finally {
    f.close();
  }
});

test("upward input after work closes still cancels the queued follow", () => {
  const f = fixture();
  try {
    f.viewport.beforeRender();
    f.collapse();
    f.viewport.afterRender();
    f.wheelUp();
    f.scroll(190);
    f.grow();
    f.resize(30, 50);
    f.flush();
    assert.equal(f.s.scrollTop, 190);
  } finally {
    f.close();
  }
});

test("an explicit new send re-arms following after reading older messages", () => {
  const f = fixture();
  try {
    f.scroll(100);
    f.viewport.follow(true);
    f.grow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    f.scroll(500);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 500);
  } finally {
    f.close();
  }
});

for (const reading of [false, true]) {
  test(`asynchronous Markdown replacement preserves ${reading ? "reader position" : "following"}`, async () => {
    const f = fixture();
    try {
      if (reading) f.scroll(100);
      f.viewport.beforeRender();
      f.viewport.afterRender();
      const completion = Promise.withResolvers<void>();
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
      f.collapse();
      completion.resolve();
      await completion.promise;
      f.grow();
      f.resize(30, 50);
      f.flush();
      assert.equal(f.s.scrollTop, reading ? 100 : 300);
    } finally {
      f.close();
    }
  });
}

test("an in-flight Markdown layout cannot be mistaken for reader scrolling", async () => {
  const f = fixture();
  try {
    const completion = Promise.withResolvers<void>();
    f.prompt.dispatchEvent(
      new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
        bubbles: true,
        detail: completion.promise,
      }),
    );
    f.s.scrollTop = 787;
    f.viewport.beforeRender();
    f.grow();
    completion.resolve();
    await completion.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("following waits for every overlapping render, including rejected updates", async () => {
  const f = fixture();
  try {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    for (const completion of [first, second]) {
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
    }
    f.grow();
    first.reject(new Error("render failed"));
    await first.promise.catch(() => {});
    f.flush();
    assert.equal(f.s.scrollTop, 800);
    second.resolve();
    await second.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("a disposed render cannot release a new render on the same scroller", async () => {
  const f = fixture();
  try {
    const start = () => {
      const completion = Promise.withResolvers<void>();
      f.prompt.dispatchEvent(
        new f.s.ownerDocument.defaultView!.CustomEvent("qm-content-updating", {
          bubbles: true,
          detail: completion.promise,
        }),
      );
      return completion;
    };
    const old = start();
    f.viewport.dispose();
    f.viewport.sync(f.s);
    f.viewport.follow(true);
    f.flush();
    const current = start();
    f.grow();
    old.resolve();
    await old.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 800);
    current.resolve();
    await current.promise;
    f.flush();
    assert.equal(f.s.scrollTop, 900);
  } finally {
    f.close();
  }
});

test("End on the transcript resumes following even when layout grows before scrolling", () => {
  const f = fixture();
  try {
    f.scroll(200);
    const event = new f.s.ownerDocument.defaultView!.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    });
    f.s.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    f.grow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("End inside a nested control retains the control's native behavior", () => {
  const f = fixture();
  try {
    f.scroll(200);
    const input = f.s.ownerDocument.createElement("textarea");
    f.s.append(input);
    const event = new f.s.ownerDocument.defaultView!.KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 200);
  } finally {
    f.close();
  }
});

test("revealing a message cancels pending and future bottom following", () => {
  const f = fixture();
  try {
    f.viewport.follow(true);
    f.viewport.cancelFollow();
    f.s.scrollTop = 40;
    f.flush();
    assert.equal(f.s.scrollTop, 40);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 40);
  } finally {
    f.close();
  }
});

test("the latest-prompt marker moves between rows and is restored after a template update", () => {
  const f = fixture();
  try {
    assert.equal(f.prompt.classList.contains("latest-prompt"), true);
    f.prompt.classList.remove("latest-prompt");
    f.viewport.sync(f.s);
    assert.equal(f.prompt.classList.contains("latest-prompt"), true);
    const next = f.prompt.cloneNode(true) as HTMLElement;
    next.className = "user-row";
    next.dataset.index = "2";
    f.prompt.after(next);
    f.viewport.sync(f.s);
    assert.equal(f.prompt.classList.contains("latest-prompt"), false);
    assert.equal(next.classList.contains("latest-prompt"), true);
    f.viewport.dispose();
    assert.equal(next.classList.contains("latest-prompt"), false);
  } finally {
    f.close();
  }
});

test("an inline steer takes the sticky prompt marker from the original request", () => {
  const f = fixture();
  try {
    const work = f.s.ownerDocument.createElement("article");
    work.className = "assistant-row";
    work.innerHTML = '<div class="inline-steer"><article class="user-row steered-row" data-index="1"></article></div>';
    f.prompt.after(work);
    f.viewport.sync(f.s);
    assert.equal(f.prompt.classList.contains("latest-prompt"), false);
    assert.equal(work.querySelector(".steered-row")!.classList.contains("latest-prompt"), true);
  } finally {
    f.close();
  }
});

test("a steer rendered inside the running turn is the latest prompt and anchors to the block above it", () => {
  const dom = new JSDOM(
    '<section><div class="message-stack"><article class="user-row" data-index="0"></article>' +
      '<article class="assistant-row" data-index="1"><div class="assistant-body"><details class="work"></details>' +
      '<div class="inline-steer" style="display: contents"><article class="user-row steered-row" data-index="2"><div class="pin-content"></div></article></div>' +
      '<div class="inline-steer" style="display: contents"><article class="user-row steered-row" data-index="3"><div class="pin-content"></div></article></div>' +
      "</div></article></div></section>",
  );
  const s = dom.window.document.querySelector("section")!;
  const [first, earlier, steer] = [...s.querySelectorAll<HTMLElement>(".user-row")];
  const content = steer!.querySelector<HTMLElement>(".pin-content")!;
  let scrollTop = 0;
  Object.defineProperties(s, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
    scrollTop: { get: () => scrollTop, set: (value: number) => (scrollTop = value) },
  });
  s.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  earlier!.getBoundingClientRect = () => ({ top: 100 - scrollTop, bottom: 140 - scrollTop, height: 40 }) as DOMRect;
  steer!.getBoundingClientRect = () => ({ top: Math.max(20, 156 - scrollTop), height: 50 }) as DOMRect;
  content.getBoundingClientRect = () => ({ height: 40 }) as DOMRect;
  Object.defineProperty(content, "scrollHeight", { value: 40 });
  const restore = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.assign(globalThis, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  const viewport = createTranscriptViewport();
  try {
    viewport.sync(s);
    assert.equal(first!.classList.contains("latest-prompt"), false);
    assert.equal(earlier!.classList.contains("latest-prompt"), false);
    assert.equal(steer!.classList.contains("latest-prompt"), true);
    s.scrollTop = 1;
    s.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(steer!.classList.contains("stuck"), false);
    s.scrollTop = 150;
    s.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(steer!.classList.contains("stuck"), true);
    assert.equal(steer!.style.getPropertyValue("--pin-content-max"), "26px");
    assert.equal(steer!.classList.contains("pin-condensed"), false);
  } finally {
    viewport.dispose();
    if (restore) Object.defineProperty(globalThis, "getComputedStyle", restore);
  }
});
