import { el } from "./dom.ts";
import { node, stacked } from "./shared.ts";
import { scopeKind } from "./format.ts";

export interface ScopeChoice {
  scopeId: string;
  label: string;
}

export function scopeMultiSelect(
  choices: ScopeChoice[],
  selected: Set<string>,
  onChange: () => void,
  dirLabel: (id: string) => string,
) {
  const pick = el("div.scopepick");
  const labelOf = (id: string) => choices.find((c) => c.scopeId === id)?.label || dirLabel(id) || id;
  const orgFirst = (ids: string[]) =>
    ids.sort((a: string, b: string) => {
      if (scopeKind(a) === "org") return -1;
      if (scopeKind(b) === "org") return 1;
      return a.localeCompare(b);
    });
  const changed = () => {
    renderChips();
    renderList();
    onChange();
  };
  const chips = el("div.scope-chips");
  const renderChips = (): void => {
    if (!selected.size) return chips.replaceChildren(el("span.scope-chips-empty", "no scopes selected"));
    chips.replaceChildren(
      ...orgFirst([...selected]).map((id) => {
        const remove = el("button.scope-chip-remove", {
          type: "button",
          textContent: "✕",
          "aria-label": "Remove " + labelOf(id),
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            selected.delete(id);
            changed();
          },
        });
        return el("span.scope-pick-chip", { title: id }, el("span", labelOf(id)), remove);
      }),
    );
  };
  const addBtn = el("button.rowbtn", {
    type: "button",
    textContent: "+ Add scope ▾",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
  });
  const filter = el("input", {
    type: "text",
    placeholder: "Filter scopes…",
    autocapitalize: "none",
  }) as HTMLInputElement;
  filter.spellcheck = false;
  const list = el("div.scope-list", { role: "listbox" });
  const bulkLink = (text: string, onclick: () => void) =>
    el("button.scope-bulk-link", { type: "button", textContent: text, onclick });
  const bulk = el(
    "div.scope-bulk",
    {},
    bulkLink("Select all", () => {
      choices.forEach((c) => selected.add(c.scopeId));
      changed();
    }),
    bulkLink("Clear", () => {
      selected.clear();
      changed();
    }),
  );
  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = choices.filter((c) => !q || c.label.toLowerCase().includes(q) || c.scopeId.toLowerCase().includes(q));
    if (!shown.length) return list.replaceChildren(el("div.scope-note", "No scopes match."));
    list.replaceChildren(
      ...shown.map((c) => {
        const on = selected.has(c.scopeId);
        const name = el("span.scope-name", {}, node(stacked(c.label, c.label === c.scopeId ? "" : c.scopeId)));
        return el(
          "button.scope-option" + (on ? " selected" : ""),
          {
            type: "button",
            role: "option",
            "aria-selected": String(on),
            title: c.scopeId,
            onclick: () => {
              if (selected.has(c.scopeId)) selected.delete(c.scopeId);
              else selected.add(c.scopeId);
              changed();
              filter.focus();
            },
          },
          name,
          el("span.count", on ? "✓" : ""),
        );
      }),
    );
  };
  const menu = el("div.scope-menu hidden", {}, el("div.scope-filter", {}, filter), list, bulk);
  let onDocClick: ((e: MouseEvent) => void) | null = null;
  const setOpen = (open: boolean) => {
    menu.classList.toggle("hidden", !open);
    addBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      filter.value = "";
      renderList();
      filter.focus();
      onDocClick = (e: MouseEvent) => {
        if (!pick.contains(e.target as Node)) setOpen(false);
      };
      document.addEventListener("click", onDocClick);
    } else if (onDocClick) {
      document.removeEventListener("click", onDocClick);
      onDocClick = null;
    }
  };
  addBtn.onclick = (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains("hidden"));
  };
  filter.addEventListener("input", renderList);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      addBtn.focus();
    }
  });
  pick.append(chips, addBtn, menu);
  renderChips();
  return pick;
}
