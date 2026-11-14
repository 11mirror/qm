import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../util/errors.ts";

export interface ResolvedFinanceIntent {
  readonly matched: boolean;
  readonly category?: "accounts_payable" | "accounts_receivable" | "general_ledger" | "mis_close";
  readonly producerSkill?: string;
  readonly intentName?: string;
  readonly mandatoryInvariants: readonly string[];
  readonly guidance: string;
}

export interface FinanceResolverIndex {
  resolve(query: string): ResolvedFinanceIntent;
  resolveAsync?(
    query: string,
    oneShot?: (systemPrompt: string, prompt: string) => Promise<string | undefined>,
  ): Promise<ResolvedFinanceIntent>;
  getRawContent(): string;
}
const AP_PATTERNS = [
  /\bap\b/i,
  /\baccounts?\s+payable\b/i,
  /\bvendor\b/i,
  /\bliabilit(y|ies)\b/i,
  /\bvendor\s+bills?\b/i,
  /\bmsme\b/i,
  /\baging\b/i,
  /\bpayables?\b/i,
];

const AR_PATTERNS = [
  /\bar\b/i,
  /\baccounts?\s+receivable\b/i,
  /\bcustomer\b/i,
  /\bcollections?\b/i,
  /\breceivables?\b/i,
  /\bunapplied\s+cash\b/i,
  /\bcustomer\s+advances?\b/i,
  /\bdebtors?\b/i,
];

const GL_PATTERNS = [
  /\bgl\b/i,
  /\bgeneral\s+ledger\b/i,
  /\btrial\s+balance\b/i,
  /\bp&l\b/i,
  /\bprofit\s+and\s+loss\b/i,
  /\bbalance\s+sheet\b/i,
  /\bebitda\b/i,
];

const MIS_PATTERNS = [
  /\bnet\s*worth\b/i,
  /\bfinancial\s+statement\b/i,
  /\bfinal\s+statement\b/i,
  /\bloss\s+bridge\b/i,
  /\baudited\b/i,
  /\bconsolidation\b/i,
  /\bconsolidated\b/i,
  /\bdebentures?\b/i,
  /\bsolvency\b/i,
  /\bfinancials?\b/i,
];

const FINANCE_KEYWORDS = [
  ...AP_PATTERNS,
  ...AR_PATTERNS,
  ...GL_PATTERNS,
  ...MIS_PATTERNS,
  /\bworkbook\b/i,
  /\bworksheet\b/i,
  /\bspreadsheet\b/i,
  /\bexcel\b/i,
  /\bfinancial\s+reconcil/i,
  /\bclosing\b/i,
];
export function isFinancialQuery(text: string): boolean {
  return FINANCE_KEYWORDS.some((regex) => regex.test(text));
}

let cachedContent: string | null = null;

function loadResolverContent(baseDir: string): string {
  if (cachedContent !== null) return cachedContent;
  const candidates = [
    join(baseDir, "work/qm-finance-skill-pack/skills/finance-router/references/resolver.md"),
    join(baseDir, "skills-seed/finnyloop/references/resolver.md"),
  ];

  const loaded: string[] = [];
  for (const path of candidates) {
    if (path && existsSync(path)) {
      try {
        loaded.push(readFileSync(path, "utf8"));
      } catch (e) {
        swallow("loadResolverContent", e);
      }
    }
  }
  cachedContent = loaded.join("\n\n");
  return cachedContent;
}

