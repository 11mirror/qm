export function finnySopFixture() {
  return {
    schema: "finny.sop.v1",
    id: "ap-aging",
    version: 3,
    scopeId: "org:invented-media-company",
    title: "AP aging at cutoff",
    intent: {
      domain: "ap",
      description: "Vendor bill aging at a period cutoff",
      searchTerms: ["accounts payable", "vendor aging", "cutoff"],
    },
    objective: "Produce a vendor-level AP aging workbook and certified summary at the approved cutoff.",
    inputs: [
      { id: "cutoff", label: "Cutoff date", from: "human", type: "date", required: true, material: true },
      {
        id: "currency",
        label: "Presentation currency",
        from: "human",
        type: "currency",
        required: true,
        material: true,
      },
      { id: "note", label: "Run note", from: "human", type: "text", required: false, material: false },
    ],
    sources: [
      {
        id: "bills",
        system: "NetSuite",
        object: "transaction + transactionline + vendor",
        fields: ["transaction.id", "duedate", "amountremaining", "currency"],
        filter: "posting='T' AND type='VendBill' AND amountremaining<>0",
        asOfInput: "cutoff",
      },
    ],
    steps: [
      {
        id: "extract",
        action: "Query the approved population and record its row count and control total.",
        reads: ["bills", "cutoff"],
        writes: "source_manifest",
      },
      {
        id: "render",
        action: "Write Detail, Summary, and Exceptions sheets with cached summary values.",
        reads: ["source_manifest", "currency"],
        writes: "workbook",
      },
    ],
    controls: [
      {
        id: "source-total",
        assertion: "Detail amount equals the source control total.",
        tolerance: "0.01",
        evidenceRefs: ["source_manifest", "workbook"],
        deterministicCheckId: "summary.crossfoot",
      },
      {
        id: "mapping-exception",
        assertion: "No materially unmapped vendor classification remains.",
        evidenceRefs: ["workbook"],
        deterministicCheckId: "artifact.structure",
        judgment: {
          question: "Are remaining unmapped classifications materially misleading?",
          onlyWhen: "Exceptions.material_count > 0",
          triggerVerdict: "block",
        },
      },
    ],
    outputs: [
      {
        id: "workbook",
        kind: "xlsx",
        contract: {
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sheets: ["Summary", "Detail", "Exceptions"],
        },
      },
      {
        id: "certified-summary",
        kind: "summary",
        contract: { metrics: ["totalOpenAP", "overdueAP"], caveats: true },
        rerun: { inputIds: ["cutoff", "currency"] },
      },
    ],
    approval: { required: true, destination: "origin-thread" },
  } as const;
}

export function finnySopJobFields(scopeId: string) {
  return {
    sop: { ...finnySopFixture(), scopeId },
    values: { cutoff: "2026-10-31", currency: "INR" },
  } as const;
}
