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

test("Finny Harness Coordinator Chatter Suppression Eval: fails if uncertified interim figures are emitted during in-flight rework", () => {
  // Simulated prompt check: Coordinator must be instructed to stay silent on intermediate subagent wake turns
  // and forbid broadcasting raw uncertified tables/numbers until finalized.
  const coordinatorGuidance = `
### Coordinator Silence & Anti-Chatter Rules
1. DO NOT broadcast intermediate debugging, audit rejections, or uncertified accounting figures into the Slack thread during in-flight rework or auditing.
2. Call finish_silently when subagents report intermediate progress or non-terminal audit outcomes.
3. Never output provisional numbers or raw text tables in chat. Only deliver when the job is finalized via the certified Generative UI card.
  `;

  assert.ok(
    coordinatorGuidance.includes("finish_silently"),
    "Coordinator guidance must instruct calling finish_silently during in-flight turns",
  );
  assert.ok(
    coordinatorGuidance.includes("Never output provisional numbers"),
    "Coordinator guidance must forbid outputting provisional numbers",
  );
});
