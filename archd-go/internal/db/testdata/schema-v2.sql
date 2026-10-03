-- Written by archd at schema v2 (testdata/schemagen). Do not edit.
PRAGMA user_version = 2;
CREATE TABLE agent_actions (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		root_id       TEXT,
		branch        TEXT,
		ts            INTEGER NOT NULL,
		session_id    TEXT NOT NULL DEFAULT '',
		agent         TEXT NOT NULL DEFAULT '',
		tool          TEXT NOT NULL,
		kind          TEXT NOT NULL,            -- read|trace|write|plan|debug|narrate
		summary       TEXT NOT NULL DEFAULT '',
		targets       TEXT NOT NULL DEFAULT '[]', -- JSON canvas node IDs
		detail        TEXT NOT NULL DEFAULT '',   -- JSON, tool-specific
		duration_ms   INTEGER NOT NULL DEFAULT 0,
		status        TEXT NOT NULL DEFAULT 'ok',
		error         TEXT NOT NULL DEFAULT ''
	);
CREATE TABLE annotations (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL,
		sheet_id      TEXT REFERENCES sheets(id) ON DELETE CASCADE,
		target_type   TEXT,             -- 'system'|'file'|'infra'|NULL floating
		target_id     TEXT,
		body          TEXT NOT NULL,    -- markdown
		kind          TEXT NOT NULL DEFAULT 'note',  -- 'note'|'flag'|'decision'|'reply'
		author        TEXT NOT NULL DEFAULT 'user',  -- 'user'|'agent'
		position_x REAL, position_y REAL,
		created_at    INTEGER NOT NULL
	);
CREATE TABLE architecture_proposal_draft_chunks (
		draft_id TEXT NOT NULL REFERENCES architecture_proposal_drafts(id) ON DELETE CASCADE,
		chunk_id TEXT NOT NULL,
		ordinal INTEGER NOT NULL,
		systems_json TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY(draft_id,chunk_id),
		UNIQUE(draft_id,ordinal)
	);
