-- QM schema baseline 0001: the schema an empty database reaches by applying every migration folded into it (the list
-- is in schema-baseline.ts; qm main at 9be16d35). Generated with pg_dump --schema-only from a single-tenant database,
-- then stripped of comments, settings and the public. qualifier so it builds in the connection's current schema.
-- Never edit it: later schema changes are ordinary migrations.

CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TYPE item_kind AS ENUM (
    'UserMessage',
    'SteeringMessage',
    'AgentMessage',
    'Reasoning',
    'ToolCall',
    'ToolResult',
    'Elicitation',
    'ElicitationResponse',
    'Wake',
    'Error',
    'ContextCompaction',
    'Retraction',
    'Stop',
    'RuntimeChange'
);

CREATE TYPE wake_cause AS ENUM (
    'cron',
    'webhook',
    'child_done',
    'system'
);

CREATE FUNCTION acl_grants_bump_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 1)
        ON CONFLICT (only_row) DO UPDATE SET v = acl_grants_version.v + 1;
        RETURN NULL;
      END
      $$;

CREATE FUNCTION forbid_direct_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
     RAISE EXCEPTION 'DELETE on % is only allowed through its session', TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
   END $$;

CREATE FUNCTION invalidate_request_spend() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
           BEGIN
             INSERT INTO session_spend_dirty(day)
             SELECT DISTINCT floor(at::numeric / 86400000)::bigint
               FROM (VALUES
                 (CASE WHEN TG_OP <> 'INSERT' AND OLD.usage_json IS NOT NULL THEN OLD.created_at END),
                 (CASE WHEN TG_OP <> 'DELETE' AND NEW.usage_json IS NOT NULL THEN NEW.created_at END)
               ) changed(at) WHERE at IS NOT NULL
             ON CONFLICT DO NOTHING;
             RETURN NULL;
           END $$;

CREATE FUNCTION invalidate_session_spend() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
           BEGIN
             IF TG_OP = 'UPDATE' AND ROW(OLD.id, OLD.scope_id, OLD.origin, OLD.thread_ref, OLD.parent_session_id)
                  IS NOT DISTINCT FROM ROW(NEW.id, NEW.scope_id, NEW.origin, NEW.thread_ref, NEW.parent_session_id) THEN
               RETURN NULL;
             END IF;
             INSERT INTO session_spend_dirty(session_id)
             SELECT DISTINCT id FROM (VALUES (OLD.id), (NEW.id)) changed(id) WHERE id IS NOT NULL;
             RETURN NULL;
           END $$;

CREATE FUNCTION qm_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$ SELECT id FROM qm_tenant $$;

