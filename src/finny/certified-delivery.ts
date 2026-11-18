import type { Destination } from "../types.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { SLACK_CARD_LIMITS, SLACK_SECTION_TEXT_MAX } from "../slack/generative-ui.ts";
import { toSlackMrkdwn } from "../slack/mrkdwn.ts";
import type { FinnyStore } from "./store.ts";
import type {
  FinnyCertifiedResult,
  FinnyCertifiedResultReceipt,
  FinnyCertifiedResultRecord,
} from "./certified-result.ts";

export interface DeliverableFinnyCertifiedResult extends FinnyCertifiedResult {
  id: string;
  scopeId: string;
  receipt: FinnyCertifiedResultReceipt;
  destination: Destination;
  createdAt: number;
}

function deliveryDestination(value: Record<string, unknown>): Destination {
  if (typeof value.type !== "string" || typeof value.target !== "string" || !value.type || !value.target) {
    throw new Error("Finny certified result destination is invalid");
  }
  return value as unknown as Destination;
}

function deliverableResult(result: FinnyCertifiedResultRecord): DeliverableFinnyCertifiedResult {
  return { ...result, destination: deliveryDestination(result.destination) };
}

function summaryLines(result: DeliverableFinnyCertifiedResult): string[] {
  return [
    `*Period:* ${result.summary.period}`,
    `*Currency:* ${result.summary.currency}`,
    ...result.summary.metrics.map((metric) => `${metric.label}: ${metric.value}`),
    ...result.summary.exceptions.map(
      (exception) => `*${exception.material ? "Material exception" : "Exception"}:* ${exception.text}`,
    ),
    ...result.summary.caveats.map((caveat) => `*Caveat:* ${caveat.text}`),
  ];
}

function summarySections(result: DeliverableFinnyCertifiedResult): string[] {
  const lines = summaryLines(result);
  if (result.destination.type !== "slack") return [lines.join("\n")];
  const fixedBlocks = 3;
  const sectionBudget = SLACK_CARD_LIMITS.maxBlocks - fixedBlocks;
  const visibleLines = lines.flatMap((line) => {
    const segments: string[] = [];
    let offset = 0;
    while (offset < line.length) {
      let low = offset + 1;
      let high = line.length;
      let end = low;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (toSlackMrkdwn(line.slice(offset, middle)).length <= SLACK_SECTION_TEXT_MAX) {
          end = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      segments.push(line.slice(offset, end));
      offset = end;
    }
    return segments;
  });
  const exact: string[] = [];
  let current = "";
  for (const line of visibleLines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (toSlackMrkdwn(candidate).length > SLACK_SECTION_TEXT_MAX && current) {
      exact.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) exact.push(current);
  if (
    exact.length <= sectionBudget &&
    exact.every((section) => toSlackMrkdwn(section).length <= SLACK_SECTION_TEXT_MAX)
  )
    return exact;
  const linesPerSection = Math.ceil(lines.length / sectionBudget);
  const sections: string[] = [];
  for (let index = 0; index < lines.length; index += linesPerSection) {
    const group = lines.slice(index, index + linesPerSection);
    const lineBudget = Math.floor((SLACK_SECTION_TEXT_MAX - Math.max(0, group.length - 1)) / group.length);
    sections.push(
      group
        .map((line) => {
          if (toSlackMrkdwn(line).length <= lineBudget) return line;
          const separator = line.startsWith("*") ? -1 : line.lastIndexOf(": ");
          const suffix = separator >= 0 ? line.slice(separator) : "";
          let low = 0;
          let high = line.length - suffix.length;
          let prefixLength = 0;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = `${line.slice(0, middle)}…${suffix}`;
            if (toSlackMrkdwn(candidate).length <= lineBudget) {
              prefixLength = middle;
              low = middle + 1;
            } else {
              high = middle - 1;
            }
          }
          return `${line.slice(0, prefixLength)}…${suffix}`;
        })
        .join("\n"),
    );
  }
  return sections;
}

export function certifiedResultDelivery(result: DeliverableFinnyCertifiedResult, publicWebUrl: string) {
  const artifactUrl = `${publicWebUrl.replace(/\/$/, "")}/api/files/${encodeURIComponent(result.artifact.fileId)}/content`;
  const resultUrl = `${publicWebUrl.replace(/\/$/, "")}/api/finny/results/${encodeURIComponent(result.id)}`;
  const lines = [
    "*Finny certification complete*",
    ...summaryLines(result),
    `*Workbook:* <${artifactUrl}|Download certified workbook>`,
    `*Audit attempt:* \`${result.auditAttemptId}\``,
    `*Receipt:* \`${result.receipt.token}\``,
  ];
  return {
    destination:
      result.destination.type === "web"
        ? { ...result.destination, webTranscript: { kind: "reply" as const } }
        : result.destination,
    text: JSON.stringify({
      schema: "generative-ui.v1",
      fallbackText: lines.join("\n"),
      elements: [
        { type: "header", text: "Finny Certification Complete" },
        {
          type: "actions",
          buttons: [
            {
              label: "Download Workbook (.xlsx)",
              actionId: `finny_result_download_${result.id}`,
              value: result.artifact.fileId,
              url: artifactUrl,
              style: "primary",
            },
            {
              label: "Download Full Certified Summary (.json)",
              actionId: `finny_summary_download_${result.id}`,
              value: result.id,
              url: resultUrl,
            },
          ],
        },
        { type: "context", elements: [`Audit: \`${result.auditAttemptId}\``, `Receipt: \`${result.receipt.token}\``] },
        ...summarySections(result).map((text) => ({ type: "section", text })),
      ],
    }),
    idempotencyKey: `finny-result:${result.id}`,
  };
}

export async function deliverPendingCertifiedResults(
  results: Pick<FinnyStore, "pendingCertifiedResultDeliveries" | "markCertifiedResultDelivery">,
  deliveries: Pick<DeliveryStore, "enqueue">,
  publicWebUrl: string,
  afterEnqueue: (result: FinnyCertifiedResultRecord) => Promise<unknown>,
): Promise<void> {
  for (const result of await results.pendingCertifiedResultDeliveries()) {
    const delivery = await deliveries.enqueue(certifiedResultDelivery(deliverableResult(result), publicWebUrl));
    await afterEnqueue(result);
    await results.markCertifiedResultDelivery(result.id, delivery.id);
  }
}