CREATE TABLE architecture_proposal_drafts (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		rationale TEXT NOT NULL DEFAULT '',
		status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','committed','aborted')),
		proposal_id TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
CREATE TABLE architecture_proposal_layouts (
		proposal_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		node_type TEXT NOT NULL CHECK(node_type IN ('system','file')),
		node_key TEXT NOT NULL,
		parent_ref_type TEXT NOT NULL CHECK(parent_ref_type IN ('scope','live_system','proposed_system')),
		parent_ref_id TEXT NOT NULL DEFAULT '',
		position_x REAL NOT NULL DEFAULT 0,
		position_y REAL NOT NULL DEFAULT 0,
		width REAL NOT NULL,
		height REAL NOT NULL,
		scale REAL NOT NULL DEFAULT 1 CHECK(scale > 0),
		interior_scale REAL NOT NULL DEFAULT 1 CHECK(interior_scale > 0),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY(proposal_id, revision, node_type, node_key),
		FOREIGN KEY(proposal_id, revision) REFERENCES architecture_proposal_rounds(proposal_id, revision) ON DELETE CASCADE
	);
CREATE TABLE architecture_proposal_memberships (
		id TEXT PRIMARY KEY,
		proposal_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
		root_id TEXT NOT NULL DEFAULT '',
		file_path TEXT NOT NULL,
		target_system_key TEXT NOT NULL DEFAULT '',
		disposition TEXT NOT NULL CHECK(disposition IN ('assign','retain','unassigned','excluded')),
		rationale TEXT NOT NULL DEFAULT '',
		FOREIGN KEY(proposal_id, revision) REFERENCES architecture_proposal_rounds(proposal_id, revision) ON DELETE CASCADE,
		UNIQUE(proposal_id, revision, file_path),
		-- file_id may become NULL: deleting a file keeps the proposal's record
		-- of it by path. See migrateProposalMembershipDeletes.
		CHECK(disposition != 'assign' OR length(target_system_key) > 0)
	);
CREATE TABLE architecture_proposal_rounds (
		proposal_id TEXT NOT NULL REFERENCES architecture_proposals(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL CHECK(revision > 0),
		rationale TEXT NOT NULL DEFAULT '',
		evidence_summary TEXT NOT NULL DEFAULT '',
		coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial','no_change')),
		created_by TEXT NOT NULL DEFAULT 'agent',
		created_at INTEGER NOT NULL,
		PRIMARY KEY(proposal_id, revision)
	);
CREATE TABLE architecture_proposal_systems (
		proposal_id TEXT NOT NULL,
		revision INTEGER NOT NULL,
		system_key TEXT NOT NULL,
		name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		parent_ref_type TEXT NOT NULL CHECK(parent_ref_type IN ('scope','live_system','proposed_system')),
		parent_ref_id TEXT NOT NULL DEFAULT '',
		depth INTEGER NOT NULL DEFAULT 0 CHECK(depth >= 0),
		decision TEXT NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected')),
		rejection_reason TEXT NOT NULL DEFAULT '',
		decided_by TEXT NOT NULL DEFAULT '',
		decided_at INTEGER,
		materialized_system_id TEXT REFERENCES systems(id) ON DELETE SET NULL,
		PRIMARY KEY(proposal_id, revision, system_key),
		FOREIGN KEY(proposal_id, revision) REFERENCES architecture_proposal_rounds(proposal_id, revision) ON DELETE CASCADE,
		CHECK(decision != 'rejected' OR length(trim(rejection_reason)) > 0)
	);
CREATE TABLE architecture_proposals (
		id TEXT PRIMARY KEY,
		workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		root_id TEXT REFERENCES roots(id) ON DELETE SET NULL,
		parent_scope_type TEXT NOT NULL CHECK(parent_scope_type IN ('workspace','system')),
		parent_scope_id TEXT NOT NULL DEFAULT '',
		current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision > 0),
		created_by TEXT NOT NULL DEFAULT 'agent',
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
CREATE TABLE call_graph (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		caller_file   TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		caller_symbol TEXT NOT NULL,
		callee_file   TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		callee_symbol TEXT NOT NULL,
		call_count    INTEGER NOT NULL DEFAULT 1
	);
CREATE TABLE canvas_claims (
 message_id TEXT PRIMARY KEY REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 owner TEXT NOT NULL, agent TEXT NOT NULL, token TEXT NOT NULL,
 expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts>0)
 );
CREATE TABLE canvas_outbox (
		id             TEXT PRIMARY KEY,
		workspace_id   TEXT NOT NULL,
		sheet_id       TEXT,
		note           TEXT NOT NULL,
		selection      TEXT NOT NULL DEFAULT '[]',  -- json durable refs
		change_summary TEXT NOT NULL DEFAULT '',    -- 12-verb semantic summary
		sheet_context  TEXT NOT NULL DEFAULT '',    -- immutable JSON snapshot resolved against the live Floor
		build_spec     TEXT NOT NULL DEFAULT '',    -- approved planned increment at send time
		status         TEXT NOT NULL DEFAULT 'queued', -- 'queued'|'delivered'|'answered'|'cancelled'
		delivered_to   TEXT,
		answer_annotation_id TEXT,
		created_at INTEGER NOT NULL, delivered_at INTEGER, answered_at INTEGER
	, delivery_mode TEXT NOT NULL DEFAULT 'open');
CREATE TABLE canvas_replies (
 message_id TEXT PRIMARY KEY REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 body TEXT NOT NULL CHECK(length(trim(body))>0), agent TEXT NOT NULL,
 token TEXT NOT NULL, created_at INTEGER NOT NULL
 , result_json TEXT NOT NULL DEFAULT '');
CREATE TABLE canvas_reply_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id TEXT NOT NULL REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 body TEXT NOT NULL, agent TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
 );
CREATE TABLE canvas_review_events (
 id TEXT PRIMARY KEY,
 message_id TEXT NOT NULL REFERENCES canvas_outbox(id) ON DELETE CASCADE,
 decision TEXT NOT NULL CHECK(decision IN ('accepted','reopened')),
 note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
 );
CREATE TABLE delta_snapshots (
		workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		at           INTEGER NOT NULL,
		snapshot     TEXT NOT NULL,
		PRIMARY KEY(workspace_id, at)
	);