export function createFinanceResolverIndex(baseDir = process.cwd()): FinanceResolverIndex {
  const content = loadResolverContent(baseDir);

  return {
    getRawContent(): string {
      return content;
    },
    resolve(query: string): ResolvedFinanceIntent {
      const isAP = AP_PATTERNS.some((p) => p.test(query));
      const isAR = AR_PATTERNS.some((p) => p.test(query));
      const isGL = GL_PATTERNS.some((p) => p.test(query));

      if (isAP) {
        return {
          matched: true,
          category: "accounts_payable",
          producerSkill: "sharechat-ap-outstanding-workbook",
          intentName: "ap_closing_liability",
          mandatoryInvariants: [
            "Account 606702 FX exclusion: must enforce AND a.acctnumber NOT IN ('606702')",
            "Point-in-time DPD Aging: evaluate (cutoff_date - duedate), never use live daysoverduesearch",
            "Separate MSME vendor tracking via custentity_sc_acl_msme",
            "NetSuite SuiteQL does not expose 'AccountingPeriod' table or direct REST GET access. Cumulative posting period boundaries must be verified from transaction.postingperiod and trandate actuals (WHERE posting='T' AND type='Journal'), and primary book is established by default accountingbook=1.",
          ],
          guidance:
            "Accounts Payable query detected. Preflight must present plan with sharechat-ap-outstanding-workbook as Producer and verify against NetSuite AP controls.",
        };
      }

      if (isAR) {
        return {
          matched: true,
          category: "accounts_receivable",
          producerSkill: "sharechat-ar-collection",
          intentName: "ar_aging_collection",
          mandatoryInvariants: [
            "Legal entity and subsidiary scope must be explicitly verified",
            "Native NetSuite CustInvc and SAP Migrated populations must remain distinct until reconciled",
          ],
          guidance:
            "Accounts Receivable query detected. Preflight must present plan with sharechat-ar-collection as Producer.",
        };
      }

      if (isGL) {
        return {
          matched: true,
          category: "general_ledger",
          producerSkill: "sharechat-monthly-mis",
          intentName: "general_ledger_statement",
          mandatoryInvariants: [
            "Accounting period status (open, soft-closed, closed) must be explicitly stated",
            "Trial balance control and statement mapping provenance required",
          ],
          guidance: "General Ledger query detected. Preflight must present plan with sharechat-monthly-mis.",
        };
      }

      if (isFinancialQuery(query)) {
        return {
          matched: true,
          category: "mis_close",
          producerSkill: "sharechat-ap-outstanding-workbook",
          intentName: "general_finance_reconciliation",
          mandatoryInvariants: ["Deterministic formula recalculation and summary crossfoot required"],
          guidance: "General finance request detected. Route through FinnyLoop preflight plan approval.",
        };
      }

      return {
        matched: false,
        mandatoryInvariants: [],
        guidance: "Not classified as a finance query.",
      };
    },
    async resolveAsync(
      query: string,
      oneShot?: (systemPrompt: string, prompt: string) => Promise<string | undefined>,
    ): Promise<ResolvedFinanceIntent> {
      const initial = this.resolve(query);
      if (initial.matched) return initial;
      if (!oneShot) return initial;
      try {
        const systemPrompt =
          'You are a high-speed intent decomposer for a finance copilot. Determine if the user query asks for financial accounting, reconciliation, balance analysis, P&L, net worth, statements, ledger transactions, or spreadsheet workbook preparation.\nReply ONLY with valid JSON: {"matched": boolean, "category": "accounts_payable"|"accounts_receivable"|"general_ledger"|"mis_close"|null, "intentName": string|null}';
        const raw = await oneShot(systemPrompt, query);
        if (!raw) return initial;
        const parsed = JSON.parse(raw) as { matched?: boolean; category?: string; intentName?: string };
        if (parsed.matched) {
          const category =
            parsed.category === "accounts_payable" ||
            parsed.category === "accounts_receivable" ||
            parsed.category === "general_ledger" ||
            parsed.category === "mis_close"
              ? parsed.category
              : "mis_close";
          let producerSkill = "sharechat-monthly-mis";
          if (category === "accounts_payable") producerSkill = "sharechat-ap-outstanding-workbook";
          else if (category === "accounts_receivable") producerSkill = "sharechat-ar-collection";
          return {
            matched: true,
            category,
            producerSkill,
            intentName: parsed.intentName ?? "financial_analysis",
            mandatoryInvariants: ["Deterministic formula recalculation and summary crossfoot required"],
            guidance: "LLM classified as financial query. Route through FinnyLoop preflight plan approval.",
          };
        }
      } catch (e) {
        swallow("resolveAsync", e);
      }
      return initial;
    },
  };
}
