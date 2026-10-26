# Runtime upgrade compatibility

Pin the runtime source or image digest and deployment CLI together. Run migrations
before serving traffic, then qualify that exact candidate against an isolated copy
of the existing database. Keep the previous images and deployment configuration
available until the new revision has passed operational checks.

## Configuration changes

- `qm sandbox publish` and the `sandbox.image` runtime pin are retired.
  `qm sandbox build` remains available for validating local layer builds;
  `sandbox.baseImage` identifies their build input. Supply sandbox tools through
  deployment layers and configure the selected backend through its supported
  settings.
- The `sandbox_routing` table, `SANDBOX_RESOURCES_ENABLED`, and the sandbox
  migration endpoints and agent action are retired. Sandbox resources are always
  on; scoped execution uses the selected sandbox resource. Disposable computers use
  that resource's provider, or the installation provider when no resource is selected. On upgrade,
  existing routes and `SANDBOX_SCOPE_BACKENDS` mappings are imported once as
  sandbox records so existing computers are preserved; afterwards
  `SANDBOX_SCOPE_BACKENDS` has no runtime effect. To move a scope to another
  provider, create a sandbox there, copy durable work via git or Files, and set
  it as the default. Keep credentials and provider settings for all legacy mappings
  until the import completes; an unconfigured provider needed by the import stops
  startup before any adoption state is written.
- Reach-denied Slack notifications are retired. Consult the audit log for denied
  requests.

## Database upgrades and rollback

Migration identifiers and SQL checksums retain their original meaning. An existing
checksum mismatch stops the upgrade; do not clear the migration ledger or edit its
checksums to bypass this check.

The schema starts from `src/persistence/schema-baseline.sql`, which folds every
migration released up to qm main 9be16d35 (the list is in
`src/persistence/schema-baseline.ts`). A new database gets the baseline, then the later
migrations. An existing database must already have applied every folded migration, as
any deployment that has booted qm main 9be16d35 or later has: it records
`baseline/0001` without changing anything and runs only the later migrations. Startup
refuses an older database and names the migrations it lacks; boot it once on a release
from 9be16d35 up to the one before the baseline, then upgrade. Startup also refuses a
database that has QM tables but no `qm_schema_migrations` ledger.

Rolling back the runtime restores code and configuration, not database contents.
Older binaries do not display cron history written only to the new journal; those
records remain stored in `cron_fires`. Validate both old and new readers against the
candidate database before promotion, and retain a database recovery point for any
rollback that requires restoring data as well as code.