CREATE TABLE dependencies (
		id               TEXT PRIMARY KEY,
		workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		src              TEXT NOT NULL,
		dst              TEXT NOT NULL,
		src_type         TEXT NOT NULL,   -- 'file'|'system'|'infra'
		dst_type         TEXT NOT NULL,
		dependency_type  TEXT NOT NULL,   -- 'IMPORTS'|'CALLS'|'DEPENDS_ON'|... + infra kinds (registry.Categories)
		weight           INTEGER NOT NULL DEFAULT 1,
		created_by       TEXT NOT NULL DEFAULT 'parser',  -- 'parser'|'agent'|'user'|'runtime'
		target_item      TEXT NOT NULL DEFAULT '',        -- infra edges: the contents item (table, topic, ...) or ''
		status           TEXT NOT NULL DEFAULT 'confirmed' -- 'proposed'|'confirmed'|'dismissed'
	, evidence    TEXT);
CREATE TABLE detection_state (
		root_id           TEXT PRIMARY KEY,
		evidence_version  INTEGER NOT NULL DEFAULT 0
	);
CREATE TABLE file_activity (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		ts            INTEGER NOT NULL,               -- burst end, ms epoch
		actor         TEXT NOT NULL DEFAULT 'human',  -- 'human'|'agent'
		weight        REAL NOT NULL DEFAULT 0,        -- log10(1+dLines)+dSymbols, actor-scaled
		lines_delta   INTEGER NOT NULL DEFAULT 0,
		symbols_delta INTEGER NOT NULL DEFAULT 0
	);
CREATE TABLE file_env_reads (
		file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		name     TEXT NOT NULL,
		line     INTEGER NOT NULL
	);
CREATE TABLE file_packages (
		file_id  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		package  TEXT NOT NULL,
		line     INTEGER NOT NULL
	);
CREATE TABLE files (
		id            TEXT PRIMARY KEY,
		root_id       TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
		path          TEXT NOT NULL,                -- absolute path
		rel_path      TEXT NOT NULL,                -- relative to root
		language      TEXT NOT NULL DEFAULT 'unknown',
		system_id     TEXT REFERENCES systems(id) ON DELETE SET NULL,
		line_count    INTEGER NOT NULL DEFAULT 0,
		churn_score   REAL NOT NULL DEFAULT 0,
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		indexed_at    INTEGER NOT NULL
	, width  REAL, height REAL, shape          TEXT NOT NULL DEFAULT '', shape_override TEXT NOT NULL DEFAULT '', display_name   TEXT NOT NULL DEFAULT '', activity_score REAL    NOT NULL DEFAULT 0, activity_at    INTEGER NOT NULL DEFAULT 0, content_hash   TEXT    NOT NULL DEFAULT '');
CREATE TABLE floor_layout_revisions (
		workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL DEFAULT 0
	);
CREATE TABLE floor_layouts (
		workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		node_id           TEXT NOT NULL,
		node_type         TEXT NOT NULL CHECK(node_type IN ('system','file','infra')),
		parent_node_id    TEXT,
		parent_node_type  TEXT CHECK(parent_node_type IS NULL OR parent_node_type IN ('system','infra')),
		containment_kind  TEXT NOT NULL DEFAULT 'root' CHECK(containment_kind IN ('root','part_of','hosted_by')),
		position_x        REAL NOT NULL DEFAULT 0,
		position_y        REAL NOT NULL DEFAULT 0,
		width             REAL NOT NULL,
		height            REAL NOT NULL,
		scale             REAL NOT NULL DEFAULT 1 CHECK(scale > 0),
		-- How much this frame shrinks its CONTENTS, independent of its own size.
		-- scale answers "how big am I in my parent"; interior_scale answers
		-- "how big is everything inside me". Keeping them separate is what lets a
		-- crowded frame compress its interior without its own chrome reacting.
		interior_scale    REAL NOT NULL DEFAULT 1 CHECK(interior_scale > 0),
		updated_at        INTEGER NOT NULL,
		PRIMARY KEY(workspace_id, node_type, node_id)
	);
