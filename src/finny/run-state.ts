export function terminalFinnyWorkerRunSql(binding: string, run: string, now: string): string {
  return `(
    ${run}.id IS NULL
    OR ${run}.status='failed'
    OR (
      ${run}.status='done'
      AND COALESCE(${run}.result::jsonb->>'status','') NOT IN ('pending_approval','refused')
    )
    OR (
      ${binding}.expires_at IS NOT NULL
      AND ${binding}.expires_at<=${now}
      AND ${run}.status NOT IN ('done','failed')
    )
  )`;
}
