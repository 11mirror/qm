import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTranscriptViewport, preserveTranscriptScroll } from "../src/transcript-viewport.ts";
import { fixture } from "./support/transcript-viewport-fixture.ts";

test("layout mutations preserve bottom following and an earlier reading anchor independently", () => {
  const dom = new JSDOM(
    '<main><section class="chat-scroll"><div class="message-stack"><p>Reading here</p></div></section><section class="chat-scroll"></section></main>',
  );
  const root = dom.window.document.querySelector("main")!;
  const [reading, following] = [...root.querySelectorAll<HTMLElement>("section")];
  const anchor = reading!.querySelector("p")!;
  let height = 1000;
  let anchorTop = 330;
  for (const element of [reading!, following!]) {
    Object.defineProperties(element, { clientHeight: { value: 200 }, scrollHeight: { get: () => height } });
    element.getBoundingClientRect = () => ({ top: 20 }) as DOMRect;
  }
  anchor.getBoundingClientRect = () =>
    ({ top: 20 + anchorTop - reading!.scrollTop, bottom: 100 + anchorTop - reading!.scrollTop }) as DOMRect;
  reading!.scrollTop = 350;
  following!.scrollTop = 800;
  const restore = preserveTranscriptScroll(root);
  reading!.scrollTop = following!.scrollTop = 0;
  anchorTop += 120;
  height += 300;
  restore();
  assert.equal(reading!.scrollTop, 470);
  assert.equal(following!.scrollTop, 1300);
  assert.equal(anchor.getBoundingClientRect().top, 0);
});

test("layout restoration ignores removed panes and falls back when an anchor was replaced", () => {
  const dom = new JSDOM(
    '<main><section class="chat-scroll"><div class="message-stack"><p>Reading</p></div></section><section class="chat-scroll"></section></main>',
  );
  const root = dom.window.document.querySelector("main")!;
  const [reading, removed] = [...root.querySelectorAll<HTMLElement>("section")];
  for (const element of [reading!, removed!]) {
    Object.defineProperties(element, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
    element.scrollTop = 350;
  }
  reading!.querySelector("p")!.getBoundingClientRect = () => ({ top: 10, bottom: 50 }) as DOMRect;
  const restore = preserveTranscriptScroll(root);
  reading!.replaceChildren();
  removed!.remove();
  reading!.scrollTop = removed!.scrollTop = 0;
  restore();
  assert.equal(reading!.scrollTop, 350);
  assert.equal(removed!.scrollTop, 0);
});

test("scrolling toward earlier messages loads before reaching the top and pauses following", () => {
  const f = fixture();
  try {
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    f.s.querySelector(".message-stack")!.prepend(button);
    let loads = 0;
    button.onclick = () => {
      loads++;
      button.disabled = true;
    };
    f.viewport.sync(f.s);
    assert.equal(loads, 0);
    f.scroll(500);
    assert.equal(loads, 0);
    f.scroll(350);
    assert.equal(loads, 1);
    f.scroll(100);
    f.wheelUp();
    assert.equal(loads, 1);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 100);
    button.disabled = false;
    f.scroll(300);
    assert.equal(loads, 1);
    f.scroll(200);
    assert.equal(loads, 2);
  } finally {
    f.close();
  }
});

test("upward wheel loads history even when the transcript cannot scroll", () => {
  const f = fixture();
  try {
    f.fit();
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    f.s.querySelector(".message-stack")!.prepend(button);
    let loads = 0;
    button.onclick = () => {
      loads++;
    };
    f.wheelUp();
    assert.equal(loads, 1);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 0);
    f.viewport.dispose();
    f.wheelUp();
    assert.equal(loads, 1);
  } finally {
    f.close();
  }
});

test("a transcript too short to fill the viewport keeps loading earlier pages until it does", () => {
  const f = fixture();
  try {
    f.fit();
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    const stack = f.s.querySelector<HTMLElement>(".message-stack")!;
    stack.prepend(button);
    const page = () => stack.append(f.s.ownerDocument.createElement("article"));
    let loads = 0;
    button.onclick = () => {
      loads++;
      button.disabled = true;
    };
    f.viewport.sync(f.s);
    assert.equal(loads, 1, "no scroll or wheel is needed when there is nothing to scroll");
    f.viewport.sync(f.s);
    assert.equal(loads, 1, "a page already loading is not requested twice");
    page();
    button.disabled = false;
    f.resize(30, 50);
    assert.equal(loads, 2, "still short after a page arrives, so the next page loads");
    for (let i = 0; i < 6; i++) f.grow();
    page();
    button.disabled = false;
    f.resize(30, 50);
    f.viewport.sync(f.s);
    assert.equal(loads, 2, "once the content overflows well past the top, loading waits for the reader");
    button.remove();
  } finally {
    f.close();
  }
});