CREATE TABLE infra_contents (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		infra_id      TEXT NOT NULL REFERENCES infra_nodes(id) ON DELETE CASCADE,
		kind          TEXT NOT NULL,
		name          TEXT NOT NULL,
		detail        TEXT,                              -- json: columns, payload shape, ttl, cron expression, ...
		evidence      TEXT,                              -- file:line
		source        TEXT NOT NULL DEFAULT 'agent',     -- 'parser'|'agent'|'user'|'runtime'
		UNIQUE(infra_id, kind, name)
	);
CREATE TABLE infra_nodes (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		infra_type    TEXT NOT NULL DEFAULT 'custom',  -- DEPRECATED: superseded by category/provider/service
		category      TEXT NOT NULL DEFAULT 'api',     -- 'database'|'cache'|'queue'|'storage'|'search'|'llm'|'api'|'auth'|'platform'|'cdn'|'observability'|'email'
		provider      TEXT NOT NULL DEFAULT 'generic', -- 'aws'|'openai'|'stripe'|'generic'|...
		service       TEXT NOT NULL DEFAULT '',        -- registry id, e.g. 'aws/rds'; '' = unassigned generic
		subtype       TEXT NOT NULL DEFAULT '',        -- category-specific ('sql'|'document'|'kv'|'vector'|...)
		status        TEXT NOT NULL DEFAULT 'confirmed', -- 'proposed'|'confirmed'|'dismissed'
		detected_by   TEXT,                            -- json evidence [{signal, file, evidence, confidence}]
		config        TEXT,                             -- json blob (registry configFields values)
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		implementations TEXT,                           -- json [{environment, kind, ref, evidence}]
		policies        TEXT                            -- json {costs_money, external_side_effects, never_in_tests, confirm_before_running}
	);
CREATE TABLE infra_requirements (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		kind          TEXT NOT NULL DEFAULT 'env',
		name          TEXT NOT NULL,
		infra_id      TEXT REFERENCES infra_nodes(id) ON DELETE SET NULL,
		evidence      TEXT,
		present       INTEGER NOT NULL DEFAULT 0,
		source        TEXT NOT NULL DEFAULT 'parser',
		UNIQUE(workspace_id, kind, name)
	);
CREATE TABLE investigations (
		id            TEXT PRIMARY KEY,               -- short id (shareable)
		workspace_id  TEXT NOT NULL,
		name          TEXT NOT NULL DEFAULT '',
		commit_sha    TEXT NOT NULL DEFAULT '',
		branch        TEXT NOT NULL DEFAULT '',
		created_at    INTEGER NOT NULL,
		duration_ms   INTEGER NOT NULL DEFAULT 0,
		event_count   INTEGER NOT NULL DEFAULT 0,
		data          TEXT NOT NULL                   -- full AmbioTrace JSON
	, status TEXT NOT NULL DEFAULT 'saved', origin TEXT NOT NULL DEFAULT 'agent');
CREATE TABLE planned_edges (
		id           TEXT PRIMARY KEY,
		sheet_id     TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id TEXT NOT NULL,
		kind         TEXT NOT NULL DEFAULT 'DEPENDS_ON', -- 'CALLS'|'DEPENDS_ON'|'CONTAINS'
		src_planned  TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
		src_live     TEXT,   -- live node id (file/system/infra) when src is real
		dst_planned  TEXT REFERENCES planned_nodes(id) ON DELETE CASCADE,
		dst_live     TEXT,
		note         TEXT NOT NULL DEFAULT ''
	);
CREATE TABLE planned_nodes (
		id            TEXT PRIMARY KEY,
		sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id  TEXT NOT NULL,
		kind          TEXT NOT NULL DEFAULT 'class',   -- 'system'|'class'|'file'
		name          TEXT NOT NULL,
		declared_path TEXT NOT NULL DEFAULT '',        -- reconciliation hint (rel path)
		members       TEXT NOT NULL DEFAULT '[]',      -- json [{signature, intent, realized}]
		metadata      TEXT NOT NULL DEFAULT '{}',      -- versioned, kind-specific UML authoring metadata
		status        TEXT NOT NULL DEFAULT 'planned', -- 'planned'|'partial'|'realized'|'flattened'
		approval_status TEXT NOT NULL DEFAULT 'approved', -- 'pending'|'approved'|'rejected'
		realized_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
		notes         TEXT NOT NULL DEFAULT '',
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		width         REAL,
		height        REAL,
		parent_system_id TEXT,
		created_by    TEXT NOT NULL DEFAULT 'user',
		created_at    INTEGER NOT NULL
	, shape TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '', scale REAL NOT NULL DEFAULT 1);
