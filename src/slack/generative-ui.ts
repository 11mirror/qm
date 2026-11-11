import { escapeSlackText, toSlackMrkdwn } from "./mrkdwn.ts";
import { clip } from "./util.ts";

export type GenerativeUIElement =
  | HeaderElement
  | SectionElement
  | DividerElement
  | FieldsElement
  | ActionsElement
  | ContextElement
  | TableElement
  | ProgressCardElement;

export interface HeaderElement {
  type: "header";
  text: string;
}

export interface SectionElement {
  type: "section";
  text: string;
}

export interface DividerElement {
  type: "divider";
}

export interface FieldsElement {
  type: "fields";
  fields: Array<{ title: string; value: string }>;
}

export interface ActionButton {
  label: string;
  actionId: string;
  value: string;
  style?: "primary" | "danger";
}

export const GENERATIVE_ACTION_PREFIX = "gen_ui:";

export interface ActionsElement {
  type: "actions";
  buttons: ActionButton[];
}

export interface ContextElement {
  type: "context";
  elements: string[];
}

export interface TableElement {
  type: "table";
  headers: string[];
  rows: string[][];
}
export interface ProgressCardElement {
  type: "progress";
  title: string;
  status: "queued" | "in_progress" | "complete" | "failed";
  step?: string;
  percentage?: number;
}

export interface GenerativeUISpec {
  fallbackText?: string;
  elements: GenerativeUIElement[];
}

export const SLACK_CARD_LIMITS = {
  tables: 1,
  charts: 2,
  fields: 10,
  tableRows: 100,
  tableColumns: 10,
  chartTitle: 150,
  chartLabel: 100,
  chartSeries: 10,
  chartPoints: 30,
  maxBlocks: 50,
};

