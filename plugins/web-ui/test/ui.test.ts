import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { brandName, copyText, toggleFormMenu, closeFormMenus } from "../src/ui.ts";

test("brand name defaults to QM", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM("").window.document,
  });
  try {
    assert.equal(brandName(), "QM");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("brand name follows the server-injected deployment label", () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new JSDOM('<meta name="brand-self-label" content="qm">').window.document,
  });
  try {
    assert.equal(brandName(), "qm");
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else delete (globalThis as { document?: Document }).document;
  }
});

test("rapid copy feedback toggles a class and never rewrites the button markup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async () => {} } },
  });
  try {
    const button = new JSDOM(
      '<button><svg data-icon="copy"></svg><span>Copy URL</span></button>',
    ).window.document.querySelector("button") as HTMLButtonElement;
    const original = button.innerHTML;
    await copyText("first", button);
    await copyText("second", button);
    assert.ok(button.classList.contains("copied"));
    assert.equal(button.innerHTML, original);
    t.mock.timers.tick(1199);
    assert.ok(button.classList.contains("copied"), "the second copy restarts the feedback window");
    t.mock.timers.tick(1);
    assert.ok(!button.classList.contains("copied"));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete (globalThis as { navigator?: Navigator }).navigator;
  }
});

for (const scenario of [
  { name: "opens upward inside a shorter dialog", dialog: true, anchorTop: 340, upward: true },
  { name: "stays downward when the dialog has room", dialog: true, anchorTop: 200, upward: false },
  { name: "keeps viewport placement outside dialogs", dialog: false, anchorTop: 340, upward: false },
  { name: "opens upward at the viewport bottom", dialog: false, anchorTop: 710, upward: true },
]) {
  test(`form menu ${scenario.name}`, () => {
    const dom = new JSDOM(
      `<body>${scenario.dialog ? "<dialog open>" : ""}<div class="form-menu-control"><button class="menu-button"></button><div class="menu-popover" hidden></div></div>${scenario.dialog ? "</dialog>" : ""}</body>`,
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
    Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
    try {
      const document = dom.window.document;
      const control = document.querySelector<HTMLElement>(".form-menu-control")!;
      const button = document.querySelector<HTMLButtonElement>("button")!;
      const menu = document.querySelector<HTMLElement>(".menu-popover")!;
      const box = (x: number, y: number, width: number, height: number) => new dom.window.DOMRect(x, y, width, height);
      const dialog = document.querySelector("dialog");
      if (dialog) dialog.getBoundingClientRect = () => box(100, 100, 440, 300);
      control.getBoundingClientRect = () => box(300, scenario.anchorTop, 100, 30);
      menu.getBoundingClientRect = () => box(300, scenario.anchorTop + 36, 170, 110);
      button.addEventListener("click", toggleFormMenu);
      button.click();
      assert.equal(menu.hidden, false);
      assert.equal(menu.classList.contains("drop-up"), scenario.upward);
      assert.equal(button.getAttribute("aria-expanded"), "true");
      closeFormMenus();
      assert.equal(menu.hidden, true);
      assert.equal(menu.classList.contains("drop-up"), false);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
      else Reflect.deleteProperty(globalThis, "document");
      dom.window.close();
    }
  });
}
