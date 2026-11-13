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
  | ProgressCardElement
  | ProvenanceElement
  | MetricElement
  | CalloutElement;

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

export interface ProvenanceItem {
  metric: string;
  source: string;
  rule: string;
  status?: string;
}

export interface ProvenanceElement {
  type: "provenance";
  items: ProvenanceItem[];
}

export interface MetricElement {
  type: "metric";
  label: string;
  value: string;
  delta?: string;
}

export interface CalloutElement {
  type: "callout";
  text: string;
  level?: "info" | "warning" | "success";
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
      case "metric": {
        const deltaStr = element.delta ? `  ·  *${escapeSlackText(element.delta)}*` : "";
        const raw = `*${escapeSlackText(element.label)}*\n>*${toSlackMrkdwn(element.value)}*${deltaStr}`;
        const text = raw.length <= SLACK_SECTION_TEXT_MAX ? raw : clip(raw, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text },
        });
        break;
      }
      case "callout": {
        let icon = "ℹ️";
        if (element.level === "warning") icon = "⚠️";
        else if (element.level === "success") icon = "✅";
        const raw = `>${icon} ${toSlackMrkdwn(element.text)}`;
        const text = raw.length <= SLACK_SECTION_TEXT_MAX ? raw : clip(raw, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text },
        });
        break;
      }
      case "provenance": {
        blocks.push({
          type: "header",
          text: { type: "plain_text", text: "Every Answer, Traceable", emoji: true },
        });
        for (const item of element.items.slice(0, 10)) {
          const statusIcon = item.status ? `  ·  \`${escapeSlackText(item.status)}\`` : "  ·  `Verified ✓`";
          const raw = `• *${escapeSlackText(item.metric)}*\n    \`${escapeSlackText(item.source)}\`  ·  _${escapeSlackText(item.rule)}_${statusIcon}`;
          const text = raw.length <= SLACK_SECTION_TEXT_MAX ? raw : clip(raw, SLACK_SECTION_TEXT_MAX - 1);
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text },
          });
        }
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
function extractJsonCandidate(content: string): string | null {
  let trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (match?.[1]) trimmed = match[1].trim();
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fencedMatch = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(content);
  if (fencedMatch?.[1]) return fencedMatch[1].trim();
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1).trim();
  }
  return null;
}

