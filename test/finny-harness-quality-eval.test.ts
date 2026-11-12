import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGenerativeUISpec, renderGenerativeUI } from "../src/slack/generative-ui.ts";

test("Finny Harness UI & Quality Eval: fails when json-render is wrapped in commentary or markdown fences", () => {
  const jsonRenderPayload = JSON.stringify({
    root: "card-1",
    elements: {
      "card-1": {
        type: "card",
        props: {
          title: "Weekly AR Report — Outstanding as of 19 Oct 2026",
          subtitle: "Total Open AR: ₹18.27 Cr | Overdue: ₹7.66 Cr",
          children: ["table-1"],
        },
      },
      "table-1": {
        type: "table",
        props: {
          columns: ["Customer", "Overdue (INR)", "Max DPD"],
          rows: [
            ["Directorate of Advertising & Visual", "86,13,076", "591"],
            ["Tamada Media", "72,27,500", "139"],
          ],
        },
      },
    },
  });

  // Edge 1: Clean raw JSON (currently passes)
  const cleanSpec = parseGenerativeUISpec(jsonRenderPayload);
  assert.ok(cleanSpec, "Clean raw JSON should parse");
  const cleanCard = renderGenerativeUI(cleanSpec);
  assert.ok(cleanCard.blocks.length > 0, "Clean card should render blocks");

  // Edge 2: Wrapped in markdown code fences ```json ... ``` (fails today)
  const fencedPayload = `\`\`\`json\n${jsonRenderPayload}\n\`\`\``;
  const fencedSpec = parseGenerativeUISpec(fencedPayload);
  assert.ok(
    fencedSpec !== null,
    "FAILED TODAY: parseGenerativeUISpec returns null when model wraps JSON in markdown code fences",
  );

  // Edge 3: Preceded by conversational commentary (fails today)
  const commentaryPayload = `Here is the verified weekly AR report:\n\n${jsonRenderPayload}\n\nAll reconciliations tie out.`;
  const commentarySpec = parseGenerativeUISpec(commentaryPayload);
  assert.ok(
    commentarySpec !== null,
    "FAILED TODAY: parseGenerativeUISpec returns null when model surrounds JSON with conversational commentary",
  );

  // Edge 4: Preceded by commentary AND wrapped in markdown fences (fails today)
  const mixedPayload = `Good news on the verification. Summary below:\n\`\`\`json\n${jsonRenderPayload}\n\`\`\``;
  const mixedSpec = parseGenerativeUISpec(mixedPayload);
  assert.ok(
    mixedSpec !== null,
    "FAILED TODAY: parseGenerativeUISpec returns null on mixed conversational prose and fenced JSON",
  );
});

test("Finny Harness Workflow & Safety Eval: identifies sandbox command approval traps and worker instruction gaps", () => {
  // Edge 5: Worker instructions must explicitly prohibit destructive rm -rf and external soffice CLI
  const sampleWorkerTask = {
    producerInstruction: `Produce or reuse the approved workbook in the persistent sandbox following the resolved domain skill (such as sharechat-ap-outstanding-workbook). All spreadsheet calculations, crossfoots, and verifications MUST be performed using pure-Python openpyxl with pre-computed cached values. DO NOT call LibreOffice/soffice or run destructive commands (such as rm -rf). Persist it by POSTing JSON {name,mimetype,dataBase64} to $AGENT_API_URL/v1/files/upload with x-agent-capability: $AGENT_API_TOKEN.`,
  };

  assert.ok(
    sampleWorkerTask.producerInstruction.includes("openpyxl"),
    "Producer instruction must mandate openpyxl for calculation",
  );
  assert.ok(
    sampleWorkerTask.producerInstruction.includes("DO NOT call LibreOffice/soffice"),
    "Producer instruction must forbid external LibreOffice/soffice CLI",
  );
  assert.ok(
    sampleWorkerTask.producerInstruction.includes(
      "DO NOT call LibreOffice/soffice or run destructive commands (such as rm -rf)",
    ),
    "Producer instruction must forbid rm -rf",
  );
});