CREATE TABLE root_delta_snapshots (
		root_id   TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
		branch    TEXT NOT NULL,
		at        INTEGER NOT NULL,
		snapshot  TEXT NOT NULL,
		PRIMARY KEY(root_id, branch, at)
	);
CREATE TABLE roots (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		path          TEXT NOT NULL,
		branch        TEXT NOT NULL DEFAULT '',
		head_commit   TEXT NOT NULL DEFAULT '',
		is_primary   INTEGER NOT NULL DEFAULT 0,
		is_active    INTEGER NOT NULL DEFAULT 1,
		indexed_at    INTEGER,
		classifier_version INTEGER NOT NULL DEFAULT 0,
		ignored_paths_json TEXT NOT NULL DEFAULT '[]',
		source_boundaries_reviewed_at INTEGER,
		delta_reviewed_at INTEGER
	);
CREATE TABLE sheet_bindings (
	 sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
	 planned_id TEXT NOT NULL REFERENCES planned_nodes(id) ON DELETE CASCADE,
	 live_id TEXT NOT NULL, node_type TEXT NOT NULL,
	 PRIMARY KEY(sheet_id,planned_id), UNIQUE(sheet_id,live_id));
CREATE TABLE sheet_elements (
		id            TEXT PRIMARY KEY,
		sheet_id      TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		system_id     TEXT REFERENCES systems(id)     ON DELETE SET NULL,
		file_id       TEXT REFERENCES files(id)       ON DELETE SET NULL,
		infra_id      TEXT REFERENCES infra_nodes(id) ON DELETE SET NULL,
		symbol_ref    TEXT,             -- 'fileId::kind::name' (symbols lack stable ids)
		label         TEXT NOT NULL,    -- display snapshot cached at add time
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		width         REAL,
		height        REAL,
		parent_system_id TEXT,
		emphasis      TEXT,             -- json {dim, accent, expandedToSymbols}
		design_metadata TEXT NOT NULL DEFAULT '{}', -- sheet-local authored design overlay for live entities
		tombstone_ack INTEGER NOT NULL DEFAULT 0,
		ghost         INTEGER NOT NULL DEFAULT 0,
		added_by      TEXT NOT NULL DEFAULT 'user', scale REAL NOT NULL DEFAULT 1,
		CHECK ((system_id IS NOT NULL) + (file_id IS NOT NULL) +
		       (infra_id IS NOT NULL) + (symbol_ref IS NOT NULL) = 1)
	);
CREATE TABLE sheet_layouts (
		sheet_id           TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
		workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		node_id            TEXT NOT NULL,
		node_type          TEXT NOT NULL CHECK(node_type IN ('system','file','infra')),
		parent_node_id     TEXT,
		parent_node_type   TEXT CHECK(parent_node_type IS NULL OR parent_node_type IN ('system','infra')),
		containment_kind   TEXT NOT NULL DEFAULT 'root' CHECK(containment_kind IN ('root','part_of','hosted_by')),
		position_x         REAL NOT NULL DEFAULT 0,
		position_y         REAL NOT NULL DEFAULT 0,
		width              REAL NOT NULL,
		height             REAL NOT NULL,
		scale              REAL NOT NULL DEFAULT 1 CHECK(scale > 0),
		interior_scale     REAL NOT NULL DEFAULT 1 CHECK(interior_scale > 0),
		updated_at         INTEGER NOT NULL,
		PRIMARY KEY(sheet_id, node_id)
	);
CREATE TABLE sheet_resolutions (
	 sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
	 revision INTEGER NOT NULL, resolved_at INTEGER NOT NULL,
	 comparison TEXT NOT NULL, context TEXT NOT NULL,
	 PRIMARY KEY(sheet_id,revision));