test("a page that fails to load is not retried by auto-fill until the reader asks", () => {
  const f = fixture();
  try {
    f.fit();
    const button = f.s.ownerDocument.createElement("button");
    button.className = "earlier-messages-btn";
    f.s.querySelector(".message-stack")!.prepend(button);
    let loads = 0;
    button.onclick = () => loads++;
    f.viewport.sync(f.s);
    f.resize(30, 50);
    f.viewport.sync(f.s);
    assert.equal(loads, 1, "no growth since the last automatic load means no automatic retry");
    f.wheelUp();
    assert.equal(loads, 2, "the reader can still ask for it");
  } finally {
    f.close();
  }
});

test("a hidden pane never pulls history just because it has no height", () => {
  const dom = new JSDOM('<section class="chat-scroll"><div class="message-stack"></div></section>');
  const s = dom.window.document.querySelector<HTMLElement>("section")!;
  Object.defineProperties(s, { clientHeight: { value: 0 }, scrollHeight: { value: 0 } });
  const button = dom.window.document.createElement("button");
  button.className = "earlier-messages-btn";
  s.querySelector(".message-stack")!.prepend(button);
  let loads = 0;
  button.onclick = () => loads++;
  const viewport = createTranscriptViewport();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.assign(globalThis, { getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  try {
    viewport.sync(s);
    assert.equal(loads, 0);
  } finally {
    viewport.dispose();
    if (saved) Object.defineProperty(globalThis, "getComputedStyle", saved);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
    dom.window.close();
  }
});

test("a bottom-pinned stream follows growth instantly and coalesces frames", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 900);
    assert.deepEqual(f.writes, [1100]);
  } finally {
    f.close();
  }
});

test("resizing a settled transcript updates the prompt expansion control", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"><markdown-block></markdown-block></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    let availableHeight = 240;
    Object.defineProperties(content, {
      scrollHeight: { value: 240 },
      clientHeight: { get: () => availableHeight },
    });
    f.viewport.sync(f.s);
    f.resize(30, 50);
    assert.equal(toggle.hidden, true);
    availableHeight = 160;
    f.resize(30, 50);
    assert.equal(toggle.hidden, false);
    availableHeight = 240;
    f.resize(30, 50);
    assert.equal(toggle.hidden, true);
  } finally {
    f.close();
  }
});

test("even a small upward scroll stops following; returning to the bottom resumes it", () => {
  const f = fixture();
  try {
    f.scroll(798);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 798);
    assert.deepEqual(f.writes, [798]);
    f.scroll(900);
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 1000);
  } finally {
    f.close();
  }
});

test("an upward wheel that cannot move a short transcript keeps following its growth", () => {
  const f = fixture();
  try {
    f.fit();
    f.wheelUp();
    f.grow();
    f.viewport.follow();
    f.flush();
    assert.equal(f.s.scrollTop, 100);
  } finally {
    f.close();
  }
});

test("an upward wheel cancels a queued follow before its scroll event arrives", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.wheelUp();
    f.flush();
    assert.equal(f.writes.length, 0);
  } finally {
    f.close();
  }
});

test("scrolling between scheduling and painting cannot be overwritten", () => {
  const f = fixture();
  try {
    f.grow();
    f.viewport.follow();
    f.s.scrollTop -= 10;
    f.flush();
    assert.deepEqual(f.writes, [790]);
  } finally {
    f.close();
  }
});

test("only reaching the sticky edge elevates the prompt; pin resizes update the edge", () => {
  const f = fixture();
  try {
    f.resize(30, 200);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("stuck"), true);
    f.resize(90, 110);
    assert.equal(f.s.style.getPropertyValue("--chat-sticky-top"), "90px");
    assert.equal(f.prompt.classList.contains("stuck"), true);
    f.scroll(0);
    assert.equal(f.prompt.classList.contains("stuck"), false);
  } finally {
    f.close();
  }
});

test("turning the pin preference off releases the latest prompt live, and turning it on pins it again", () => {
  let pin = true;
  const f = fixture({ pinPrompt: () => pin });
  try {
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("latest-prompt"), true);
    assert.equal(f.prompt.classList.contains("stuck"), true);
    pin = false;
    f.viewport.refresh();
    assert.equal(f.prompt.classList.contains("latest-prompt"), false);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    f.scroll(700);
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("latest-prompt"), false);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    pin = true;
    f.viewport.refresh();
    assert.equal(f.prompt.classList.contains("latest-prompt"), true);
    assert.equal(f.prompt.classList.contains("stuck"), true);
  } finally {
    f.close();
  }
});

