import { el } from "./dom.ts";

const CHEVRON =
  '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
let openDropdown: HTMLElement | null = null;
let sequence = 0;

const fire = (target: Element) =>
  ["input", "change"].forEach((type) => target.dispatchEvent(new Event(type, { bubbles: true })));

function closeDropdown(dd: HTMLElement | null) {
  if (!dd) return;
  dd.classList.remove("open");
  const btn = dd.querySelector(".dd-btn");
  btn?.setAttribute("aria-expanded", "false");
  btn?.removeAttribute("aria-activedescendant");
}

function upgrade(sel: HTMLSelectElement) {
  if (
    sel.dataset.ddHost ||
    sel.hasAttribute("hidden") ||
    sel.multiple ||
    sel.size > 1 ||
    sel.closest(".loadout-control")
  )
    return;
  const native = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!;
  sel.dataset.ddHost = "1";
  const dd = el("div.dd");
  if (sel.getAttribute("style")) dd.setAttribute("style", sel.getAttribute("style")!);
  const lab = el("span");
  const menu = el("div.dd-menu", { role: "listbox", id: "dd-menu-" + ++sequence });
  const btn = el(
    "button",
    { type: "button", "aria-haspopup": "listbox", "aria-expanded": "false" },
    lab,
  ) as HTMLButtonElement;
  btn.setAttribute("aria-controls", menu.id);
  btn.insertAdjacentHTML("beforeend", CHEVRON);
  dd.append(btn, menu);
  sel.after(dd);
  let activeIndex = -1;
  const syncLabel = () => {
    const o = sel.selectedOptions[0];
    lab.textContent = o ? o.textContent : "";
    const label = sel.getAttribute("aria-label") || sel.labels?.[0]?.textContent?.trim() || "";
    btn.setAttribute("aria-label", label ? label + ": " + lab.textContent : lab.textContent || "");
    btn.className = ["dd-btn", ...sel.classList].join(" ");
    btn.disabled = sel.disabled;
  };
  const commit = (value: string) => {
    if (native.get!.call(sel) === value) return;
    native.set!.call(sel, value);
    syncLabel();
    fire(sel);
  };
  const enabledOptions = () => Array.from(sel.options).filter((o) => !o.disabled);
  const closeThis = () => {
    closeDropdown(dd);
    openDropdown = null;
  };
  const setActive = (index: number) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".dd-item:not(.dis)"));
    activeIndex = items.length ? Math.max(0, Math.min(items.length - 1, index)) : -1;
    items.forEach((it, i) => {
      it.classList.toggle("active", i === activeIndex);
      if (i !== activeIndex) return;
      btn.setAttribute("aria-activedescendant", it.id);
      it.scrollIntoView({ block: "nearest" });
    });
  };
  const buildMenu = () => {
    activeIndex = -1;
    let enabledIndex = 0;
    menu.replaceChildren(
      ...Array.from(sel.options).map((o, i) => {
        const it = el("div", {
          className: "dd-item" + (o.selected ? " sel" : "") + (o.disabled ? " dis" : ""),
          id: menu.id + "-option-" + i,
          role: "option",
          textContent: o.textContent,
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            if (o.disabled) return;
            closeThis();
            commit(o.value);
            btn.focus();
          },
        });
        if (o.selected) it.setAttribute("aria-selected", "true");
        if (!o.disabled && o.selected) activeIndex = enabledIndex;
        if (!o.disabled) enabledIndex += 1;
        return it;
      }),
    );
    setActive(activeIndex);
  };
  const open = () => {
    if (sel.disabled) return;
    if (openDropdown && openDropdown !== dd) closeDropdown(openDropdown);
    buildMenu();
    dd.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    openDropdown = dd;
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = dd.classList.contains("open");
    closeDropdown(openDropdown);
    openDropdown = null;
    if (!wasOpen) open();
  };
  btn.onkeydown = (e) => {
    if (!["Escape", "Enter", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const isOpen = dd.classList.contains("open");
    if (e.key === "Escape") return closeThis();
    if (e.key === "Enter" && isOpen) {
      const option = enabledOptions()[activeIndex];
      if (option) commit(option.value);
      return closeThis();
    }
    if (e.key !== "Enter" && !enabledOptions().length) return;
    if (!isOpen) return open();
    setActive(activeIndex + (e.key === "ArrowDown" ? 1 : -1));
  };
  Object.defineProperty(sel, "value", {
    get() {
      return native.get!.call(sel);
    },
    set(v) {
      native.set!.call(sel, v);
      syncLabel();
    },
  });
  new MutationObserver(() => {
    syncLabel();
    if (dd.classList.contains("open")) buildMenu();
  }).observe(sel, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "disabled", "label", "selected", "value"],
  });
  sel.addEventListener("change", syncLabel);
  syncLabel();
}

export function initCustomDropdowns(root: Node | null) {
  if (!(root instanceof Element)) return;
  if (root instanceof HTMLSelectElement) upgrade(root);
  root.querySelectorAll("select").forEach(upgrade);
}

export function watchCustomDropdowns(root: HTMLElement) {
  document.addEventListener("click", () => {
    closeDropdown(openDropdown);
    openDropdown = null;
  });
  initCustomDropdowns(root);
  new MutationObserver((muts) =>
    muts.forEach((m) => m.addedNodes.forEach((n) => n instanceof HTMLElement && initCustomDropdowns(n))),
  ).observe(root, { childList: true, subtree: true });
}