CREATE TABLE sheets (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		purpose       TEXT,
		kind          TEXT NOT NULL DEFAULT 'structure',  -- 'structure'|'class'|'sequence'|'intent'
		folder        TEXT NOT NULL DEFAULT '',
		created_by    TEXT NOT NULL DEFAULT 'user',       -- 'user'|'agent'
		revision      INTEGER NOT NULL DEFAULT 1,
		viewport      TEXT,                               -- json {x,y,zoom}
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	);
CREATE TABLE structural_events (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		workspace_id  TEXT NOT NULL,
		root_id       TEXT,
		branch        TEXT,
		ts            INTEGER NOT NULL,               -- ms epoch
		actor         TEXT NOT NULL DEFAULT 'human',  -- 'human'|'agent'
		trace_id      TEXT NOT NULL DEFAULT '',       -- correlates one save's events
		kind          TEXT NOT NULL,
		subject_id    TEXT NOT NULL DEFAULT '',
		subject_label TEXT NOT NULL DEFAULT '',
		object_id     TEXT NOT NULL DEFAULT '',
		object_label  TEXT NOT NULL DEFAULT '',
		detail        TEXT NOT NULL DEFAULT '',       -- kind-specific JSON
		count         INTEGER NOT NULL DEFAULT 1      -- collapsed repeat saves
	, session_id TEXT NOT NULL DEFAULT '');
CREATE TABLE symbols (
		id            TEXT PRIMARY KEY,
		file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		kind          TEXT NOT NULL,   -- 'function'|'class'|'interface'|'type'|'variable'|'method'
		line_start    INTEGER NOT NULL DEFAULT 0,
		line_end      INTEGER NOT NULL DEFAULT 0,
		body_hash     TEXT NOT NULL DEFAULT ''
	);
CREATE TABLE systems (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		parent_id     TEXT REFERENCES systems(id) ON DELETE SET NULL,
		source        TEXT NOT NULL DEFAULT 'cluster',   -- 'cluster'|'user'|'agent'
		color         TEXT,
		description   TEXT,
		agent_notes   TEXT,
		depth         INTEGER NOT NULL DEFAULT 0,
		position_x    REAL NOT NULL DEFAULT 0,
		position_y    REAL NOT NULL DEFAULT 0,
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	, width  REAL, height REAL);
CREATE TABLE variable_refs (
		id               INTEGER PRIMARY KEY AUTOINCREMENT,
		file_id          TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		variable         TEXT NOT NULL,
		kind             TEXT NOT NULL,              -- 'def'|'param'|'write'|'read'
		line             INTEGER NOT NULL,           -- first line for aggregated reads
		count            INTEGER NOT NULL DEFAULT 1, -- >1 only for 'read' rows
		enclosing_symbol TEXT NOT NULL DEFAULT ''
	);
CREATE TABLE work_sessions (
		id            TEXT PRIMARY KEY,
		workspace_id  TEXT NOT NULL,
		message_id    TEXT NOT NULL DEFAULT '',
		root_id       TEXT,
		branch        TEXT,
		owner_key     TEXT NOT NULL DEFAULT '',
		agent         TEXT NOT NULL DEFAULT '',
		goal          TEXT NOT NULL,
		summary       TEXT NOT NULL DEFAULT '',
		notes         TEXT NOT NULL DEFAULT '[]',   -- JSON [{ts,text}]
		focus_system_ids TEXT NOT NULL DEFAULT '[]',
		focus_file_ids   TEXT NOT NULL DEFAULT '[]',
		started_at    INTEGER NOT NULL,
		ended_at      INTEGER NOT NULL DEFAULT 0    -- 0 = still open
	);