export function parseGenerativeUISpec(content: string): GenerativeUISpec | null {
  try {
    const candidate = extractJsonCandidate(content);
    if (!candidate) return null;
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
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
      const fallbackText = typeof rootProps.title === "string" ? (rootProps.title as string) : undefined;

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
          const rawType = String(child.type ?? "").toLowerCase();
          const props = (child.props ?? {}) as Record<string, unknown>;

          if (rawType === "text" || rawType === "section") {
            const text = String(props.content ?? props.text ?? "");
            if (text.trim()) elements.push({ type: "section", text });
          } else if (rawType === "divider") {
            elements.push({ type: "divider" });
          } else if (rawType === "card" && props.title) {
            elements.push({ type: "header", text: String(props.title) });
            if (props.subtitle) elements.push({ type: "section", text: String(props.subtitle) });
            walkChildren(child.children as unknown[]);
          } else if (rawType === "fields" && Array.isArray(child.children)) {
            const fields: Array<{ title: string; value: string }> = [];
            for (const fKey of child.children as unknown[]) {
              const fChild = rawMap[String(fKey)];
              if (fChild && String(fChild.type ?? "").toLowerCase() === "field" && fChild.props) {
                const fp = fChild.props as Record<string, unknown>;
                const title = String(fp.title ?? fp.label ?? fp.name ?? "").trim();
                const value = String(fp.value ?? "").trim();
                if (title && value) fields.push({ title, value });
              }
            }
            if (fields.length) elements.push({ type: "fields", fields });
          } else if (
            rawType === "table" &&
            Array.isArray(props.headers ?? props.columns) &&
            Array.isArray(props.rows)
          ) {
            const rawHeaders = (props.headers ?? props.columns) as unknown[];
            const headers = rawHeaders.map((h) => (h == null ? "" : String(h)));
            const rows = (props.rows as unknown[][]).map((r) => r.map((c) => (c == null ? "" : String(c))));
            if (headers.length && rows.length) elements.push({ type: "table", headers, rows });
          } else if (rawType === "actions" && Array.isArray(child.children)) {
            const buttons: ActionButton[] = [];
            for (const bKey of child.children as unknown[]) {
              const bChild = rawMap[String(bKey)];
              const bType = String(bChild?.type ?? "").toLowerCase();
              if (bChild && (bType === "button" || bType === "linkbutton") && bChild.props) {
                const bp = bChild.props as Record<string, unknown>;
                buttons.push({
                  label: String(bp.label ?? bp.text ?? ""),
                  actionId: String(bp.id ?? bp.actionId ?? bp.url ?? "action"),
                  value: String(bp.value ?? bp.url ?? ""),
                  ...(bp.style === "primary" || bp.style === "danger" ? { style: bp.style } : {}),
                });
              }
            }
            if (buttons.length) elements.push({ type: "actions", buttons });
          } else if (rawType === "metric" && props.label && props.value) {
            elements.push({
              type: "metric",
              label: String(props.label),
              value: String(props.value),
              ...(props.delta ? { delta: String(props.delta) } : {}),
            });
          } else if (rawType === "callout" && (props.text || props.content)) {
            const level = props.level === "warning" || props.level === "success" ? props.level : "info";
            elements.push({
              type: "callout",
              text: String(props.text ?? props.content),
              level,
            });
          } else if (rawType === "provenance" && Array.isArray(props.items)) {
            const items = (props.items as unknown[])
              .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
              .map((it) => ({
                metric: String(it.metric ?? it.name ?? it.title ?? ""),
                source: String(it.source ?? it.gl ?? it.account ?? ""),
                rule: String(it.rule ?? it.formula ?? it.derivation ?? ""),
                ...(it.status ? { status: String(it.status) } : {}),
              }))
              .filter((it) => it.metric && it.source && it.rule);
            if (items.length) elements.push({ type: "provenance", items });
          } else if (Array.isArray(child.children)) {
            walkChildren(child.children as unknown[]);
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
      } else if (
        (el.type === "section" || el.type === "text") &&
        typeof (el.text ?? el.content) === "string" &&
        String(el.text ?? el.content).trim()
      ) {
        validatedElements.push({ type: "section", text: String(el.text ?? el.content) });
      } else if (el.type === "divider") {
        validatedElements.push({ type: "divider" });
      } else if (el.type === "fields" && Array.isArray(el.fields)) {
        const fields = el.fields
          .map((f) => {
            if (!f || typeof f !== "object") return null;
            const rec = f as Record<string, unknown>;
            const title = String(rec.title ?? rec.label ?? rec.name ?? "").trim();
            const value = rec.value !== null && rec.value !== undefined ? String(rec.value).trim() : "";
            return title && value ? { title, value } : null;
          })
          .filter((f): f is { title: string; value: string } => f !== null);
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
      } else if (el.type === "table" && Array.isArray(el.headers ?? el.columns) && Array.isArray(el.rows)) {
        const rawHeaders = (el.headers ?? el.columns) as unknown[];
        const headers = rawHeaders.map((h) => (h === null || h === undefined ? "" : String(h)));
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
      } else if (el.type === "metric" && typeof el.label === "string" && typeof el.value === "string") {
        validatedElements.push({
          type: "metric",
          label: el.label,
          value: el.value,
          ...(typeof el.delta === "string" ? { delta: el.delta } : {}),
        });
      } else if (el.type === "callout" && typeof (el.text ?? el.content) === "string") {
        const level = el.level === "warning" || el.level === "success" ? el.level : "info";
        validatedElements.push({
          type: "callout",
          text: String(el.text ?? el.content),
          level,
        });
      } else if (el.type === "provenance" && Array.isArray(el.items)) {
        const items = el.items
          .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
          .map((it) => ({
            metric: String(it.metric ?? it.name ?? it.title ?? ""),
            source: String(it.source ?? it.gl ?? it.account ?? ""),
            rule: String(it.rule ?? it.formula ?? it.derivation ?? ""),
            ...(it.status ? { status: String(it.status) } : {}),
          }))
          .filter((it) => it.metric && it.source && it.rule);
        if (items.length) validatedElements.push({ type: "provenance", items });
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
