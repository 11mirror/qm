type Kid = Node | string;
type Props = Record<string, any>;

export function el(spec: string, props?: Props | string | null, ...kids: Kid[]): HTMLElement {
  const [tag = "div", className] = spec.split(".");
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (props === null || typeof props !== "object") node.textContent = props ?? "";
  else
    for (const [key, value] of Object.entries(props)) {
      if (key === "style") node.style.cssText = value;
      else if (key in node) (node as any)[key] = value;
      else node.setAttribute(key, value);
    }
  node.append(...kids);
  return node;
}

export function kpis(items: [unknown, unknown][], className = "") {
  const kpi = ([n, k]: [unknown, unknown]) =>
    el("div.kpi", {}, el("div.n", { textContent: n }), el("div.k", { textContent: k }));
  const wrap = el("div.kpis", {}, ...items.map(kpi));
  if (className) wrap.classList.add(className);
  return wrap;
}

export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    void 0;
  }
  const ta = document.body.appendChild(
    el("textarea", { value: text, style: "position: fixed; opacity: 0;" }),
  ) as HTMLTextAreaElement;
  ta.select();
  let ok;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function linkClick(go: () => void) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go();
  };
}

export function searchField({
  placeholder = "Search…",
  onInput = (_value: string) => {},
  value = "",
  disabled = false,
}) {
  const input = el("input", {
    type: "search",
    placeholder,
    "aria-label": placeholder.replace(/[…]+$/, ""),
    autocapitalize: "none",
    value,
    disabled,
    oninput: () => onInput(input.value),
  }) as HTMLInputElement;
  input.spellcheck = false;
  const icon = el("span.admin-search-icon", {
    "aria-hidden": "true",
    innerHTML:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  });
  const clear = el("button.icon-button admin-search-clear", {
    type: "button",
    "aria-label": "Clear search",
    textContent: "×",
    disabled,
    onclick: () => {
      input.value = "";
      onInput("");
      input.focus();
    },
  });
  return el("div.shell-search admin-search", {}, input, icon, clear);
}

export function backArrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({
    width: "15",
    height: "15",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(k, v);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m12 19-7-7 7-7M5 12h14");
  svg.appendChild(path);
  return svg;
}

export interface ErrorRow {
  message?: string;
  category?: string;
  code?: string;
  ts?: number;
}