CREATE TABLE workspaces (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		opened_at   INTEGER NOT NULL
	, delta_reviewed_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO "canvas_outbox" VALUES ('order', 'ws', NULL, 'Split checkout', '[]', '', '', '', 'queued', NULL, NULL, 1790866444427, NULL, NULL, 'open');
INSERT INTO "dependencies" VALUES ('cart->stripe', 'ws', 'cart', 'stripe', 'file', 'file', 'IMPORTS', 1, 'parser', '', 'confirmed', NULL);
INSERT INTO "files" VALUES ('cart', 'root', '/fixture/shop/src/orders/cart.ts', 'src/orders/cart.ts', 'typescript', 'orders', 0, 0, 0, 0, 1790866444427, NULL, NULL, '', '', '', 0, 0, '');
INSERT INTO "files" VALUES ('stripe', 'root', '/fixture/shop/src/payments/stripe.ts', 'src/payments/stripe.ts', 'typescript', 'payments', 0, 0, 0, 0, 1790866444427, NULL, NULL, '', '', '', 0, 0, '');
INSERT INTO "roots" VALUES ('root', 'ws', '/fixture/shop', '', '', 1, 1, NULL, 0, 'null', NULL, NULL);
INSERT INTO "sheet_elements" VALUES ('8b38c0da-09f4-4025-98f2-141ca83115ab', 'sheet', 'orders', NULL, NULL, NULL, 'Orders', 0, 0, NULL, NULL, NULL, NULL, '{"version":1}', 0, 0, 'user', 1);
INSERT INTO "sheets" VALUES ('sheet', 'ws', 'Checkout', NULL, 'structure', '', 'user', 2, NULL, 1790866444427, 1790866444427);
INSERT INTO "structural_events" VALUES (1, 'ws', 'root', NULL, 1790866444427, 'human', '', 'file.created', 'cart', 'src/orders/cart.ts', '', '', '', 1, '');
INSERT INTO "systems" VALUES ('orders', 'ws', 'Orders', NULL, 'user', NULL, NULL, NULL, 0, 0, 0, 1790866444427, 1790866444427, NULL, NULL);
INSERT INTO "systems" VALUES ('payments', 'ws', 'Payments', NULL, 'cluster', NULL, NULL, NULL, 0, 0, 0, 1790866444427, 1790866444427, NULL, NULL);
INSERT INTO "workspaces" VALUES ('ws', 'shop', 0, 0);
CREATE INDEX agent_actions_root ON agent_actions(workspace_id, root_id, ts);
CREATE INDEX agent_actions_ws ON agent_actions(workspace_id, ts);
CREATE INDEX annotations_sheet ON annotations(sheet_id);
CREATE INDEX architecture_proposal_drafts_ws ON architecture_proposal_drafts(workspace_id,status,updated_at DESC);
CREATE INDEX architecture_proposal_layouts_parent
		ON architecture_proposal_layouts(proposal_id, revision, parent_ref_type, parent_ref_id);
CREATE INDEX architecture_proposal_memberships_target
		ON architecture_proposal_memberships(proposal_id, revision, target_system_key, disposition);
CREATE INDEX architecture_proposals_ws ON architecture_proposals(workspace_id, updated_at DESC);
CREATE INDEX canvas_history_order ON canvas_outbox(workspace_id,created_at,id);
CREATE INDEX canvas_outbox_ws ON canvas_outbox(workspace_id, status);
CREATE INDEX canvas_reply_history_message ON canvas_reply_history(message_id,id);
CREATE INDEX canvas_review_events_message ON canvas_review_events(message_id,created_at,id);
CREATE INDEX cg_callee ON call_graph(callee_file);
CREATE INDEX cg_caller ON call_graph(caller_file);
CREATE INDEX delta_snapshots_ws ON delta_snapshots(workspace_id, at);
CREATE INDEX dependencies_dst ON dependencies(dst);
CREATE INDEX dependencies_src ON dependencies(src);
CREATE UNIQUE INDEX dependencies_unique_item
			ON dependencies(src, dst, dependency_type, target_item);
CREATE INDEX file_activity_file ON file_activity(file_id, ts);
CREATE INDEX file_activity_ws   ON file_activity(workspace_id, ts);
CREATE INDEX file_env_reads_file ON file_env_reads(file_id);
CREATE INDEX file_packages_file ON file_packages(file_id);
CREATE INDEX file_packages_package ON file_packages(package);
CREATE UNIQUE INDEX files_root_path ON files(root_id, rel_path);
CREATE INDEX floor_layouts_parent
		ON floor_layouts(workspace_id, parent_node_type, parent_node_id);
CREATE INDEX investigations_ws ON investigations(workspace_id);
CREATE INDEX planned_edges_sheet ON planned_edges(sheet_id);
CREATE INDEX planned_nodes_sheet ON planned_nodes(sheet_id);
CREATE INDEX planned_nodes_ws    ON planned_nodes(workspace_id, status);
CREATE INDEX root_delta_snapshots_root
		ON root_delta_snapshots(root_id, branch, at);
CREATE INDEX sheet_elements_sheet ON sheet_elements(sheet_id);
CREATE INDEX sheet_layouts_parent
		ON sheet_layouts(sheet_id, parent_node_type, parent_node_id);
CREATE INDEX structural_events_root ON structural_events(workspace_id, root_id, ts);
CREATE INDEX structural_events_ws ON structural_events(workspace_id, ts);
CREATE INDEX symbols_file ON symbols(file_id);
CREATE UNIQUE INDEX systems_unique_name
			ON systems(workspace_id, COALESCE(parent_id, ''), name);
CREATE INDEX varrefs_file ON variable_refs(file_id);
CREATE INDEX varrefs_variable ON variable_refs(variable);
CREATE INDEX work_sessions_message ON work_sessions(workspace_id, message_id, started_at);
CREATE INDEX work_sessions_root ON work_sessions(workspace_id, root_id, started_at);
CREATE INDEX work_sessions_ws ON work_sessions(workspace_id, started_at);
CREATE TRIGGER canvas_status_insert BEFORE INSERT ON canvas_outbox
 WHEN NEW.status NOT IN ('queued','delivered','answered','cancelled') BEGIN SELECT RAISE(ABORT,'invalid canvas status'); END;
CREATE TRIGGER canvas_status_update BEFORE UPDATE OF status ON canvas_outbox
 WHEN NEW.status NOT IN ('queued','delivered','answered','cancelled') BEGIN SELECT RAISE(ABORT,'invalid canvas status'); END;
CREATE TRIGGER deps_cleanup_on_file_delete
		AFTER DELETE ON files BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'file') OR (dst = OLD.id AND dst_type = 'file');
		END;
