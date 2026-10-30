export const FINNY_AP_GL_CONTROL_BALANCE_QUERY =
  "SELECT COALESCE(SUM(NVL(tal.credit, 0) - NVL(tal.debit, 0)), 0) AS total " +
  "FROM TransactionAccountingLine tal " +
  "WHERE tal.accounttype = 'AcctPay' AND tal.accountingbook = 1";