test("a prompt that starts unpinned is never made sticky", () => {
  const f = fixture({ pinPrompt: () => false });
  try {
    f.resize(30, 50);
    f.scroll(600);
    assert.equal(f.prompt.classList.contains("latest-prompt"), false);
    assert.equal(f.prompt.classList.contains("stuck"), false);
  } finally {
    f.close();
  }
});

test("disposing cancels queued work and clears sticky presentation", () => {
  const f = fixture();
  try {
    f.viewport.follow();
    f.viewport.dispose();
    f.flush();
    assert.equal(f.writes.length, 0);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    assert.equal(f.s.style.getPropertyValue("--chat-sticky-top"), "");
  } finally {
    f.close();
  }
});

test("native scroll anchoring is restored when the reader leaves the bottom", () => {
  const f = fixture();
  try {
    assert.equal(f.s.style.overflowAnchor, "none");
    f.scroll(700);
    assert.equal(f.s.style.overflowAnchor, "");
    f.scroll(800);
    assert.equal(f.s.style.overflowAnchor, "none");
  } finally {
    f.close();
  }
});

test("replacing a scroller does not arm follow without an explicit fresh-session jump", () => {
  const f = fixture();
  try {
    f.viewport.dispose();
    f.viewport.sync(f.s);
    f.viewport.follow();
    f.flush();
    assert.equal(f.writes.length, 0);
    f.viewport.follow(true);
    f.flush();
    assert.equal(f.writes.length, 1);
  } finally {
    f.close();
  }
});

test("redrawing unchanged nodes while reading performs no layout reads", () => {
  const f = fixture();
  try {
    f.scroll(600);
    f.s.getBoundingClientRect = () => {
      throw new Error("unexpected layout read");
    };
    f.viewport.sync(f.s);
    f.viewport.follow();
    f.flush();
    assert.deepEqual(f.writes, [600]);
  } finally {
    f.close();
  }
});

test("a prompt stays in flow when pins leave too little room, and can stick again after resizing", () => {
  const f = fixture();
  try {
    f.resize(160, 180);
    assert.equal(f.prompt.classList.contains("sticky-disabled"), true);
    assert.equal(f.prompt.classList.contains("stuck"), false);
    f.resize(30, 50);
    assert.equal(f.prompt.classList.contains("sticky-disabled"), false);
    assert.equal(f.prompt.classList.contains("stuck"), true);
  } finally {
    f.close();
  }
});

test("nested paste and attachment controls do not toggle the whole prompt", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"><code-block><button class="text-code-toggle">Show more</button><copy-button><button>Copy</button></copy-button></code-block><div class="message-files"><a class="file-chip" href="#file">notes.txt</a></div></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    Object.defineProperties(content, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 160 },
    });
    f.viewport.sync(f.s);
    assert.equal(toggle.hidden, false);
    for (const expanded of [false, true]) {
      if (expanded) toggle.click();
      for (const selector of [".text-code-toggle", "copy-button button", ".file-chip"]) {
        f.prompt.querySelector<HTMLElement>(selector)!.click();
        assert.equal(f.prompt.classList.contains("pin-expanded"), expanded);
        assert.equal(toggle.getAttribute("aria-expanded"), String(expanded));
      }
    }
  } finally {
    f.close();
  }
});

test("prompt clipping tolerates rounding but discloses any additional text line", () => {
  const f = fixture();
  try {
    f.prompt.innerHTML =
      '<div class="user-bubble"><div class="pin-content"></div><button class="pin-toggle" hidden>Show more</button></div>';
    const content = f.prompt.querySelector<HTMLElement>(".pin-content")!;
    const toggle = f.prompt.querySelector<HTMLButtonElement>(".pin-toggle")!;
    let overflow = 5;
    Object.defineProperties(content, {
      scrollHeight: { get: () => 160 + overflow },
      clientHeight: { value: 160 },
    });
    f.viewport.sync(f.s);
    for (overflow of [0, 1, 2, 23, 100, 1]) {
      f.resize(30, 50);
      assert.equal(toggle.hidden, overflow <= 1);
      f.resize(30, 50);
      assert.equal(toggle.hidden, overflow <= 1, "stable on repeated measurements");
    }
    f.viewport.dispose();
  } finally {
    f.close();
  }
});