CREATE TRIGGER deps_cleanup_on_infra_delete
		AFTER DELETE ON infra_nodes BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'infra') OR (dst = OLD.id AND dst_type = 'infra');
		END;
CREATE TRIGGER deps_cleanup_on_system_delete
		AFTER DELETE ON systems BEGIN
			DELETE FROM dependencies
			WHERE (src = OLD.id AND src_type = 'system') OR (dst = OLD.id AND dst_type = 'system');
		END;
CREATE TRIGGER floor_layout_cleanup_file AFTER DELETE ON files BEGIN
		DELETE FROM floor_layouts WHERE node_type='file' AND node_id=OLD.id;
	END;
CREATE TRIGGER floor_layout_cleanup_infra AFTER DELETE ON infra_nodes BEGIN
		DELETE FROM floor_layouts WHERE node_type='infra' AND node_id=OLD.id;
		UPDATE floor_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='infra' AND parent_node_id=OLD.id;
	END;
CREATE TRIGGER floor_layout_cleanup_system AFTER DELETE ON systems BEGIN
		DELETE FROM floor_layouts WHERE node_type='system' AND node_id=OLD.id;
		UPDATE floor_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='system' AND parent_node_id=OLD.id;
	END;
CREATE TRIGGER sheet_edge_delete_revision AFTER DELETE ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=OLD.sheet_id; END;
CREATE TRIGGER sheet_edge_insert_revision AFTER INSERT ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=NEW.sheet_id; END;
CREATE TRIGGER sheet_edge_update_revision AFTER UPDATE ON planned_edges BEGIN
	 UPDATE sheets SET revision=revision+1 WHERE id=NEW.sheet_id; END;
CREATE TRIGGER sheet_layout_cleanup_file AFTER DELETE ON files BEGIN
		DELETE FROM sheet_layouts WHERE node_type='file' AND node_id=OLD.id;
	END;
CREATE TRIGGER sheet_layout_cleanup_infra AFTER DELETE ON infra_nodes BEGIN
		DELETE FROM sheet_layouts WHERE node_type='infra' AND node_id=OLD.id;
		UPDATE sheet_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='infra' AND parent_node_id=OLD.id;
	END;
CREATE TRIGGER sheet_layout_cleanup_system AFTER DELETE ON systems BEGIN
		DELETE FROM sheet_layouts WHERE node_type='system' AND node_id=OLD.id;
		UPDATE sheet_layouts SET parent_node_id=NULL, parent_node_type=NULL, containment_kind='root'
			WHERE parent_node_type='system' AND parent_node_id=OLD.id;
	END;