CREATE FUNCTION safe_json(t text) RETURNS json
    LANGUAGE plpgsql IMMUTABLE
    AS $$
        BEGIN RETURN t::json; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE FUNCTION spend_usage_json(t text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $$
             DECLARE j jsonb;
             BEGIN
               IF t IS NULL OR octet_length(t) > 2000 OR NOT pg_input_is_valid(t, 'jsonb') THEN
                 RETURN NULL;
               END IF;
               j := t::jsonb;
               IF pg_input_is_valid(j ->> 'costUsd', 'double precision') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'input', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'output', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheRead', 'bigint') IS NOT FALSE
                  AND pg_input_is_valid(j ->> 'cacheWrite', 'bigint') IS NOT FALSE THEN
                 RETURN j;
               END IF;
               RETURN NULL;
             END
             $$;

CREATE TABLE ack_emoji (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE ack_emoji_picks (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    channel text NOT NULL,
    ts text NOT NULL,
    outcome text NOT NULL,
    picked text,
    icon text,
    message text,
    candidates text,
    model text,
    latency_ms integer,
    created_at bigint NOT NULL
);

CREATE SEQUENCE ack_emoji_picks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE ack_emoji_picks_id_seq OWNED BY ack_emoji_picks.id;

CREATE TABLE acl_grants (
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    grantee_scope_id text NOT NULL,
    permission text NOT NULL,
    granted_by text NOT NULL
);

CREATE TABLE acl_grants_version (
    only_row boolean DEFAULT true NOT NULL,
    v bigint NOT NULL,
    CONSTRAINT acl_grants_version_only_row_check CHECK (only_row)
);

CREATE TABLE admin_grants (
    principal_id text NOT NULL,
    scope_id text NOT NULL,
    role text NOT NULL,
    granted_by text,
    created_at bigint
);

CREATE TABLE ambient_cursors (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE ambient_judgments (
    id bigint NOT NULL,
    org_id text NOT NULL,
    surface text NOT NULL,
    container text NOT NULL,
    decision text NOT NULL,
    reason text,
    asked_by text,
    prompt text,
    model text,
    latency_ms integer,
    ts_from text,
    ts_to text,
    created_at bigint NOT NULL
);

CREATE SEQUENCE ambient_judgments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE ambient_judgments_id_seq OWNED BY ambient_judgments.id;

CREATE TABLE approval_grant_modes (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE approval_grants (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE approvals (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE audit_log (
    id bigint NOT NULL,
    at bigint NOT NULL,
    principal_id text NOT NULL,
    action text NOT NULL,
    resource text NOT NULL,
    scope_label text NOT NULL,
    status text,
    detail text,
    idempotency_key text
);

CREATE SEQUENCE audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE audit_log_id_seq OWNED BY audit_log.id;

CREATE TABLE auth_broker_sessions (
    token_hash text NOT NULL,
    email text NOT NULL,
    authenticated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    idle_seconds integer NOT NULL
);

CREATE TABLE auto_flagger_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE aws_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE base_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE blobs (
    tenant_id uuid NOT NULL,
    sha256 bytea NOT NULL,
    size bigint NOT NULL,
    mime text,
    storage_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT blobs_sha256_check CHECK ((length(sha256) = 32)),
    CONSTRAINT blobs_size_check CHECK ((size >= 0)),
    CONSTRAINT blobs_storage_key_check CHECK ((storage_key <> ''::text))
);

CREATE TABLE branding_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE browse_max_steps_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE browse_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE browser_sessions (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE channel_files (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    file_id text NOT NULL,
    name text,
    mimetype text,
    created_at bigint NOT NULL,
    title text,
    size bigint
);

CREATE TABLE channel_header_pin_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE channel_messages (
    org_id text NOT NULL,
    container text NOT NULL,
    ts text NOT NULL,
    sub text,
    author_id text,
    author_name text,
    text text DEFAULT ''::text NOT NULL,
    mentions jsonb,
    self boolean DEFAULT false NOT NULL,
    bot boolean DEFAULT false NOT NULL,
    mentions_self boolean DEFAULT false NOT NULL,
    edited_at bigint,
    deleted boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    handled boolean DEFAULT false NOT NULL,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text, ''::text))) STORED,
    deleted_at bigint,
    broadcast boolean DEFAULT false NOT NULL,
    subtype text,
    bot_id text
);

CREATE TABLE channel_policy (
    org_id text NOT NULL,
    container text NOT NULL,
    orders text DEFAULT ''::text NOT NULL,
    bots jsonb DEFAULT '{}'::jsonb NOT NULL,
    set_by text,
    updated_at bigint NOT NULL,
    ambient_enabled boolean
);

CREATE TABLE channel_policy_history (
    id bigint NOT NULL,
    org_id text NOT NULL,
    container text NOT NULL,
    orders text NOT NULL,
    set_by text,
    session_id text,
    created_at bigint NOT NULL,
    bots jsonb,
    ambient_enabled boolean
);

CREATE SEQUENCE channel_policy_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE channel_policy_history_id_seq OWNED BY channel_policy_history.id;

CREATE TABLE channel_state (
    org_id text NOT NULL,
    container text NOT NULL,
    last_ts text,
    oldest_ts text,
    name text,
    kind text,
    members jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE command_policies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE composio_returns (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE connector_clients (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE connector_status (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE consent_links (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE context_requests (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE credential_daily_calls (
    slug text NOT NULL,
    day bigint NOT NULL,
    sent integer NOT NULL
);

CREATE TABLE credential_usage (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    slug text NOT NULL,
    host text NOT NULL,
    status text NOT NULL,
    upstream_status integer,
    scope_label text NOT NULL,
    principal_id text NOT NULL
);

CREATE SEQUENCE credential_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE credential_usage_id_seq OWNED BY credential_usage.id;

CREATE TABLE cron_fires (
    cron_id text NOT NULL,
    fire_key text NOT NULL,
    thread_ref text NOT NULL,
    session_id text,
    fired_at bigint NOT NULL,
    scheduled_at bigint,
    ended_at bigint,
    status text,
    note text,
    reply text
);

CREATE TABLE crons (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE custom_model_providers (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE deactivated_principals (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE decision_providers (
    provider_id text NOT NULL,
    protocol text NOT NULL,
    base_url text,
    credential text,
    updated_by text NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE decision_rules (
    rule_id text NOT NULL,
    hook text NOT NULL,
    question text NOT NULL,
    options json NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    mode text NOT NULL,
    on_error text NOT NULL,
    updated_by text NOT NULL,
    updated_at bigint NOT NULL,
    CONSTRAINT decision_rules_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'observe'::text, 'enforce'::text])))
);

CREATE TABLE deploy_git_repos (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE deployment_access (
    id text NOT NULL,
    last_access_at bigint NOT NULL
);

CREATE TABLE deployment_identity (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE deployment_layer (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE deployments (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE directory_channel_members (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    principal_id text NOT NULL
);

CREATE TABLE directory_channels (
    org_id text NOT NULL,
    channel_id text NOT NULL,
    name text NOT NULL,
    name_lc text NOT NULL,
    is_private boolean DEFAULT false NOT NULL,
    is_external boolean DEFAULT false NOT NULL,
    roster_known boolean DEFAULT false NOT NULL,
    observed_at bigint
);

CREATE TABLE directory_group_members (
    org_id text NOT NULL,
    group_id text NOT NULL,
    principal_id text NOT NULL
);

CREATE TABLE directory_groups (
    org_id text NOT NULL,
    group_id text NOT NULL,
    roster_known boolean DEFAULT false NOT NULL
);

CREATE TABLE directory_members (
    org_id text NOT NULL,
    principal_id text NOT NULL,
    display_name text NOT NULL,
    display_name_lc text NOT NULL,
    type text NOT NULL,
    slack_id text,
    avatar_url text
);

CREATE TABLE directory_meta (
    org_id text NOT NULL,
    workspace_url text,
    updated_at bigint NOT NULL
);

CREATE TABLE directory_sync (
    org_id text NOT NULL,
    members_hash text,
    channels_hash text,
    groups_hash text,
    channel_members_synced boolean DEFAULT false NOT NULL,
    updated_at bigint NOT NULL,
    members_synced_at bigint,
    channels_synced_at bigint,
    groups_synced_at bigint
);

CREATE TABLE durable_map_versions (
    tbl text NOT NULL,
    v bigint NOT NULL
);

CREATE TABLE e2b_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE egress_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    source text NOT NULL,
    host text NOT NULL,
    allowed boolean NOT NULL,
    scope_label text NOT NULL,
    port integer,
    verdict text,
    via text,
    peer_ip text,
    principal_id text
);

CREATE SEQUENCE egress_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE egress_events_id_seq OWNED BY egress_events.id;

CREATE TABLE egress_policies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE environment_attachments (
    scope_id text NOT NULL,
    environment_id text NOT NULL,
    attached_by text NOT NULL,
    attached_at bigint NOT NULL
);

CREATE TABLE environments (
    id text NOT NULL,
    org_id text NOT NULL,
    name text,
    owner_actor_id text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE error_events (
    id bigint NOT NULL,
    ts bigint NOT NULL,
    scope_label text NOT NULL,
    category text NOT NULL,
    code text NOT NULL,
    message text NOT NULL,
    session_id text
);

CREATE SEQUENCE error_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE error_events_id_seq OWNED BY error_events.id;

CREATE TABLE external_members (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE external_slack_participants_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE feature_flags (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE file_artifact_deletions (
    id text NOT NULL,
    deleted_at bigint NOT NULL
);

CREATE TABLE file_artifacts (
    id text NOT NULL,
    kind text DEFAULT 'file'::text NOT NULL,
    owner_scope_id text NOT NULL,
    path text NOT NULL,
    name text NOT NULL,
    mimetype text NOT NULL,
    size_bytes bigint NOT NULL,
    blob_key text,
    sha256 text,
    direction text NOT NULL,
    created_by text NOT NULL,
    created_in_scope text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source text DEFAULT 'live'::text NOT NULL
);

CREATE TABLE idempotency (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE individual_model_auth_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE interactive_fast_mode_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE items (
    tenant_id uuid NOT NULL,
    session_id text NOT NULL,
    seq bigint NOT NULL,
    turn_id uuid,
    kind item_kind NOT NULL,
    author text,
    call_id text,
    elicit_id text,
    wake_cause wake_cause,
    error_code text,
    text text,
    tool text,
    step integer,
    variant text,
    is_error boolean,
    hidden boolean,
    external_id text,
    through_seq bigint,
    target_seq bigint,
    approved boolean,
    blob_sha bytea,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(text, ''::text))) STORED,
    body jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT items_approved_kind CHECK (((approved IS NULL) OR (kind = 'ElicitationResponse'::item_kind))),
    CONSTRAINT items_author_check CHECK ((author <> ''::text)),
    CONSTRAINT items_author_kind CHECK (((author IS NULL) OR (kind = ANY (ARRAY['UserMessage'::item_kind, 'SteeringMessage'::item_kind, 'ElicitationResponse'::item_kind, 'Stop'::item_kind, 'RuntimeChange'::item_kind])))),
    CONSTRAINT items_blob_sha_kind CHECK (((blob_sha IS NULL) OR (kind = 'ToolResult'::item_kind))),
    CONSTRAINT items_body_check CHECK ((jsonb_typeof(body) = 'object'::text)),
    CONSTRAINT items_call_id_check CHECK ((call_id <> ''::text)),
    CONSTRAINT items_call_id_kind CHECK (((call_id IS NULL) OR (kind = ANY (ARRAY['ToolCall'::item_kind, 'ToolResult'::item_kind])))),
    CONSTRAINT items_elicit_id_check CHECK ((elicit_id <> ''::text)),
    CONSTRAINT items_elicit_id_kind CHECK (((elicit_id IS NOT NULL) = (kind = ANY (ARRAY['Elicitation'::item_kind, 'ElicitationResponse'::item_kind])))),
    CONSTRAINT items_error_code_check CHECK ((error_code <> ''::text)),
    CONSTRAINT items_error_code_kind CHECK (((error_code IS NOT NULL) = (kind = 'Error'::item_kind))),
    CONSTRAINT items_external_id_check CHECK ((external_id <> ''::text)),
    CONSTRAINT items_external_id_kind CHECK (((external_id IS NULL) OR (kind = 'UserMessage'::item_kind))),
    CONSTRAINT items_hidden_kind CHECK (((hidden IS NULL) OR (kind = 'UserMessage'::item_kind))),
    CONSTRAINT items_is_error_kind CHECK (((is_error IS NULL) OR (kind = 'ToolResult'::item_kind))),
    CONSTRAINT items_seq_check CHECK ((seq >= 0)),
    CONSTRAINT items_step_check CHECK ((step >= 0)),
    CONSTRAINT items_step_kind CHECK (((step IS NULL) OR (kind = ANY (ARRAY['ToolCall'::item_kind, 'ToolResult'::item_kind, 'Reasoning'::item_kind, 'AgentMessage'::item_kind])))),
    CONSTRAINT items_target_seq_kind CHECK (((target_seq IS NULL) OR (kind = 'Retraction'::item_kind))),
    CONSTRAINT items_text_check CHECK ((text <> ''::text)),
    CONSTRAINT items_text_kind CHECK (((text IS NULL) OR (kind = ANY (ARRAY['UserMessage'::item_kind, 'SteeringMessage'::item_kind, 'AgentMessage'::item_kind, 'Reasoning'::item_kind, 'ToolResult'::item_kind, 'Error'::item_kind, 'ContextCompaction'::item_kind])))),
    CONSTRAINT items_through_seq_kind CHECK (((through_seq IS NULL) OR (kind = 'ContextCompaction'::item_kind))),
    CONSTRAINT items_tool_check CHECK ((tool <> ''::text)),
    CONSTRAINT items_tool_kind CHECK (((tool IS NULL) OR (kind = ANY (ARRAY['ToolCall'::item_kind, 'ToolResult'::item_kind])))),
    CONSTRAINT items_variant_check CHECK ((variant = ANY (ARRAY['narration'::text, 'files_delivered'::text]))),
    CONSTRAINT items_variant_kind CHECK (((variant IS NULL) OR (kind = 'AgentMessage'::item_kind))),
    CONSTRAINT items_wake_cause_kind CHECK (((wake_cause IS NOT NULL) = (kind = 'Wake'::item_kind)))
);

CREATE TABLE keychain_asks (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE keychain_credentials (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE keychain_grants (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE llm_prompt_envelopes (
    hash text NOT NULL,
    body text NOT NULL,
    created_at bigint NOT NULL
);

CREATE TABLE loops (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE mcp_servers (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE memory_facts (
    id bigint NOT NULL,
    scope_id text NOT NULL,
    text text NOT NULL,
    sensitivity text NOT NULL,
    sources text[] DEFAULT '{}'::text[] NOT NULL,
    source_unknown boolean NOT NULL,
    author text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint
);

CREATE SEQUENCE memory_facts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE memory_facts_id_seq OWNED BY memory_facts.id;

CREATE TABLE memory_tidy_profiles (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE modal_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE model_credentials (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE monitors (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE oauth_flows (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE org_ambient_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE participants (
    session_id text NOT NULL,
    principal_id text NOT NULL,
    valid_from bigint NOT NULL,
    valid_to bigint,
    valid_from_seq integer,
    valid_to_seq integer,
    title text,
    archived boolean DEFAULT false NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    color text,
    read_at bigint
);

CREATE TABLE principal_links (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE process_sessions (
    process_id text NOT NULL,
    scope_id text NOT NULL,
    kind text NOT NULL,
    command text NOT NULL,
    started_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    status text NOT NULL,
    session_ref text,
    run_id text,
    sandbox_id text,
    purpose text,
    credential_files jsonb
);

CREATE TABLE projects (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE qm_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE qm_tenant (
    id uuid NOT NULL
);

CREATE TABLE rate_limit_windows (
    principal_id text NOT NULL,
    window_start bigint NOT NULL,
    count integer NOT NULL
);

CREATE TABLE run_activity (
    id bigint NOT NULL,
    run_id text NOT NULL,
    seq bigint NOT NULL,
    parent_seq bigint,
    type text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL
);

CREATE SEQUENCE run_activity_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE run_activity_id_seq OWNED BY run_activity.id;

CREATE TABLE run_signals (
    id bigint NOT NULL,
    run_id text NOT NULL,
    kind text NOT NULL,
    text text,
    payload jsonb,
    created_at bigint NOT NULL,
    consumed_at bigint,
    dedupe_key text
);

CREATE SEQUENCE run_signals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE run_signals_id_seq OWNED BY run_signals.id;

CREATE TABLE runs (
    id text NOT NULL,
    session_id text NOT NULL,
    status text NOT NULL,
    request text NOT NULL,
    result text,
    idempotency_key text,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    lease_token text,
    lease_expires_at bigint,
    worker_id text,
    created_at bigint NOT NULL,
    started_at bigint,
    finished_at bigint,
    delivery_state text,
    error_attempts integer DEFAULT 0 NOT NULL,
    seq bigint NOT NULL,
    turn_user_seq bigint,
    retry_after bigint DEFAULT 0 NOT NULL,
    returned_at bigint,
    last_stop text,
    claim_priority smallint DEFAULT 2 NOT NULL,
    preemptions integer DEFAULT 0 NOT NULL
);

CREATE SEQUENCE runs_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE runs_seq_seq OWNED BY runs.seq;

CREATE TABLE sandbox_defaults (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE sandbox_resources (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE secret_drops (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE security_postures (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE session_goals (
    session_id text NOT NULL,
    objective text NOT NULL,
    status text NOT NULL,
    floor jsonb,
    token_cap bigint,
    tokens_used bigint DEFAULT 0 NOT NULL,
    active_ms bigint,
    active_since timestamp with time zone,
    completion_note text,
    cancel_note text,
    governor jsonb,
    pause_reason text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT session_goals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'complete'::text, 'cancelled'::text])))
);

CREATE TABLE session_leases (
    session_id text NOT NULL,
    token text NOT NULL,
    expires_at bigint NOT NULL,
    holder text,
    acquired_at bigint
);

CREATE TABLE session_llm_requests (
    id text NOT NULL,
    session_id text NOT NULL,
    turn_seq integer,
    step integer NOT NULL,
    model text NOT NULL,
    scope_label text NOT NULL,
    truncated boolean DEFAULT false NOT NULL,
    created_at bigint NOT NULL,
    ttft_ms integer,
    duration_ms integer,
    step_gap_ms integer,
    tool_wall_json text,
    usage_json text,
    transport_json text,
    gap_phases_json text,
    prompt_hash text
);

CREATE TABLE session_mailbox (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE session_pins (
    id text NOT NULL,
    session_id text NOT NULL,
    text text,
    entry_seq integer,
    added_by text NOT NULL,
    created_at bigint NOT NULL
);

CREATE TABLE session_shares (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE session_spend_days (
    day bigint NOT NULL,
    rows jsonb NOT NULL,
    updated_at bigint NOT NULL
);

CREATE TABLE session_spend_dirty (
    day bigint,
    session_id text,
    writer xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT session_spend_dirty_check CHECK ((num_nonnulls(day, session_id) = 1))
);

CREATE TABLE sessions (
    id text NOT NULL,
    type text NOT NULL,
    scope_id text NOT NULL,
    thread_ref text NOT NULL,
    created_at bigint NOT NULL,
    title text,
    channel_name text,
    surface text,
    last_activity bigint,
    messages integer,
    turns integer,
    forked_from_session_id text,
    forked_from_title text,
    fork_boundary_seq integer,
    origin text,
    origin_id text,
    parent_session_id text,
    spawn_meta text,
    first_user_preview text,
    last_user_preview text,
    client_tools jsonb,
    last_user_activity bigint
)
WITH (fillfactor='70');

CREATE TABLE sharing_postures (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE skill_bundles (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE skill_packs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE skills (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_accounts (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_emoji_catalog (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_installation (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_session_status (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_staged_envelopes (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE slack_task_acknowledgements (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE soul_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE soul_history (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE source_auth_replay (
    event_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE suggested_activity_profiles (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE superserve_config_epochs (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE superserve_sandbox_bodies (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE team_members (
    team_id text NOT NULL,
    principal_id text NOT NULL,
    role text NOT NULL,
    added_by text NOT NULL,
    added_at bigint NOT NULL,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))
);

CREATE TABLE team_rooms (
    team_id text NOT NULL,
    scope_id text NOT NULL
);

CREATE TABLE teams (
    team_id text NOT NULL,
    name text NOT NULL,
    isolated_in_open boolean DEFAULT false NOT NULL,
    created_by text NOT NULL,
    created_at bigint NOT NULL
);

CREATE TABLE tool_calls (
    run_id text NOT NULL,
    attempt integer DEFAULT 1 NOT NULL,
    call_index integer NOT NULL,
    output text NOT NULL,
    created_at bigint NOT NULL
);

CREATE TABLE unfulfilled_insights_flag (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE web_ui_state (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE webhook_history (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE webhooks (
    id text NOT NULL,
    json jsonb NOT NULL
);

CREATE TABLE webui_model_configs (
    id text NOT NULL,
    json jsonb NOT NULL
);

ALTER TABLE ONLY ack_emoji_picks ALTER COLUMN id SET DEFAULT nextval('ack_emoji_picks_id_seq'::regclass);

ALTER TABLE ONLY ambient_judgments ALTER COLUMN id SET DEFAULT nextval('ambient_judgments_id_seq'::regclass);

ALTER TABLE ONLY audit_log ALTER COLUMN id SET DEFAULT nextval('audit_log_id_seq'::regclass);

ALTER TABLE ONLY channel_policy_history ALTER COLUMN id SET DEFAULT nextval('channel_policy_history_id_seq'::regclass);

ALTER TABLE ONLY credential_usage ALTER COLUMN id SET DEFAULT nextval('credential_usage_id_seq'::regclass);

ALTER TABLE ONLY egress_events ALTER COLUMN id SET DEFAULT nextval('egress_events_id_seq'::regclass);

ALTER TABLE ONLY error_events ALTER COLUMN id SET DEFAULT nextval('error_events_id_seq'::regclass);

ALTER TABLE ONLY memory_facts ALTER COLUMN id SET DEFAULT nextval('memory_facts_id_seq'::regclass);

ALTER TABLE ONLY run_activity ALTER COLUMN id SET DEFAULT nextval('run_activity_id_seq'::regclass);

ALTER TABLE ONLY run_signals ALTER COLUMN id SET DEFAULT nextval('run_signals_id_seq'::regclass);

ALTER TABLE ONLY runs ALTER COLUMN seq SET DEFAULT nextval('runs_seq_seq'::regclass);

ALTER TABLE ONLY ack_emoji_picks
    ADD CONSTRAINT ack_emoji_picks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ack_emoji
    ADD CONSTRAINT ack_emoji_pkey PRIMARY KEY (id);

ALTER TABLE ONLY acl_grants
    ADD CONSTRAINT acl_grants_pkey PRIMARY KEY (owner_scope_id, path, grantee_scope_id, permission);

ALTER TABLE ONLY acl_grants_version
    ADD CONSTRAINT acl_grants_version_pkey PRIMARY KEY (only_row);

ALTER TABLE ONLY admin_grants
    ADD CONSTRAINT admin_grants_pkey PRIMARY KEY (principal_id, scope_id, role);

ALTER TABLE ONLY ambient_cursors
    ADD CONSTRAINT ambient_cursors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ambient_judgments
    ADD CONSTRAINT ambient_judgments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approval_grant_modes
    ADD CONSTRAINT approval_grant_modes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approval_grants
    ADD CONSTRAINT approval_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_broker_sessions
    ADD CONSTRAINT auth_broker_sessions_pkey PRIMARY KEY (token_hash);

ALTER TABLE ONLY auto_flagger_configs
    ADD CONSTRAINT auto_flagger_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY aws_sandbox_bodies
    ADD CONSTRAINT aws_sandbox_bodies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY base_model_configs
    ADD CONSTRAINT base_model_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (tenant_id, sha256);

ALTER TABLE ONLY branding_configs
    ADD CONSTRAINT branding_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browse_max_steps_configs
    ADD CONSTRAINT browse_max_steps_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browse_model_configs
    ADD CONSTRAINT browse_model_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY channel_files
    ADD CONSTRAINT channel_files_pkey PRIMARY KEY (org_id, container, ts, file_id);

ALTER TABLE ONLY channel_header_pin_flag
    ADD CONSTRAINT channel_header_pin_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY channel_messages
    ADD CONSTRAINT channel_messages_pkey PRIMARY KEY (org_id, container, ts);

ALTER TABLE ONLY channel_policy_history
    ADD CONSTRAINT channel_policy_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY channel_policy
    ADD CONSTRAINT channel_policy_pkey PRIMARY KEY (org_id, container);

ALTER TABLE ONLY channel_state
    ADD CONSTRAINT channel_state_pkey PRIMARY KEY (org_id, container);

ALTER TABLE ONLY command_policies
    ADD CONSTRAINT command_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY composio_returns
    ADD CONSTRAINT composio_returns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connector_clients
    ADD CONSTRAINT connector_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY connector_status
    ADD CONSTRAINT connector_status_pkey PRIMARY KEY (id);

ALTER TABLE ONLY consent_links
    ADD CONSTRAINT consent_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY context_requests
    ADD CONSTRAINT context_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY credential_daily_calls
    ADD CONSTRAINT credential_daily_calls_pkey PRIMARY KEY (slug, day);

ALTER TABLE ONLY credential_usage
    ADD CONSTRAINT credential_usage_pkey PRIMARY KEY (id);

ALTER TABLE ONLY cron_fires
    ADD CONSTRAINT cron_fires_pkey PRIMARY KEY (cron_id, fire_key);

ALTER TABLE ONLY crons
    ADD CONSTRAINT crons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY custom_model_providers
    ADD CONSTRAINT custom_model_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deactivated_principals
    ADD CONSTRAINT deactivated_principals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY decision_providers
    ADD CONSTRAINT decision_providers_pkey PRIMARY KEY (provider_id);

ALTER TABLE ONLY decision_rules
    ADD CONSTRAINT decision_rules_pkey PRIMARY KEY (rule_id);

ALTER TABLE ONLY deploy_git_repos
    ADD CONSTRAINT deploy_git_repos_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_access
    ADD CONSTRAINT deployment_access_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_identity
    ADD CONSTRAINT deployment_identity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployment_layer
    ADD CONSTRAINT deployment_layer_pkey PRIMARY KEY (id);

ALTER TABLE ONLY deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY directory_channel_members
    ADD CONSTRAINT directory_channel_members_pkey PRIMARY KEY (org_id, channel_id, principal_id);

ALTER TABLE ONLY directory_channels
    ADD CONSTRAINT directory_channels_pkey PRIMARY KEY (org_id, channel_id);

ALTER TABLE ONLY directory_group_members
    ADD CONSTRAINT directory_group_members_pkey PRIMARY KEY (org_id, group_id, principal_id);

ALTER TABLE ONLY directory_groups
    ADD CONSTRAINT directory_groups_pkey PRIMARY KEY (org_id, group_id);

ALTER TABLE ONLY directory_members
    ADD CONSTRAINT directory_members_pkey PRIMARY KEY (org_id, principal_id);

ALTER TABLE ONLY directory_meta
    ADD CONSTRAINT directory_meta_pkey PRIMARY KEY (org_id);

ALTER TABLE ONLY directory_sync
    ADD CONSTRAINT directory_sync_pkey PRIMARY KEY (org_id);

ALTER TABLE ONLY durable_map_versions
    ADD CONSTRAINT durable_map_versions_pkey PRIMARY KEY (tbl);

ALTER TABLE ONLY e2b_sandbox_bodies
    ADD CONSTRAINT e2b_sandbox_bodies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY egress_events
    ADD CONSTRAINT egress_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY egress_policies
    ADD CONSTRAINT egress_policies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY environment_attachments
    ADD CONSTRAINT environment_attachments_pkey PRIMARY KEY (scope_id);

ALTER TABLE ONLY environments
    ADD CONSTRAINT environments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY error_events
    ADD CONSTRAINT error_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_members
    ADD CONSTRAINT external_members_pkey PRIMARY KEY (id);

ALTER TABLE ONLY external_slack_participants_flag
    ADD CONSTRAINT external_slack_participants_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY feature_flags
    ADD CONSTRAINT feature_flags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY file_artifact_deletions
    ADD CONSTRAINT file_artifact_deletions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY file_artifacts
    ADD CONSTRAINT file_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY idempotency
    ADD CONSTRAINT idempotency_pkey PRIMARY KEY (id);

ALTER TABLE ONLY individual_model_auth_flag
    ADD CONSTRAINT individual_model_auth_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY interactive_fast_mode_flag
    ADD CONSTRAINT interactive_fast_mode_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY items
    ADD CONSTRAINT items_pkey PRIMARY KEY (tenant_id, session_id, seq);

ALTER TABLE ONLY keychain_asks
    ADD CONSTRAINT keychain_asks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY keychain_credentials
    ADD CONSTRAINT keychain_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY keychain_grants
    ADD CONSTRAINT keychain_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY llm_prompt_envelopes
    ADD CONSTRAINT llm_prompt_envelopes_pkey PRIMARY KEY (hash);

ALTER TABLE ONLY loops
    ADD CONSTRAINT loops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_facts
    ADD CONSTRAINT memory_facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY memory_tidy_profiles
    ADD CONSTRAINT memory_tidy_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY modal_sandbox_bodies
    ADD CONSTRAINT modal_sandbox_bodies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY model_credentials
    ADD CONSTRAINT model_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY monitors
    ADD CONSTRAINT monitors_pkey PRIMARY KEY (id);

ALTER TABLE ONLY oauth_flows
    ADD CONSTRAINT oauth_flows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY org_ambient_flag
    ADD CONSTRAINT org_ambient_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY participants
    ADD CONSTRAINT participants_pkey PRIMARY KEY (session_id, principal_id);

ALTER TABLE ONLY principal_links
    ADD CONSTRAINT principal_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY process_sessions
    ADD CONSTRAINT process_sessions_pkey PRIMARY KEY (process_id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY qm_settings
    ADD CONSTRAINT qm_settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY qm_tenant
    ADD CONSTRAINT qm_tenant_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rate_limit_windows
    ADD CONSTRAINT rate_limit_windows_pkey PRIMARY KEY (principal_id);

ALTER TABLE ONLY run_activity
    ADD CONSTRAINT run_activity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY run_signals
    ADD CONSTRAINT run_signals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_idempotency_key_key UNIQUE (idempotency_key);

ALTER TABLE ONLY runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_defaults
    ADD CONSTRAINT sandbox_defaults_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sandbox_resources
    ADD CONSTRAINT sandbox_resources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY secret_drops
    ADD CONSTRAINT secret_drops_pkey PRIMARY KEY (id);

ALTER TABLE ONLY security_postures
    ADD CONSTRAINT security_postures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY session_leases
    ADD CONSTRAINT session_leases_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY session_llm_requests
    ADD CONSTRAINT session_llm_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_mailbox
    ADD CONSTRAINT session_mailbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_pins
    ADD CONSTRAINT session_pins_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_shares
    ADD CONSTRAINT session_shares_pkey PRIMARY KEY (id);

ALTER TABLE ONLY session_spend_days
    ADD CONSTRAINT session_spend_days_pkey PRIMARY KEY (day);

ALTER TABLE ONLY session_spend_dirty
    ADD CONSTRAINT session_spend_dirty_day_writer_key UNIQUE (day, writer);

ALTER TABLE sessions
    ADD CONSTRAINT sessions_fork_provenance_pair CHECK (((forked_from_session_id IS NULL) = (fork_boundary_seq IS NULL))) NOT VALID;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_thread_ref_key UNIQUE (thread_ref);

ALTER TABLE ONLY sharing_postures
    ADD CONSTRAINT sharing_postures_pkey PRIMARY KEY (id);

ALTER TABLE ONLY skill_bundles
    ADD CONSTRAINT skill_bundles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY skill_packs
    ADD CONSTRAINT skill_packs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY skills
    ADD CONSTRAINT skills_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_accounts
    ADD CONSTRAINT slack_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_emoji_catalog
    ADD CONSTRAINT slack_emoji_catalog_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_installation
    ADD CONSTRAINT slack_installation_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_session_status
    ADD CONSTRAINT slack_session_status_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_staged_envelopes
    ADD CONSTRAINT slack_staged_envelopes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY slack_task_acknowledgements
    ADD CONSTRAINT slack_task_acknowledgements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY soul_configs
    ADD CONSTRAINT soul_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY soul_history
    ADD CONSTRAINT soul_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY source_auth_replay
    ADD CONSTRAINT source_auth_replay_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY suggested_activity_profiles
    ADD CONSTRAINT suggested_activity_profiles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY superserve_config_epochs
    ADD CONSTRAINT superserve_config_epochs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY superserve_sandbox_bodies
    ADD CONSTRAINT superserve_sandbox_bodies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (team_id, principal_id);

ALTER TABLE ONLY team_rooms
    ADD CONSTRAINT team_rooms_pkey PRIMARY KEY (team_id, scope_id);

ALTER TABLE ONLY teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (team_id);

ALTER TABLE ONLY tool_calls
    ADD CONSTRAINT tool_calls_pkey PRIMARY KEY (run_id, attempt, call_index);

ALTER TABLE ONLY unfulfilled_insights_flag
    ADD CONSTRAINT unfulfilled_insights_flag_pkey PRIMARY KEY (id);

ALTER TABLE ONLY web_ui_state
    ADD CONSTRAINT web_ui_state_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhook_history
    ADD CONSTRAINT webhook_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webhooks
    ADD CONSTRAINT webhooks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY webui_model_configs
    ADD CONSTRAINT webui_model_configs_pkey PRIMARY KEY (id);

CREATE INDEX ack_emoji_picks_org_channel_created ON ack_emoji_picks USING btree (org_id, channel, created_at DESC);

CREATE INDEX ack_emoji_picks_org_created ON ack_emoji_picks USING btree (org_id, created_at DESC, id DESC);

CREATE INDEX ack_emoji_picks_org_outcome ON ack_emoji_picks USING btree (org_id, outcome);

CREATE INDEX ambient_judgments_org_container_created ON ambient_judgments USING btree (org_id, container, created_at DESC);

CREATE INDEX ambient_judgments_org_created ON ambient_judgments USING btree (org_id, created_at DESC, id DESC);

CREATE INDEX ambient_judgments_org_decision ON ambient_judgments USING btree (org_id, decision);

CREATE INDEX approvals_sessionid_fold ON approvals USING hash (lower((json ->> 'sessionId'::text)));

CREATE INDEX approvals_sessionid_unicode ON approvals USING btree (id) WHERE ((json ->> 'sessionId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX audit_log_by_action ON audit_log USING btree (action, at DESC);

CREATE INDEX audit_log_by_at ON audit_log USING btree (at DESC);

CREATE UNIQUE INDEX audit_log_by_idempotency_key ON audit_log USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);

CREATE INDEX audit_log_by_scope_at ON audit_log USING btree (scope_label, at DESC);

CREATE INDEX auth_broker_sessions_email ON auth_broker_sessions USING btree (email);

CREATE INDEX auth_broker_sessions_expiry ON auth_broker_sessions USING btree (expires_at);

CREATE INDEX channel_messages_by_container ON channel_messages USING btree (org_id, container, ts);

CREATE INDEX channel_messages_by_sub ON channel_messages USING btree (org_id, container, sub, ts);

CREATE INDEX channel_messages_deleted_by_container ON channel_messages USING btree (org_id, container, deleted_at) WHERE (deleted_at > 0);

CREATE INDEX channel_messages_edited_by_container ON channel_messages USING btree (org_id, container, edited_at) WHERE (edited_at > 0);

CREATE INDEX channel_messages_live_by_container ON channel_messages USING btree (org_id, container) WHERE (deleted = false);

CREATE INDEX channel_messages_tsv ON channel_messages USING gin (tsv);

CREATE INDEX channel_policy_history_container ON channel_policy_history USING btree (org_id, container, id DESC);

CREATE INDEX credential_usage_by_scope_ts ON credential_usage USING btree (scope_label, ts DESC);

CREATE INDEX credential_usage_by_slug_ts_id ON credential_usage USING btree (slug, ts DESC, id DESC);

CREATE INDEX credential_usage_by_ts ON credential_usage USING btree (ts DESC);

CREATE INDEX crons_resource_search_gin ON crons USING gin (to_tsvector('simple'::regconfig, ((((COALESCE((json ->> 'title'::text), ''::text) || ' '::text) || COALESCE((json ->> 'action'::text), ''::text)) || ' '::text) || COALESCE((json ->> 'message'::text), ''::text))));

CREATE INDEX decision_rules_hook ON decision_rules USING btree (hook) WHERE (mode <> 'off'::text);

CREATE INDEX deployments_resource_search_gin ON deployments USING gin (to_tsvector('simple'::regconfig, ((COALESCE((json ->> 'displayName'::text), (json ->> 'name'::text), ''::text) || ' '::text) || COALESCE((json ->> 'name'::text), ''::text))));

CREATE INDEX directory_channels_lower_cid ON directory_channels USING btree (org_id, lower(channel_id));

CREATE INDEX directory_channels_name ON directory_channels USING btree (org_id, name_lc);

CREATE INDEX directory_group_members_principal ON directory_group_members USING btree (org_id, principal_id, group_id);

CREATE INDEX directory_members_lower_pid ON directory_members USING btree (org_id, lower(principal_id));

CREATE INDEX directory_members_name ON directory_members USING btree (org_id, display_name_lc);

CREATE INDEX egress_events_by_scope_ts ON egress_events USING btree (scope_label, ts DESC);

CREATE INDEX egress_events_by_ts ON egress_events USING btree (ts DESC);

CREATE INDEX environment_attachments_by_env ON environment_attachments USING btree (environment_id);

CREATE INDEX error_events_by_scope_ts ON error_events USING btree (scope_label, ts DESC);

CREATE INDEX error_events_by_session_ts ON error_events USING btree (session_id, ts DESC);

CREATE INDEX error_events_by_ts ON error_events USING btree (ts DESC);

CREATE INDEX file_artifacts_owner_created ON file_artifacts USING btree (owner_scope_id, created_at DESC, id DESC);

CREATE INDEX file_artifacts_owner_path ON file_artifacts USING btree (owner_scope_id, path);

CREATE INDEX file_artifacts_scope_created ON file_artifacts USING btree (created_in_scope, created_at DESC, id DESC) WHERE (enabled = true);

CREATE INDEX idx_cron_fires_cron_fired_at ON cron_fires USING btree (cron_id, fired_at DESC);

CREATE INDEX idx_cron_fires_thread_ref ON cron_fires USING btree (thread_ref);

CREATE INDEX idx_proc_scope_status ON process_sessions USING btree (scope_id, status);

CREATE INDEX idx_run_activity_created ON run_activity USING btree (created_at);

CREATE INDEX idx_run_activity_run ON run_activity USING btree (run_id, id);

CREATE INDEX idx_run_signals_pending ON run_signals USING btree (run_id) WHERE (consumed_at IS NULL);

CREATE INDEX idx_runs_created ON runs USING btree (created_at DESC);

CREATE UNIQUE INDEX idx_runs_one_running_per_session ON runs USING btree (session_id) WHERE (status = 'running'::text);

CREATE INDEX idx_runs_pending_child_returns ON runs USING btree (id) WHERE ((status = ANY (ARRAY['done'::text, 'failed'::text])) AND (returned_at IS NULL) AND (session_id ~~ 'agent:main:subagent:%'::text));

CREATE INDEX idx_runs_pending_priority ON runs USING btree (claim_priority, created_at, seq) WHERE (status = 'pending'::text);

CREATE INDEX idx_runs_session_active_created ON runs USING btree (session_id, created_at DESC) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text]));

CREATE INDEX idx_runs_session_created_seq ON runs USING btree (session_id, created_at DESC, seq DESC);

CREATE INDEX idx_runs_status_created ON runs USING btree (status, created_at);

CREATE INDEX idx_runs_status_created_seq ON runs USING btree (status, created_at, seq);

CREATE INDEX idx_runs_terminal_finished ON runs USING btree (finished_at, id) WHERE (status = ANY (ARRAY['done'::text, 'failed'::text]));

CREATE INDEX idx_sessions_parent_session_id ON sessions USING btree (parent_session_id) WHERE (parent_session_id IS NOT NULL);

CREATE INDEX items_by_elicit ON items USING btree (tenant_id, session_id, elicit_id) WHERE (elicit_id IS NOT NULL);

CREATE INDEX items_by_external_id ON items USING btree (tenant_id, session_id, external_id) WHERE (external_id IS NOT NULL);

CREATE INDEX items_by_turn ON items USING btree (tenant_id, turn_id, seq) WHERE (turn_id IS NOT NULL);

CREATE UNIQUE INDEX items_one_call_per_kind ON items USING btree (tenant_id, session_id, kind, md5(call_id)) WHERE (call_id IS NOT NULL);

CREATE INDEX items_search ON items USING gin (tenant_id, session_id, search);

CREATE INDEX items_session_kind_created ON items USING btree (tenant_id, session_id, kind, created_at);

CREATE INDEX keychain_credentials_ownerid_fold ON keychain_credentials USING hash (lower((json ->> 'ownerId'::text)));

CREATE INDEX keychain_credentials_ownerid_unicode ON keychain_credentials USING btree (id) WHERE ((json ->> 'ownerId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX keychain_grants_ownerid_fold ON keychain_grants USING hash (lower((json ->> 'ownerId'::text)));

CREATE INDEX keychain_grants_ownerid_unicode ON keychain_grants USING btree (id) WHERE ((json ->> 'ownerId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX llm_prompt_envelopes_created_at ON llm_prompt_envelopes USING btree (created_at);

CREATE INDEX memory_facts_live ON memory_facts USING btree (scope_id, id) WHERE (deleted_at IS NULL);

CREATE INDEX participants_by_principal ON participants USING btree (principal_id, session_id);

CREATE UNIQUE INDEX qm_tenant_singleton ON qm_tenant USING btree ((true));

CREATE UNIQUE INDEX run_signals_by_dedupe_key ON run_signals USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);

CREATE INDEX session_llm_requests_by_session ON session_llm_requests USING btree (session_id, created_at, step);

CREATE INDEX session_llm_requests_created_at ON session_llm_requests USING btree (created_at);

CREATE INDEX session_llm_requests_screens ON session_llm_requests USING btree (created_at DESC) WHERE (step = '-1'::integer);

CREATE INDEX session_llm_requests_spend ON session_llm_requests USING btree (created_at, (((spend_usage_json(usage_json) ->> 'costUsd'::text))::double precision), (((spend_usage_json(usage_json) ->> 'input'::text))::bigint), (((spend_usage_json(usage_json) ->> 'output'::text))::bigint), (((spend_usage_json(usage_json) ->> 'cacheRead'::text))::bigint), (((spend_usage_json(usage_json) ->> 'cacheWrite'::text))::bigint)) INCLUDE (session_id, model, usage_json) WHERE ((usage_json IS NOT NULL) AND ((spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000)));

CREATE INDEX session_llm_requests_spend_wide ON session_llm_requests USING btree (created_at) WHERE ((usage_json IS NOT NULL) AND (NOT ((spend_usage_json(usage_json) IS NOT NULL) AND (((octet_length(session_id) + octet_length(model)) + octet_length(usage_json)) <= 2000))));

CREATE INDEX session_mailbox_recipientid_fold ON session_mailbox USING hash (lower((json ->> 'recipientId'::text)));

CREATE INDEX session_mailbox_recipientid_unicode ON session_mailbox USING btree (id) WHERE ((json ->> 'recipientId'::text) ~ '[^\x01-\x7f]'::text);

CREATE INDEX session_pins_by_session ON session_pins USING btree (session_id, created_at);

CREATE INDEX sessions_by_activity ON sessions USING btree (COALESCE(last_activity, created_at) DESC, id DESC);

CREATE INDEX sessions_by_scope ON sessions USING btree (scope_id, created_at DESC);

CREATE INDEX sessions_by_scope_activity ON sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC);

CREATE INDEX sessions_conversations_by_scope_activity ON sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin = 'conversation'::text);

CREATE INDEX sessions_other_background_by_scope_activity ON sessions USING btree (scope_id, COALESCE(last_activity, created_at) DESC, id DESC) WHERE (origin <> ALL (ARRAY['conversation'::text, 'cron'::text]));

CREATE INDEX skills_resource_name_idx ON skills USING btree ((((json -> 'manifest'::text) ->> 'name'::text)));

CREATE INDEX skills_resource_search_gin ON skills USING gin (to_tsvector('simple'::regconfig, ((COALESCE(((json -> 'manifest'::text) ->> 'name'::text), ''::text) || ' '::text) || COALESCE(((json -> 'manifest'::text) ->> 'description'::text), ''::text))));

CREATE INDEX source_auth_replay_expires_at ON source_auth_replay USING btree (expires_at);

CREATE INDEX team_members_principal ON team_members USING btree (principal_id);

CREATE INDEX team_rooms_scope ON team_rooms USING btree (scope_id);

CREATE INDEX webhooks_resource_search_gin ON webhooks USING gin (to_tsvector('simple'::regconfig, ((COALESCE((json ->> 'action'::text), ''::text) || ' '::text) || COALESCE(((json -> 'verification'::text) ->> 'scheme'::text), ''::text))));

CREATE STATISTICS approvals_sessionid_stats ON (json ->> 'sessionId'::text) FROM approvals;

CREATE STATISTICS keychain_credentials_ownerid_stats ON (json ->> 'ownerId'::text) FROM keychain_credentials;

CREATE STATISTICS keychain_grants_ownerid_stats ON (json ->> 'ownerId'::text) FROM keychain_grants;

CREATE STATISTICS session_mailbox_recipientid_stats ON (json ->> 'recipientId'::text) FROM session_mailbox;

CREATE TRIGGER acl_grants_bump AFTER INSERT OR DELETE OR UPDATE OR TRUNCATE ON acl_grants FOR EACH STATEMENT EXECUTE FUNCTION acl_grants_bump_version();

CREATE TRIGGER blobs_immutable BEFORE DELETE OR UPDATE ON blobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON blobs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER items_append_only BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER items_delete_through_session BEFORE DELETE ON items FOR EACH ROW EXECUTE FUNCTION forbid_direct_delete();

CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER session_llm_requests_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF created_at, session_id, model, usage_json ON session_llm_requests FOR EACH ROW EXECUTE FUNCTION invalidate_request_spend();

CREATE TRIGGER sessions_spend_dirty AFTER INSERT OR DELETE OR UPDATE OF id, scope_id, origin, thread_ref, parent_session_id ON sessions FOR EACH ROW EXECUTE FUNCTION invalidate_session_spend();

ALTER TABLE ONLY decision_rules
    ADD CONSTRAINT decision_rules_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES decision_providers(provider_id);

ALTER TABLE ONLY deployment_access
    ADD CONSTRAINT deployment_access_id_fkey FOREIGN KEY (id) REFERENCES deployments(id) ON DELETE CASCADE;

ALTER TABLE ONLY environment_attachments
    ADD CONSTRAINT environment_attachments_environment_id_fkey FOREIGN KEY (environment_id) REFERENCES environments(id);

ALTER TABLE ONLY items
    ADD CONSTRAINT items_blob FOREIGN KEY (tenant_id, blob_sha) REFERENCES blobs(tenant_id, sha256);

ALTER TABLE ONLY items
    ADD CONSTRAINT items_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY session_goals
    ADD CONSTRAINT session_goals_session_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE;

ALTER TABLE ONLY team_rooms
    ADD CONSTRAINT team_rooms_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE;

INSERT INTO qm_tenant(id) VALUES (gen_random_uuid());

INSERT INTO acl_grants_version(only_row, v) VALUES (TRUE, 0);