const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_BUTTON_TEXT_MAX = 75;
const SLACK_BLOCKS_MAX = SLACK_CARD_LIMITS.maxBlocks;
export function renderGenerativeUI(spec: GenerativeUISpec): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const blocks: Array<Record<string, unknown>> = [];

  for (const element of spec.elements) {
    if (blocks.length >= SLACK_BLOCKS_MAX) break;

    switch (element.type) {
      case "header": {
        const text =
          element.text.length <= SLACK_HEADER_TEXT_MAX ? element.text : clip(element.text, SLACK_HEADER_TEXT_MAX - 1);
        blocks.push({
          type: "header",
          text: {
            type: "plain_text",
            text,
            emoji: true,
          },
        });
        break;
      }
      case "section": {
        const rendered = toSlackMrkdwn(element.text);
        const text = rendered.length <= SLACK_SECTION_TEXT_MAX ? rendered : clip(rendered, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
      case "divider": {
        blocks.push({ type: "divider" });
        break;
      }
      case "fields": {
        const fields = element.fields.slice(0, 10).map((f) => {
          const raw = `*${escapeSlackText(f.title)}*\n${toSlackMrkdwn(f.value)}`;
          return {
            type: "mrkdwn",
            text: raw.length <= 2000 ? raw : clip(raw, 1999),
          };
        });
        blocks.push({ type: "section", fields });
        break;
      }
      case "actions": {
        const elements = element.buttons.slice(0, 25).map((btn) => {
          const label =
            btn.label.length <= SLACK_BUTTON_TEXT_MAX ? btn.label : clip(btn.label, SLACK_BUTTON_TEXT_MAX - 1);
          const actionId = btn.actionId.startsWith(GENERATIVE_ACTION_PREFIX)
            ? btn.actionId
            : `${GENERATIVE_ACTION_PREFIX}${btn.actionId}`;
          return {
            type: "button",
            text: {
              type: "plain_text",
              text: label,
              emoji: true,
            },
            action_id: actionId,
            value: btn.value,
            ...(btn.style ? { style: btn.style } : {}),
          };
        });
        if (elements.length > 0) {
          blocks.push({ type: "actions", elements });
        }
        break;
      }
      case "context": {
        const elements = element.elements.slice(0, 10).map((text) => {
          const rendered = toSlackMrkdwn(text);
          return {
            type: "mrkdwn",
            text: rendered.length <= 2000 ? rendered : clip(rendered, 1999),
          };
        });
        if (elements.length > 0) {
          blocks.push({ type: "context", elements });
        }
        break;
      }
      case "table": {
        const headerLine = `| ${element.headers.join(" | ")} |`;
        const sepLine = `| ${element.headers.map(() => "---").join(" | ")} |`;
        const bodyLines = element.rows.map((row) => `| ${row.join(" | ")} |`);
        const tableMarkdown = [headerLine, sepLine, ...bodyLines].join("\n");
        const rendered = toSlackMrkdwn(tableMarkdown);
        const text = rendered.length <= SLACK_SECTION_TEXT_MAX ? rendered : clip(rendered, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
      case "progress": {
        let icon = "⏸️";
        if (element.status === "complete") icon = "✅";
        else if (element.status === "failed") icon = "❌";
        else if (element.status === "in_progress") icon = "⏳";
        const progressLine =
          element.percentage !== undefined ? ` [${Math.min(100, Math.max(0, Math.round(element.percentage)))}%]` : "";
        const stepLine = element.step ? `\n_${escapeSlackText(element.step)}_` : "";
        const raw = `${icon} *${escapeSlackText(element.title)}*${progressLine}${stepLine}`;
        const text = raw.length <= SLACK_SECTION_TEXT_MAX ? raw : clip(raw, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
    }
  }

  const fallback = spec.fallbackText || "Slack card update";
  return {
    text: fallback,
    blocks,
  };
}
export function parseGenerativeUISpec(content: string): GenerativeUISpec | null {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    // Support official json-render / Chat SDK schema ({ root: "card", elements: { ... } })
    if (
      typeof parsed.root === "string" &&
      parsed.elements &&
      typeof parsed.elements === "object" &&
      !Array.isArray(parsed.elements)
    ) {
      const rawMap = parsed.elements as Record<string, Record<string, unknown>>;
      const rootEl = rawMap[parsed.root];
      if (!rootEl) return null;

      const elements: GenerativeUIElement[] = [];
      const rootProps = (rootEl.props ?? {}) as Record<string, unknown>;
      const fallbackText =
        typeof rootProps.title === "string" ? (rootProps.title as string) : undefined;

      if (rootProps.title) {
        elements.push({ type: "header", text: String(rootProps.title) });
      }
      if (rootProps.subtitle) {
        elements.push({ type: "section", text: String(rootProps.subtitle) });
      }

      const walkChildren = (childrenKeys: unknown[]) => {
        if (!Array.isArray(childrenKeys)) return;
        for (const key of childrenKeys) {
          const child = rawMap[String(key)];
          if (!child) continue;
          const type = String(child.type);
          const props = (child.props ?? {}) as Record<string, unknown>;

          if (type === "Text" && typeof props.content === "string") {
            elements.push({ type: "section", text: props.content });
          } else if (type === "Divider") {
            elements.push({ type: "divider" });
          } else if (type === "Section") {
            walkChildren(child.children as unknown[]);
          } else if (type === "Fields" && Array.isArray(child.children)) {
            const fields: Array<{ title: string; value: string }> = [];
            for (const fKey of child.children as unknown[]) {
              const fChild = rawMap[String(fKey)];
              if (fChild && fChild.type === "Field" && fChild.props) {
                const fp = fChild.props as Record<string, unknown>;
                fields.push({ title: String(fp.label ?? ""), value: String(fp.value ?? "") });
              }
            }
            if (fields.length) elements.push({ type: "fields", fields });
          } else if (type === "Table" && Array.isArray(props.headers) && Array.isArray(props.rows)) {
            const headers = props.headers.map(String);
            const rows = (props.rows as unknown[][]).map((r) => r.map((c) => (c == null ? "" : String(c))));
            elements.push({ type: "table", headers, rows });
          } else if (type === "Actions" && Array.isArray(child.children)) {
            const buttons: ActionButton[] = [];
            for (const bKey of child.children as unknown[]) {
              const bChild = rawMap[String(bKey)];
              if (bChild && (bChild.type === "Button" || bChild.type === "LinkButton") && bChild.props) {
                const bp = bChild.props as Record<string, unknown>;
                buttons.push({
                  label: String(bp.label ?? ""),
                  actionId: String(bp.id ?? bp.url ?? "action"),
                  value: String(bp.value ?? bp.url ?? ""),
                  ...(bp.style === "primary" || bp.style === "danger" ? { style: bp.style } : {}),
                });
              }
            }
            if (buttons.length) elements.push({ type: "actions", buttons });
          }
        }
      };

      walkChildren(rootEl.children as unknown[]);
      if (elements.length > 0) {
        return {
          ...(fallbackText ? { fallbackText } : {}),
          elements,
        };
      }
    }

    if (parsed.schema !== "generative-ui.v1" || !Array.isArray(parsed.elements)) return null;
    const validatedElements: GenerativeUIElement[] = [];
    for (const raw of parsed.elements) {
      if (!raw || typeof raw !== "object") continue;
      const el = raw as Record<string, unknown>;
      if (el.type === "header" && typeof el.text === "string" && el.text.trim()) {
        validatedElements.push({ type: "header", text: el.text });
      } else if (el.type === "section" && typeof el.text === "string" && el.text.trim()) {
        validatedElements.push({ type: "section", text: el.text });
      } else if (el.type === "divider") {
        validatedElements.push({ type: "divider" });
      } else if (el.type === "fields" && Array.isArray(el.fields)) {
        const fields = el.fields
          .filter(
            (f): f is { title: string; value: string } =>
              !!f && typeof f.title === "string" && typeof f.value === "string",
          )
          .map((f) => ({ title: f.title, value: f.value }));
        if (fields.length > 0) validatedElements.push({ type: "fields", fields });
      } else if (el.type === "actions" && Array.isArray(el.buttons)) {
        const buttons = el.buttons
          .filter(
            (b): b is ActionButton =>
              !!b && typeof b.label === "string" && typeof b.actionId === "string" && typeof b.value === "string",
          )
          .map((b) => ({
            label: b.label,
            actionId: b.actionId,
            value: b.value,
            ...(b.style === "primary" || b.style === "danger" ? { style: b.style } : {}),
          }));
        if (buttons.length > 0) validatedElements.push({ type: "actions", buttons });
      } else if (el.type === "context" && Array.isArray(el.elements)) {
        const elements = el.elements.filter((item): item is string => typeof item === "string" && !!item.trim());
        if (elements.length > 0) validatedElements.push({ type: "context", elements });
      } else if (el.type === "table" && Array.isArray(el.headers) && Array.isArray(el.rows)) {
        const headers = el.headers.filter((h): h is string => typeof h === "string");
        const rows = el.rows
          .filter((r): r is unknown[] => Array.isArray(r))
          .map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
        if (headers.length > 0 && rows.length > 0) validatedElements.push({ type: "table", headers, rows });
      } else if (el.type === "progress" && typeof el.title === "string" && typeof el.status === "string") {
        const status = ["queued", "in_progress", "complete", "failed"].includes(el.status)
          ? (el.status as ProgressCardElement["status"])
          : "in_progress";
        const percentage =
          typeof el.percentage === "number" && Number.isFinite(el.percentage) ? el.percentage : undefined;
        const step = typeof el.step === "string" ? el.step : undefined;
        validatedElements.push({
          type: "progress",
          title: el.title,
          status,
          ...(percentage !== undefined ? { percentage } : {}),
          ...(step ? { step } : {}),
        });
      }
    }

    if (validatedElements.length === 0) return null;

    return {
      ...(typeof parsed.fallbackText === "string" && parsed.fallbackText.trim()
        ? { fallbackText: parsed.fallbackText }
        : {}),
      elements: validatedElements,
    };
  } catch {
    return null;
  }
}

export function registerGenerativeUIActions(app: {
  action(pattern: RegExp, handler: (args: any) => Promise<void>): void;
}): void {
  app.action(new RegExp(`^${GENERATIVE_ACTION_PREFIX}`), async ({ ack }) => {
    await ack();
  });
}
