import assert from "node:assert/strict";
import test from "node:test";

import { selectFinnyVerificationPolicy, validateFinnyAccounting } from "../src/finny/accounting-validator.ts";

test("trusted finance intent selects a deterministic accounting verification policy", () => {
  assert.equal(selectFinnyVerificationPolicy("What is our current AP balance?"), "single_numeric_total");
  assert.equal(selectFinnyVerificationPolicy("Verify the trial balance debits and credits"), "balanced_debits_credits");
  assert.equal(selectFinnyVerificationPolicy("Does the balance sheet balance?"), "balance_sheet_equation");
  assert.equal(selectFinnyVerificationPolicy("List the latest vendor names"), "repeatable_read");
});

test("single-total verification requires finite numeric finance fields", () => {
  assert.equal(validateFinnyAccounting([{ total: "42.00", currency: "INR" }], "single_numeric_total").passed, true);
  assert.equal(validateFinnyAccounting([{ total: "1.26666583621E9" }], "single_numeric_total").passed, true);
  assert.equal(validateFinnyAccounting([{ total: "not-a-number" }], "single_numeric_total").passed, false);
  assert.equal(validateFinnyAccounting([{ vendor: "Example" }], "single_numeric_total").passed, false);
});

test("debit-credit verification uses exact decimals and rejects a non-zero residual", () => {
  assert.equal(validateFinnyAccounting([{ debit: "1.25e3", credit: "1250" }], "balanced_debits_credits").passed, true);
  assert.equal(
    validateFinnyAccounting(
      [
        { debit: "0.10", credit: "0" },
        { debit: "0.20", credit: "0.30" },
      ],
      "balanced_debits_credits",
    ).passed,
    true,
  );
  assert.equal(
    validateFinnyAccounting([{ debit: "100.00", credit: "99.99" }], "balanced_debits_credits").passed,
    false,
  );
});

test("balance-sheet verification enforces assets equals liabilities plus equity", () => {
  assert.equal(
    validateFinnyAccounting([{ assets: "125.50", liabilities: "75.25", equity: "50.25" }], "balance_sheet_equation")
      .passed,
    true,
  );
  assert.equal(
    validateFinnyAccounting([{ assets: "125.50", liabilities: "75.25", equity: "50.24" }], "balance_sheet_equation")
      .passed,
    false,
  );
});
