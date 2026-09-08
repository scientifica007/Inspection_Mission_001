-- ============================================================================
-- Inspection_Mission_001 — Gate 4 : Physical / Executable Data Schema v1
-- Technology: SQLite 3 (embedded, file-based) — inspector-level field MVP v1.
-- Revision 3 (final enforcement patch):
--   1. Finding first-source: ChecklistResponse insert/update paths exclude the
--      current row (first source must be in the finding origin visit).
--   2. CHK-012 bidirectional reconciliation integrity (response-side too),
--      discrepancy = difference<>0 OR discrepancy_type IS NOT NULL.
--   3. PK immutability audit: every logical identifier immutable via trigger.
--   4. Checklist definition predecessor/version integrity + partial unique
--      index: at most one ACTIVE definition per item_code.
--   5. Q1 OTHER companions: length(trim(...))>0.
--   6. Documentation aligned in PHYSICAL-SCHEMA/CONSTRAINT-MATRIX.
-- Revision 4 (Gate 4A — checklist applicability bridge, single correction):
--   7. checklist_item_definition.applicability_rule TEXT NOT NULL: canonical
--      JSON object (rule_schema_version = 1) owned by the exact definition
--      version (same immutability as question/note_rule/evidence_rule/
--      finding_rule); guarded by json_valid/json_type/rule_schema_version
--      CHECKs; added to the trg_def_bu immutable-content audit.
--      The DB preserves/versions/stores the rule only; evaluating it against
--      Visit/Mission/Institution/InspectedSubject context stays APPLICATION
--      (see docs/checklists/APPLICABILITY-RULES-v1.md). 15 tables unchanged.
-- Revision 4 (final integrity, same gate): enforce the canonical grammar, not
--   merely JSON well-formedness. Declarative CHECKs cover the scalar keys:
--   $.rule_schema_version (JSON integer == 1 — boolean true rejected),
--   $.item_code (JSON text == row item_code), $.decision_kind (AUTO |
--   HUMAN_CONFIRMATION), $.subject_kinds (must be an array), $.source_ar
--   (non-blank text), $.visit_type (object when present). Iterative content
--   (subject_kinds members, missing_context for HUMAN_CONFIRMATION,
--   visit_type.allowed members) is validated with json_each inside the
--   existing BEFORE INSERT trigger trg_def_bi — no new trigger/table/entity.
--   Trigger count therefore stays at 44.
--
-- Reference documents (GitHub main):
--   docs/data-model/DATA-MODEL-v1.md        (invariants I1..I21)
--   docs/data-model/ENTITY-CATALOG-v1.md    (per-column mutability authority)
--
-- Conventions (unchanged):
--   * INTEGER PRIMARY KEY ids internal only; TEXT codes/dates/timestamps.
--   * Evidence = metadata/reference only; no binaries.
--   * result_class DERIVED (view v_response_outcome); never stored.
--   * No DELETE on any table in v1; follow_up/external_system_tracking
--     append-only.
--   * "Every applicable checklist item has a response before finalization"
--     and "which definition version is ACTIVE-selected for a Visit item/
--     subject context" remain APPLICATION obligations. The DB now PRESERVES
--     and VERSIONS the exact applicability rule (applicability_rule, bound to
--     each item_definition_id) so the application can evaluate the rule that
--     was in force for the selected definition version instead of hard-coding
--     applicability by item_code; the DB still guarantees that ACTIVE is
--     unambiguous per item_code.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- 1. MISSION
-- ----------------------------------------------------------------------------
CREATE TABLE mission (
    mission_id          INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL,
    description         TEXT,
    start_date          TEXT,
    end_date            TEXT,
    reference_entry_date TEXT,
    status              TEXT    NOT NULL DEFAULT 'PREPARATION'
                        CHECK (status IN ('PREPARATION','ACTIVE','COMPLETED','ARCHIVED')),
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL
);
CREATE INDEX idx_mission_status ON mission(status);

-- ----------------------------------------------------------------------------
-- 2. INSTITUTION
-- ----------------------------------------------------------------------------
CREATE TABLE institution (
    institution_id      INTEGER PRIMARY KEY,
    name                TEXT    NOT NULL,
    official_code       TEXT    UNIQUE,
    kind_code           TEXT    CHECK (kind_code IS NULL OR kind_code IN
                            ('CFPA','INSFP','IEFP','CFPS','ANNEX','OTHER')),
    kind_other          TEXT,
    address             TEXT,
    district            TEXT,
    active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL,
    CHECK ( kind_code IS NULL OR kind_code <> 'OTHER'
            OR (kind_other IS NOT NULL AND length(trim(kind_other)) > 0) )
);
CREATE INDEX idx_institution_active ON institution(active);

-- ----------------------------------------------------------------------------
-- 3. INSPECTED SUBJECT
-- ----------------------------------------------------------------------------
CREATE TABLE inspected_subject (
    subject_id          INTEGER PRIMARY KEY,
    institution_id      INTEGER NOT NULL REFERENCES institution(institution_id) ON DELETE RESTRICT,
    subject_type        TEXT    NOT NULL CHECK (subject_type IN
                            ('INSTITUTION','WORKSHOP','LAB','CLASSROOM','DORMITORY',
                             'CANTEEN','FACILITY','TECHNICAL_NETWORK','OTHER')),
    subject_type_other  TEXT,
    name                TEXT    NOT NULL,
    location_desc       TEXT,
    specialty           TEXT,
    active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL,
    CHECK ( subject_type <> 'OTHER'
            OR (subject_type_other IS NOT NULL AND length(trim(subject_type_other)) > 0) )
);
CREATE INDEX idx_subject_institution ON inspected_subject(institution_id);

-- ----------------------------------------------------------------------------
-- 4. VISIT
-- ----------------------------------------------------------------------------
CREATE TABLE visit (
    visit_id            INTEGER PRIMARY KEY,
    mission_id          INTEGER NOT NULL REFERENCES mission(mission_id) ON DELETE RESTRICT,
    institution_id      INTEGER NOT NULL REFERENCES institution(institution_id) ON DELETE RESTRICT,
    visit_type          TEXT    NOT NULL CHECK (visit_type IN ('SURPRISE','PLANNED')),
    visit_date          TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'PREPARATION'
                        CHECK (status IN ('PREPARATION','COMPLETED','COMPLETED_WITH_UNINSPECTED')),
    inspector           TEXT    NOT NULL,
    started_at          TEXT,
    finalized_at        TEXT,
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL,
    CHECK ( (status = 'PREPARATION' AND finalized_at IS NULL)
         OR (status IN ('COMPLETED','COMPLETED_WITH_UNINSPECTED') AND finalized_at IS NOT NULL) )
);
CREATE INDEX idx_visit_mission ON visit(mission_id);
CREATE INDEX idx_visit_institution ON visit(institution_id);

-- ----------------------------------------------------------------------------
-- 5. CHECKLIST ITEM DEFINITION (versioned)
-- ----------------------------------------------------------------------------
CREATE TABLE checklist_item_definition (
    item_definition_id  INTEGER PRIMARY KEY,
    item_code           TEXT    NOT NULL,
    version_no          INTEGER NOT NULL CHECK (version_no > 0),
    supersedes_definition_id INTEGER REFERENCES checklist_item_definition(item_definition_id) ON DELETE RESTRICT,
    effective_from      TEXT,
    domain_id           TEXT    NOT NULL CHECK (domain_id GLOB 'DOM-[0-9][0-9]'),
    arabic_question     TEXT    NOT NULL,
    response_model      TEXT    NOT NULL CHECK (response_model IN ('SINGLE_VALUE','SCHEDULE')),
    priority            TEXT    NOT NULL CHECK (priority IN ('P0','P1','P2')),
    traceability        TEXT    NOT NULL CHECK (traceability IN ('DIRECT','DERIVED','PROJECT')),
    requirement_refs    TEXT    NOT NULL,
    note_rule           TEXT,
    evidence_rule       TEXT,
    finding_rule        TEXT,
    -- Gate 4A (final integrity): canonical applicability rule for this exact
    -- definition version (canonical JSON object, rule_schema_version = 1, per
    -- docs/checklists/APPLICABILITY-RULES-v1.md — grammar keys validated
    -- below and in trg_def_bi). NOT NULL for every definition (an ACTIVE
    -- definition therefore always carries one); immutable under the same
    -- definition-version rules below.
    applicability_rule  TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUPERSEDED','ARCHIVED')),
    UNIQUE (item_code, version_no),
    -- Canonical JSON object (root) with valid JSON.
    CHECK ( json_valid(applicability_rule) = 1 ),
    CHECK ( json_type(applicability_rule) = 'object' ),
    -- $.rule_schema_version: JSON integer strictly equal to 1 (boolean true,
    -- text, or a missing key are all rejected by the CASE guard).
    CHECK ( CASE WHEN json_type(applicability_rule, '$.rule_schema_version') = 'integer'
                      AND json_extract(applicability_rule, '$.rule_schema_version') = 1
                 THEN 1 ELSE 0 END ),
    -- $.item_code: JSON text equal to the row item_code exactly.
    CHECK ( CASE WHEN json_type(applicability_rule, '$.item_code') = 'text'
                      AND json_extract(applicability_rule, '$.item_code') = item_code
                 THEN 1 ELSE 0 END ),
    -- $.decision_kind: JSON text, closed set AUTO | HUMAN_CONFIRMATION.
    CHECK ( CASE WHEN json_type(applicability_rule, '$.decision_kind') = 'text'
                      AND json_extract(applicability_rule, '$.decision_kind') IN
                          ('AUTO','HUMAN_CONFIRMATION')
                 THEN 1 ELSE 0 END ),
    -- $.subject_kinds: must be a JSON array (non-empty + element validity via
    -- json_each in trg_def_bi).
    CHECK ( CASE WHEN json_type(applicability_rule, '$.subject_kinds') = 'array'
                 THEN 1 ELSE 0 END ),
    -- $.source_ar: present as non-blank JSON text (required by the grammar).
    CHECK ( CASE WHEN json_type(applicability_rule, '$.source_ar') = 'text'
                      AND length(trim(json_extract(applicability_rule, '$.source_ar'))) > 0
                 THEN 1 ELSE 0 END ),
    -- $.visit_type (optional): when present it must be a JSON object
    -- (.allowed validation via json_each in trg_def_bi); absence is allowed.
    CHECK ( CASE WHEN json_type(applicability_rule, '$.visit_type') IS NULL THEN 1
                 WHEN json_type(applicability_rule, '$.visit_type') = 'object' THEN 1
                 ELSE 0 END )
);
CREATE INDEX idx_itemdef_code ON checklist_item_definition(item_code);
-- At most one ACTIVE definition per item_code (partial unique index).
CREATE UNIQUE INDEX uq_active_def_per_code
    ON checklist_item_definition(item_code) WHERE status = 'ACTIVE';

-- ----------------------------------------------------------------------------
-- 6. CHECKLIST ALLOWED VALUE
-- ----------------------------------------------------------------------------
CREATE TABLE checklist_allowed_value (
    allowed_value_id    INTEGER PRIMARY KEY,
    item_definition_id  INTEGER NOT NULL REFERENCES checklist_item_definition(item_definition_id) ON DELETE RESTRICT,
    value_code          TEXT    NOT NULL,
    arabic_label        TEXT    NOT NULL,
    semantic_class      TEXT    NOT NULL CHECK (semantic_class IN ('COMPLIANT','NON_COMPLIANT')),
    sort_order          INTEGER,
    active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    UNIQUE (item_definition_id, value_code)
);
CREATE INDEX idx_allowedval_def ON checklist_allowed_value(item_definition_id);

-- ----------------------------------------------------------------------------
-- 7. CHECKLIST RESPONSE (snapshot)
-- ----------------------------------------------------------------------------
CREATE TABLE checklist_response (
    response_id         INTEGER PRIMARY KEY,
    visit_id            INTEGER NOT NULL REFERENCES visit(visit_id) ON DELETE RESTRICT,
    item_definition_id  INTEGER NOT NULL REFERENCES checklist_item_definition(item_definition_id) ON DELETE RESTRICT,
    subject_id          INTEGER REFERENCES inspected_subject(subject_id) ON DELETE RESTRICT,
    overlay_state       TEXT    CHECK (overlay_state IN ('NA','NOT_INSPECTED')),
    answered_value_id   INTEGER REFERENCES checklist_allowed_value(allowed_value_id) ON DELETE RESTRICT,
    note                TEXT,
    not_inspected_reason TEXT,
    finding_id          INTEGER REFERENCES finding(finding_id) ON DELETE RESTRICT,
    recorded_at         TEXT    NOT NULL,
    recorded_by         TEXT    NOT NULL,
    CHECK ( (overlay_state IS NULL AND answered_value_id IS NOT NULL)
         OR (overlay_state IS NOT NULL AND answered_value_id IS NULL) ),
    CHECK ( not_inspected_reason IS NULL OR overlay_state = 'NOT_INSPECTED' )
);
CREATE UNIQUE INDEX uq_response_ctx ON checklist_response
    (visit_id, item_definition_id, COALESCE(subject_id, 0));
CREATE INDEX idx_response_visit ON checklist_response(visit_id);
CREATE INDEX idx_response_finding ON checklist_response(finding_id);

-- ----------------------------------------------------------------------------
-- 8. EQUIPMENT RECONCILIATION ROW
-- ----------------------------------------------------------------------------
CREATE TABLE equipment_reconciliation_row (
    row_id              INTEGER PRIMARY KEY,
    response_id         INTEGER NOT NULL REFERENCES checklist_response(response_id) ON DELETE RESTRICT,
    category            TEXT    NOT NULL,
    declared_qty        INTEGER NOT NULL CHECK (declared_qty >= 0),
    observed_qty        INTEGER NOT NULL CHECK (observed_qty >= 0),
    difference          INTEGER NOT NULL,
    discrepancy_type    TEXT    CHECK (discrepancy_type IN
                            ('QTY_SHORTAGE','QTY_EXCESS','NEW_UNLISTED','CONSUMED_OR_DAMAGED_NOT_REMOVED','OTHER')),
    discrepancy_desc    TEXT,
    sort_order          INTEGER,
    CHECK (difference = observed_qty - declared_qty),
    CHECK ( discrepancy_type IS NULL OR discrepancy_type <> 'OTHER'
            OR (discrepancy_desc IS NOT NULL AND length(trim(discrepancy_desc)) > 0) )
);
CREATE INDEX idx_recon_response ON equipment_reconciliation_row(response_id);

-- ----------------------------------------------------------------------------
-- 9. ADHOC OBSERVATION
-- ----------------------------------------------------------------------------
CREATE TABLE adhoc_observation (
    observation_id      INTEGER PRIMARY KEY,
    visit_id            INTEGER NOT NULL REFERENCES visit(visit_id) ON DELETE RESTRICT,
    subject_id          INTEGER REFERENCES inspected_subject(subject_id) ON DELETE RESTRICT,
    text                TEXT    NOT NULL,
    finding_id          INTEGER REFERENCES finding(finding_id) ON DELETE RESTRICT,
    recorded_at         TEXT    NOT NULL,
    recorded_by         TEXT    NOT NULL
);
CREATE INDEX idx_obs_visit ON adhoc_observation(visit_id);
CREATE INDEX idx_obs_finding ON adhoc_observation(finding_id);

-- ----------------------------------------------------------------------------
-- 10. FINDING
-- ----------------------------------------------------------------------------
CREATE TABLE finding (
    finding_id          INTEGER PRIMARY KEY,
    origin_visit_id     INTEGER NOT NULL REFERENCES visit(visit_id) ON DELETE RESTRICT,
    description         TEXT    NOT NULL,
    defect_type         TEXT    CHECK (defect_type IN
                            ('ELECTRICAL_FAULT','WATER_LEAK','STRUCTURE_DETERIORATION',
                             'SUPPLY_CUT','EQUIPMENT_FAULT','SHORTAGE','OTHER')),
    defect_type_other   TEXT,
    location            TEXT,
    subject_id          INTEGER REFERENCES inspected_subject(subject_id) ON DELETE RESTRICT,
    urgency             TEXT    NOT NULL CHECK (urgency IN ('IMMEDIATE','BEFORE_ENTRY','ROUTINE')),
    impact              TEXT    NOT NULL CHECK (impact IN ('HIGH','MEDIUM','LOW')),
    status              TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_TREATMENT','RESOLVED')),
    status_changed_at   TEXT,
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL,
    CHECK ( defect_type IS NULL OR defect_type <> 'OTHER'
            OR (defect_type_other IS NOT NULL AND length(trim(defect_type_other)) > 0) )
);
CREATE INDEX idx_finding_origin ON finding(origin_visit_id);
CREATE INDEX idx_finding_status ON finding(status);

-- ----------------------------------------------------------------------------
-- 11. EVIDENCE (metadata only)
-- ----------------------------------------------------------------------------
CREATE TABLE evidence (
    evidence_id         INTEGER PRIMARY KEY,
    owner_kind          TEXT    NOT NULL CHECK (owner_kind IN
                            ('VISIT','CHECKLIST_RESPONSE','ADHOC_OBSERVATION',
                             'FINDING','CORRECTIVE_ACTION','FOLLOW_UP')),
    owner_ref           INTEGER NOT NULL,
    storage_ref         TEXT    NOT NULL,
    content_hash        TEXT,
    file_name           TEXT    NOT NULL,
    mime_type           TEXT    NOT NULL,
    file_size           INTEGER CHECK (file_size IS NULL OR file_size >= 0),
    captured_at         TEXT,
    device_note         TEXT,
    note                TEXT,
    recorded_at         TEXT    NOT NULL,
    recorded_by         TEXT    NOT NULL
);
CREATE INDEX idx_evidence_owner ON evidence(owner_kind, owner_ref);

-- ----------------------------------------------------------------------------
-- 12. CORRECTIVE ACTION
-- ----------------------------------------------------------------------------
CREATE TABLE corrective_action (
    action_id           INTEGER PRIMARY KEY,
    finding_id          INTEGER NOT NULL REFERENCES finding(finding_id) ON DELETE RESTRICT,
    action_type         TEXT    NOT NULL CHECK (action_type IN
                            ('MAINTENANCE_WORK','TASYIR_UPDATE','PROCUREMENT_DISTRIBUTION',
                             'ADMIN_ORGANIZATIONAL','OTHER')),
    action_type_other   TEXT,
    description         TEXT    NOT NULL,
    responsible_role    TEXT    NOT NULL CHECK (responsible_role IN
                            ('DIRECTOR','CONCERNED_SERVICE','INSPECTOR','OTHER')),
    responsible_role_other TEXT,
    responsible_name    TEXT,
    due_date            TEXT,
    status              TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_TREATMENT','RESOLVED')),
    closed_at           TEXT,
    verified_by         TEXT,
    verification_note   TEXT,
    created_at          TEXT    NOT NULL,
    created_by          TEXT    NOT NULL,
    CHECK ( action_type <> 'OTHER'
            OR (action_type_other IS NOT NULL AND length(trim(action_type_other)) > 0) ),
    CHECK ( responsible_role <> 'OTHER'
            OR (responsible_role_other IS NOT NULL AND length(trim(responsible_role_other)) > 0) ),
    CHECK ( (status = 'RESOLVED' AND closed_at IS NOT NULL AND verified_by IS NOT NULL AND verified_by <> '')
         OR (status <> 'RESOLVED' AND closed_at IS NULL AND verified_by IS NULL) )
);
CREATE INDEX idx_ca_finding ON corrective_action(finding_id);

-- ----------------------------------------------------------------------------
-- 13. FOLLOW-UP (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE follow_up (
    followup_id         INTEGER PRIMARY KEY,
    finding_id          INTEGER NOT NULL REFERENCES finding(finding_id) ON DELETE RESTRICT,
    corrective_action_id INTEGER REFERENCES corrective_action(action_id) ON DELETE RESTRICT,
    visit_id            INTEGER REFERENCES visit(visit_id) ON DELETE RESTRICT,
    status_target       TEXT    CHECK (status_target IN ('FINDING','CORRECTIVE_ACTION')),
    status_after        TEXT    CHECK (status_after IN ('OPEN','IN_TREATMENT','RESOLVED')),
    event_datetime      TEXT    NOT NULL,
    actor_role          TEXT    NOT NULL CHECK (actor_role IN
                            ('DIRECTOR','CONCERNED_SERVICE','INSPECTOR','OTHER')),
    actor_role_other    TEXT,
    actor_name          TEXT,
    note                TEXT    NOT NULL,
    recorded_by         TEXT    NOT NULL,
    CHECK ( status_after IS NULL OR status_target IS NOT NULL ),
    CHECK ( status_target <> 'CORRECTIVE_ACTION' OR corrective_action_id IS NOT NULL ),
    CHECK ( actor_role <> 'OTHER'
            OR (actor_role_other IS NOT NULL AND length(trim(actor_role_other)) > 0) )
);
CREATE INDEX idx_fu_finding ON follow_up(finding_id, event_datetime);
CREATE INDEX idx_fu_action ON follow_up(corrective_action_id);

-- ----------------------------------------------------------------------------
-- 14. EXTERNAL SYSTEM TRACKING (append-only)
-- ----------------------------------------------------------------------------
CREATE TABLE external_system_tracking (
    tracking_id         INTEGER PRIMARY KEY,
    system              TEXT    NOT NULL CHECK (system IN ('TASYIR','INSPECTION_PLATFORM')),
    operation           TEXT    NOT NULL,
    status_code         TEXT    NOT NULL CHECK (status_code IN ('DONE','PENDING','NOT_DONE','OTHER')),
    status_detail       TEXT,
    event_date          TEXT    NOT NULL,
    note                TEXT,
    reference_or_receipt TEXT,
    corrective_action_id INTEGER REFERENCES corrective_action(action_id) ON DELETE RESTRICT,
    report_id           INTEGER REFERENCES report(report_id) ON DELETE RESTRICT,
    recorded_at         TEXT    NOT NULL,
    recorded_by         TEXT    NOT NULL,
    CHECK ( status_code <> 'OTHER'
            OR (status_detail IS NOT NULL AND length(trim(status_detail)) > 0) )
);
CREATE INDEX idx_ext_ca ON external_system_tracking(corrective_action_id);
CREATE INDEX idx_ext_report ON external_system_tracking(report_id);

-- ----------------------------------------------------------------------------
-- 15. REPORT (P0 metadata)
-- ----------------------------------------------------------------------------
CREATE TABLE report (
    report_id           INTEGER PRIMARY KEY,
    report_type         TEXT    NOT NULL CHECK (report_type IN
                            ('DETAILED_REPORT','TECHNICAL_SHEET','INSPECTION_REPORT',
                             'MINUTES','WEEKLY_WILAYA')),
    title               TEXT,
    mission_id          INTEGER REFERENCES mission(mission_id) ON DELETE RESTRICT,
    visit_id            INTEGER REFERENCES visit(visit_id) ON DELETE RESTRICT,
    institution_id      INTEGER REFERENCES institution(institution_id) ON DELETE RESTRICT,
    data_snapshot_ref   TEXT    NOT NULL,
    generated_at        TEXT    NOT NULL,
    generated_by        TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','GENERATED')),
    artifacts           TEXT
);
CREATE INDEX idx_report_mission ON report(mission_id);
CREATE INDEX idx_report_visit ON report(visit_id);

-- ============================================================================
-- DERIVED result_class view (never stored)
-- ============================================================================
CREATE VIEW v_response_outcome AS
SELECT r.response_id, r.visit_id, r.item_definition_id, r.subject_id,
       r.overlay_state, r.answered_value_id, r.finding_id, r.note,
       r.not_inspected_reason, r.recorded_at, r.recorded_by,
       CASE
           WHEN r.overlay_state = 'NA'            THEN 'NA'
           WHEN r.overlay_state = 'NOT_INSPECTED' THEN 'NOT_INSPECTED'
           ELSE av.semantic_class
       END AS result_class
FROM checklist_response r
LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = r.answered_value_id;

-- ============================================================================
-- NO-DELETE POLICY (all 15 tables)
-- ============================================================================
CREATE TRIGGER trg_mission_bd      BEFORE DELETE ON mission                  BEGIN SELECT RAISE(ABORT,'no-delete: mission');           END;
CREATE TRIGGER trg_institution_bd  BEFORE DELETE ON institution              BEGIN SELECT RAISE(ABORT,'no-delete: institution');       END;
CREATE TRIGGER trg_subject_bd      BEFORE DELETE ON inspected_subject        BEGIN SELECT RAISE(ABORT,'no-delete: subject');          END;
CREATE TRIGGER trg_visit_bd        BEFORE DELETE ON visit                    BEGIN SELECT RAISE(ABORT,'no-delete: visit');            END;
CREATE TRIGGER trg_def_bd          BEFORE DELETE ON checklist_item_definition BEGIN SELECT RAISE(ABORT,'no-delete: item definition');   END;
CREATE TRIGGER trg_av_bd           BEFORE DELETE ON checklist_allowed_value  BEGIN SELECT RAISE(ABORT,'no-delete: allowed value');     END;
CREATE TRIGGER trg_response_bd     BEFORE DELETE ON checklist_response       BEGIN SELECT RAISE(ABORT,'no-delete: response (snapshot)'); END;
CREATE TRIGGER trg_recon_bd        BEFORE DELETE ON equipment_reconciliation_row BEGIN SELECT RAISE(ABORT,'no-delete: reconciliation row'); END;
CREATE TRIGGER trg_obs_bd          BEFORE DELETE ON adhoc_observation        BEGIN SELECT RAISE(ABORT,'no-delete: observation');        END;
CREATE TRIGGER trg_finding_bd      BEFORE DELETE ON finding                  BEGIN SELECT RAISE(ABORT,'no-delete: finding');            END;
CREATE TRIGGER trg_evidence_bd     BEFORE DELETE ON evidence                 BEGIN SELECT RAISE(ABORT,'no-delete: evidence');           END;
CREATE TRIGGER trg_ca_bd           BEFORE DELETE ON corrective_action        BEGIN SELECT RAISE(ABORT,'no-delete: corrective action');   END;
CREATE TRIGGER trg_fu_bd           BEFORE DELETE ON follow_up                BEGIN SELECT RAISE(ABORT,'no-delete: follow-up');          END;
CREATE TRIGGER trg_ext_bd          BEFORE DELETE ON external_system_tracking BEGIN SELECT RAISE(ABORT,'no-delete: external tracking');   END;
CREATE TRIGGER trg_report_bd       BEFORE DELETE ON report                   BEGIN SELECT RAISE(ABORT,'no-delete: report');             END;

-- ============================================================================
-- APPEND-ONLY tables
-- ============================================================================
CREATE TRIGGER trg_fu_bu  BEFORE UPDATE ON follow_up
BEGIN SELECT RAISE(ABORT,'append-only: follow_up is never updated; add a new row'); END;
CREATE TRIGGER trg_ext_bu BEFORE UPDATE ON external_system_tracking
BEGIN SELECT RAISE(ABORT,'append-only: external_system_tracking is never updated; add a new row'); END;

-- ============================================================================
-- MISSION mutability (ENTITY-CATALOG §2.1)
-- ============================================================================
CREATE TRIGGER trg_mission_bu BEFORE UPDATE ON mission
BEGIN
    SELECT RAISE(ABORT,'mission: identity/audit fields are fixed')
        WHERE OLD.mission_id <> NEW.mission_id
           OR OLD.created_at IS NOT NEW.created_at OR OLD.created_at <> NEW.created_at
           OR OLD.created_by IS NOT NEW.created_by OR OLD.created_by <> NEW.created_by;

    SELECT RAISE(ABORT,'mission: name may not change after closure (COMPLETED/ARCHIVED)')
        WHERE OLD.name <> NEW.name AND OLD.status IN ('COMPLETED','ARCHIVED');

    SELECT RAISE(ABORT,'mission: reference_entry_date is fixed after activation')
        WHERE (OLD.reference_entry_date IS NOT NEW.reference_entry_date
                OR OLD.reference_entry_date <> NEW.reference_entry_date)
          AND OLD.status <> 'PREPARATION';
END;

-- ============================================================================
-- INSTITUTION mutability (§2.2)
-- ============================================================================
CREATE TRIGGER trg_institution_bu BEFORE UPDATE ON institution
BEGIN
    SELECT RAISE(ABORT,'institution: identity/audit fields are fixed')
        WHERE OLD.institution_id <> NEW.institution_id
           OR OLD.created_at IS NOT NEW.created_at OR OLD.created_at <> NEW.created_at
           OR OLD.created_by IS NOT NEW.created_by OR OLD.created_by <> NEW.created_by;
END;

-- ============================================================================
-- INSPECTED SUBJECT mutability (§2.3)
-- ============================================================================
CREATE TRIGGER trg_subject_bu BEFORE UPDATE ON inspected_subject
BEGIN
    SELECT RAISE(ABORT,'subject: identity/ownership/audit fields are fixed')
        WHERE OLD.subject_id <> NEW.subject_id
           OR OLD.institution_id <> NEW.institution_id
           OR OLD.created_at IS NOT NEW.created_at OR OLD.created_at <> NEW.created_at
           OR OLD.created_by IS NOT NEW.created_by OR OLD.created_by <> NEW.created_by;

    SELECT RAISE(ABORT,'subject: subject_type is fixed after first use')
        WHERE (OLD.subject_type <> NEW.subject_type
                OR OLD.subject_type_other IS NOT NEW.subject_type_other
                OR OLD.subject_type_other <> NEW.subject_type_other)
          AND ( EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.subject_id = NEW.subject_id)
             OR EXISTS (SELECT 1 FROM adhoc_observation o  WHERE o.subject_id  = NEW.subject_id)
             OR EXISTS (SELECT 1 FROM finding f            WHERE f.subject_id  = NEW.subject_id) );
END;

-- ============================================================================
-- VISIT lifecycle & mutability (§2.4)
-- ============================================================================
CREATE TRIGGER trg_visit_bi BEFORE INSERT ON visit
BEGIN
    SELECT RAISE(ABORT,'visit must be created in PREPARATION with finalized_at NULL')
        WHERE NEW.status <> 'PREPARATION' OR NEW.finalized_at IS NOT NULL;
END;

CREATE TRIGGER trg_visit_bu BEFORE UPDATE ON visit
BEGIN
    SELECT RAISE(ABORT,'visit finalized: immutable (no reopen in v1)')
        WHERE OLD.finalized_at IS NOT NULL;

    SELECT RAISE(ABORT,'visit: identity/mission/institution/type/date/audit fields are fixed')
        WHERE OLD.visit_id <> NEW.visit_id
           OR OLD.mission_id <> NEW.mission_id
           OR OLD.institution_id <> NEW.institution_id
           OR OLD.visit_type <> NEW.visit_type
           OR OLD.visit_date <> NEW.visit_date
           OR OLD.created_at IS NOT NEW.created_at OR OLD.created_at <> NEW.created_at
           OR OLD.created_by IS NOT NEW.created_by OR OLD.created_by <> NEW.created_by;

    SELECT RAISE(ABORT,'visit: started_at is fixed once recorded')
        WHERE OLD.started_at IS NOT NULL
          AND (NEW.started_at IS NULL OR OLD.started_at <> NEW.started_at);

    SELECT RAISE(ABORT,'PREPARATION requires finalized_at NULL')
        WHERE NEW.status = 'PREPARATION' AND NEW.finalized_at IS NOT NULL;

    SELECT RAISE(ABORT,'finalization must be a single atomic transition from PREPARATION with finalized_at set')
        WHERE NEW.finalized_at IS NOT NULL
          AND (OLD.status <> 'PREPARATION'
               OR NEW.status NOT IN ('COMPLETED','COMPLETED_WITH_UNINSPECTED'));

    SELECT RAISE(ABORT,'a final status requires finalized_at NOT NULL and a PREPARATION origin')
        WHERE NEW.status IN ('COMPLETED','COMPLETED_WITH_UNINSPECTED')
          AND (NEW.finalized_at IS NULL OR OLD.status <> 'PREPARATION');

    SELECT RAISE(ABORT,'COMPLETED requires every applicable item to be inspected (no NOT_INSPECTED rows)')
        WHERE NEW.status = 'COMPLETED' AND NEW.finalized_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_response cr
                      WHERE cr.visit_id = NEW.visit_id AND cr.overlay_state = 'NOT_INSPECTED');

    SELECT RAISE(ABORT,'COMPLETED_WITH_UNINSPECTED requires at least one applicable NOT_INSPECTED row')
        WHERE NEW.status = 'COMPLETED_WITH_UNINSPECTED' AND NEW.finalized_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr
                          WHERE cr.visit_id = NEW.visit_id AND cr.overlay_state = 'NOT_INSPECTED');

    SELECT RAISE(ABORT,'each applicable NOT_INSPECTED response needs a recorded reason before closure')
        WHERE NEW.status = 'COMPLETED_WITH_UNINSPECTED' AND NEW.finalized_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_response cr
                      WHERE cr.visit_id = NEW.visit_id
                        AND cr.overlay_state = 'NOT_INSPECTED'
                        AND (cr.not_inspected_reason IS NULL OR cr.not_inspected_reason = ''));
END;

-- ============================================================================
-- CHECKLIST ITEM DEFINITION : insert-time predecessor/version integrity
-- (supersedes is immutable afterwards; catalog fixes it as "ثابت").
-- Gate 4A (final integrity): canonical applicability_rule content that needs
-- json_each iteration (subject_kinds members, missing_context members,
-- visit_type.allowed members) is validated here — no new trigger/table.
-- ============================================================================
CREATE TRIGGER trg_def_bi BEFORE INSERT ON checklist_item_definition
BEGIN
    -- self-supersede is meaningless (testable with an explicit PK insert)
    SELECT RAISE(ABORT,'definition cannot supersede itself')
        WHERE NEW.supersedes_definition_id IS NOT NULL
          AND NEW.supersedes_definition_id = NEW.item_definition_id;

    -- predecessor must belong to the SAME item_code
    SELECT RAISE(ABORT,'supersedes_definition_id must reference a definition of the same item_code')
        WHERE NEW.supersedes_definition_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_item_definition s
                      WHERE s.item_definition_id = NEW.supersedes_definition_id
                        AND s.item_code <> NEW.item_code);

    -- predecessor must be an EARLIER version (version_no < NEW.version_no)
    SELECT RAISE(ABORT,'supersedes_definition_id must reference an earlier version (version_no lower)')
        WHERE NEW.supersedes_definition_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_item_definition s
                      WHERE s.item_definition_id = NEW.supersedes_definition_id
                        AND s.version_no >= NEW.version_no);

    -- Canonical content arms below apply only to a well-formed JSON object
    -- root (json_valid + root 'object'); NULL / invalid / non-object values
    -- are left to the NOT NULL and CHECK constraints for clean messages.

    -- $.subject_kinds must not be empty
    SELECT RAISE(ABORT,'applicability_rule: subject_kinds must not be empty')
        WHERE json_valid(NEW.applicability_rule) = 1
          AND json_type(NEW.applicability_rule) = 'object'
          AND NOT EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.subject_kinds'));

    -- every $.subject_kinds element must be JSON text from the closed set
    SELECT RAISE(ABORT,'applicability_rule: every subject_kinds element must be text and one of the allowed subject types')
        WHERE json_valid(NEW.applicability_rule) = 1
          AND json_type(NEW.applicability_rule) = 'object'
          AND EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.subject_kinds') sk
                      WHERE sk.type <> 'text'
                         OR sk.value NOT IN ('INSTITUTION','WORKSHOP','LAB','CLASSROOM','DORMITORY',
                                             'CANTEEN','FACILITY','TECHNICAL_NETWORK','OTHER'));

    -- decision_kind = HUMAN_CONFIRMATION requires $.missing_context to exist
    -- as a non-empty array whose members are non-blank text strings
    SELECT RAISE(ABORT,'applicability_rule: HUMAN_CONFIRMATION requires a non-empty missing_context array of non-blank text members')
        WHERE json_valid(NEW.applicability_rule) = 1
          AND json_type(NEW.applicability_rule) = 'object'
          AND json_extract(NEW.applicability_rule, '$.decision_kind') = 'HUMAN_CONFIRMATION'
          AND ( json_type(NEW.applicability_rule, '$.missing_context') <> 'array'
             OR NOT EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.missing_context'))
             OR EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.missing_context') mc
                        WHERE mc.type <> 'text' OR length(trim(mc.value)) = 0) );

    -- $.visit_type (when present as an object) must carry $.visit_type.allowed
    -- as a non-empty array of JSON text values SURPRISE | PLANNED
    SELECT RAISE(ABORT,'applicability_rule: visit_type.allowed must be a non-empty array of SURPRISE/PLANNED')
        WHERE json_valid(NEW.applicability_rule) = 1
          AND json_type(NEW.applicability_rule) = 'object'
          AND json_type(NEW.applicability_rule, '$.visit_type') = 'object'
          AND ( json_type(NEW.applicability_rule, '$.visit_type.allowed') <> 'array'
             OR NOT EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.visit_type.allowed'))
             OR EXISTS (SELECT 1 FROM json_each(NEW.applicability_rule, '$.visit_type.allowed') vt
                        WHERE vt.type <> 'text' OR vt.value NOT IN ('SURPRISE','PLANNED')) );
END;

-- ============================================================================
-- CHECKLIST ITEM DEFINITION mutability (§2.5 + item 3 + Gate 4A item 7)
--   Only status is mutable; effective_from adjustable only while unused.
--   applicability_rule is definition-version content: immutable like
--   question/response_model/note_rule/evidence_rule/finding_rule (a changed
--   applicability rule requires a NEW definition version).
--   PK item_definition_id immutable here (not via FK side effects).
-- ============================================================================
CREATE TRIGGER trg_def_bu BEFORE UPDATE ON checklist_item_definition
BEGIN
    SELECT RAISE(ABORT,'definition: content/ownership fields are immutable')
        WHERE OLD.item_definition_id <> NEW.item_definition_id
           OR OLD.item_code <> NEW.item_code
           OR OLD.version_no <> NEW.version_no
           OR OLD.supersedes_definition_id IS NOT NEW.supersedes_definition_id
           OR OLD.supersedes_definition_id <> NEW.supersedes_definition_id
           OR OLD.domain_id <> NEW.domain_id
           OR OLD.arabic_question <> NEW.arabic_question
           OR OLD.response_model <> NEW.response_model
           OR OLD.priority <> NEW.priority
           OR OLD.traceability <> NEW.traceability
           OR OLD.requirement_refs <> NEW.requirement_refs
           OR OLD.note_rule IS NOT NEW.note_rule OR OLD.note_rule <> NEW.note_rule
           OR OLD.evidence_rule IS NOT NEW.evidence_rule OR OLD.evidence_rule <> NEW.evidence_rule
           OR OLD.finding_rule IS NOT NEW.finding_rule OR OLD.finding_rule <> NEW.finding_rule
           OR OLD.applicability_rule IS NOT NEW.applicability_rule
           OR OLD.applicability_rule <> NEW.applicability_rule;

    SELECT RAISE(ABORT,'definition: effective_from is fixed once the definition is used')
        WHERE (OLD.effective_from IS NOT NEW.effective_from
                OR OLD.effective_from <> NEW.effective_from)
          AND EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.item_definition_id = NEW.item_definition_id);
END;

-- ============================================================================
-- CHECKLIST ALLOWED VALUE mutability (§2.6): only active is mutable.
-- ============================================================================
CREATE TRIGGER trg_av_bu BEFORE UPDATE ON checklist_allowed_value
BEGIN
    SELECT RAISE(ABORT,'allowed value: value metadata is immutable (only active may change)')
        WHERE OLD.allowed_value_id <> NEW.allowed_value_id
           OR OLD.item_definition_id <> NEW.item_definition_id
           OR OLD.value_code <> NEW.value_code
           OR OLD.arabic_label <> NEW.arabic_label
           OR OLD.semantic_class <> NEW.semantic_class
           OR OLD.sort_order IS NOT NEW.sort_order OR OLD.sort_order <> NEW.sort_order;
END;

-- ============================================================================
-- CHECKLIST RESPONSE integrity & mutability (§2.7 + items 1/3)
-- ============================================================================
CREATE TRIGGER trg_response_bi BEFORE INSERT ON checklist_response
BEGIN
    SELECT RAISE(ABORT,'responses may only be recorded while the visit is open (PREPARATION)')
        WHERE (SELECT v.finalized_at FROM visit v WHERE v.visit_id = NEW.visit_id) IS NOT NULL
           OR (SELECT v.status FROM visit v WHERE v.visit_id = NEW.visit_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'mixed definition versions for the same item_code in the same visit/subject context are forbidden')
        WHERE EXISTS (SELECT 1 FROM checklist_response r2
                      JOIN checklist_item_definition d1 ON d1.item_definition_id = NEW.item_definition_id
                      JOIN checklist_item_definition d2 ON d2.item_definition_id = r2.item_definition_id
                      WHERE r2.visit_id = NEW.visit_id
                        AND d1.item_code = d2.item_code
                        AND COALESCE(r2.subject_id,0) = COALESCE(NEW.subject_id,0)
                        AND r2.item_definition_id <> NEW.item_definition_id);

    SELECT RAISE(ABORT,'answered value must belong to the same item definition version')
        WHERE NEW.answered_value_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_allowed_value av
                      WHERE av.allowed_value_id = NEW.answered_value_id
                        AND av.item_definition_id <> NEW.item_definition_id);

    SELECT RAISE(ABORT,'subject must belong to the same institution as the visit')
        WHERE NEW.subject_id IS NOT NULL
          AND (SELECT s.institution_id FROM inspected_subject s WHERE s.subject_id = NEW.subject_id)
            <> (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id);

    SELECT RAISE(ABORT,'non-compliant answer must be linked to a finding')
        WHERE NEW.answered_value_id IS NOT NULL
          AND (SELECT av.semantic_class FROM checklist_allowed_value av
               WHERE av.allowed_value_id = NEW.answered_value_id) = 'NON_COMPLIANT'
          AND NEW.finding_id IS NULL;

    SELECT RAISE(ABORT,'compliant / overlay answers must never be linked to a finding')
        WHERE NEW.finding_id IS NOT NULL
          AND ( NEW.overlay_state IS NOT NULL
             OR EXISTS (SELECT 1 FROM checklist_allowed_value av
                        WHERE av.allowed_value_id = NEW.answered_value_id
                          AND av.semantic_class = 'COMPLIANT') );
END;

-- Finding-accountability link on INSERT.
-- The FIRST source of a Finding must be recorded in its origin_visit_id;
-- later covering links must stay within the same institution.
-- The newly inserted response itself is EXCLUDED when counting other sources.
CREATE TRIGGER trg_response_finding_bi AFTER INSERT ON checklist_response
BEGIN
    SELECT RAISE(ABORT,'finding does not belong to the same institution as this visit')
        WHERE NEW.finding_id IS NOT NULL
          AND (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f2.institution_id
                  FROM finding f JOIN visit f2 ON f2.visit_id = f.origin_visit_id
                 WHERE f.finding_id = NEW.finding_id);

    SELECT RAISE(ABORT,'the first recorded source of a finding must belong to its origin_visit_id')
        WHERE NEW.finding_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr
                          WHERE cr.finding_id = NEW.finding_id AND cr.response_id <> NEW.response_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = NEW.finding_id)
          AND (SELECT v.visit_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f.origin_visit_id FROM finding f WHERE f.finding_id = NEW.finding_id);
END;

CREATE TRIGGER trg_response_bu BEFORE UPDATE ON checklist_response
BEGIN
    SELECT RAISE(ABORT,'response: identity/visit/definition/subject/audit fields are fixed')
        WHERE OLD.response_id <> NEW.response_id
           OR OLD.visit_id <> NEW.visit_id
           OR OLD.item_definition_id <> NEW.item_definition_id
           OR OLD.subject_id IS NOT NEW.subject_id OR OLD.subject_id <> NEW.subject_id
           OR OLD.recorded_at <> NEW.recorded_at
           OR OLD.recorded_by <> NEW.recorded_by;

    SELECT RAISE(ABORT,'responses are immutable once the visit is finalized')
        WHERE (SELECT v.finalized_at FROM visit v WHERE v.visit_id = NEW.visit_id) IS NOT NULL;

    SELECT RAISE(ABORT,'responses may only be corrected while the visit is open (PREPARATION)')
        WHERE (SELECT v.status FROM visit v WHERE v.visit_id = NEW.visit_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'cannot remove/reassign the last remaining source of a non-OPEN finding')
        WHERE OLD.finding_id IS NOT NULL
          AND (NEW.finding_id IS NULL OR NEW.finding_id <> OLD.finding_id)
          AND (SELECT f.status FROM finding f WHERE f.finding_id = OLD.finding_id) <> 'OPEN'
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr
                          WHERE cr.finding_id = OLD.finding_id AND cr.response_id <> OLD.response_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = OLD.finding_id);

    SELECT RAISE(ABORT,'mixed definition versions for the same item_code in the same visit/subject context are forbidden')
        WHERE EXISTS (SELECT 1 FROM checklist_response r2
                      JOIN checklist_item_definition d1 ON d1.item_definition_id = NEW.item_definition_id
                      JOIN checklist_item_definition d2 ON d2.item_definition_id = r2.item_definition_id
                      WHERE r2.response_id <> NEW.response_id
                        AND r2.visit_id = NEW.visit_id
                        AND d1.item_code = d2.item_code
                        AND COALESCE(r2.subject_id,0) = COALESCE(NEW.subject_id,0)
                        AND r2.item_definition_id <> NEW.item_definition_id);

    SELECT RAISE(ABORT,'answered value must belong to the same item definition version')
        WHERE NEW.answered_value_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM checklist_allowed_value av
                      WHERE av.allowed_value_id = NEW.answered_value_id
                        AND av.item_definition_id <> NEW.item_definition_id);

    SELECT RAISE(ABORT,'non-compliant answer must be linked to a finding')
        WHERE NEW.answered_value_id IS NOT NULL
          AND (SELECT av.semantic_class FROM checklist_allowed_value av
               WHERE av.allowed_value_id = NEW.answered_value_id) = 'NON_COMPLIANT'
          AND NEW.finding_id IS NULL;

    SELECT RAISE(ABORT,'compliant / overlay answers must never be linked to a finding')
        WHERE NEW.finding_id IS NOT NULL
          AND ( NEW.overlay_state IS NOT NULL
             OR EXISTS (SELECT 1 FROM checklist_allowed_value av
                        WHERE av.allowed_value_id = NEW.answered_value_id
                          AND av.semantic_class = 'COMPLIANT') );
END;

-- Finding-accountability link on UPDATE (first-source semantics, current row excluded).
CREATE TRIGGER trg_response_finding_bu AFTER UPDATE ON checklist_response
BEGIN
    SELECT RAISE(ABORT,'finding does not belong to the same institution as this visit')
        WHERE NEW.finding_id IS NOT NULL
          AND (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f2.institution_id
                  FROM finding f JOIN visit f2 ON f2.visit_id = f.origin_visit_id
                 WHERE f.finding_id = NEW.finding_id);

    SELECT RAISE(ABORT,'the first recorded source of a finding must belong to its origin_visit_id')
        WHERE NEW.finding_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr
                          WHERE cr.finding_id = NEW.finding_id AND cr.response_id <> NEW.response_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = NEW.finding_id)
          AND (SELECT v.visit_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f.origin_visit_id FROM finding f WHERE f.finding_id = NEW.finding_id);
END;

-- CHK-012 parent-side (response) reconciliation integrity:
--   * overall COMPLIANT may not be (re)set while ANY reconciliation row is a
--     discrepancy (difference<>0 OR discrepancy_type NOT NULL);
--   * NO overlay state (NA / NOT_INSPECTED) may be set while reconciliation
--     rows exist.
CREATE TRIGGER trg_response_chk012_bu BEFORE UPDATE ON checklist_response
BEGIN
    SELECT RAISE(ABORT,'CHK-012: overall COMPLIANT may not coexist with any discrepancy row')
        WHERE NEW.answered_value_id IS NOT NULL
          AND (SELECT av.semantic_class FROM checklist_allowed_value av
               WHERE av.allowed_value_id = NEW.answered_value_id) = 'COMPLIANT'
          AND EXISTS (SELECT 1 FROM equipment_reconciliation_row er
                      WHERE er.response_id = NEW.response_id
                        AND (er.difference <> 0 OR er.discrepancy_type IS NOT NULL));

    SELECT RAISE(ABORT,'CHK-012: overlay (NA/NOT_INSPECTED) may not be set while reconciliation rows exist')
        WHERE NEW.overlay_state IS NOT NULL
          AND EXISTS (SELECT 1 FROM equipment_reconciliation_row er
                      WHERE er.response_id = NEW.response_id);
END;

-- ============================================================================
-- EQUIPMENT RECONCILIATION ROW mutability & integrity (§2.8 + item 2)
--   A discrepancy is: difference<>0 OR discrepancy_type IS NOT NULL.
-- ============================================================================
CREATE TRIGGER trg_recon_bi BEFORE INSERT ON equipment_reconciliation_row
BEGIN
    SELECT RAISE(ABORT,'reconciliation rows may only be recorded while the visit is open (PREPARATION)')
        WHERE (SELECT v.finalized_at
                 FROM checklist_response cr JOIN visit v ON v.visit_id = cr.visit_id
                WHERE cr.response_id = NEW.response_id) IS NOT NULL
           OR (SELECT v.status
                 FROM checklist_response cr JOIN visit v ON v.visit_id = cr.visit_id
                WHERE cr.response_id = NEW.response_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'reconciliation rows belong only to a SCHEDULE-type (CHK-012) response')
        WHERE (SELECT d.response_model
                 FROM checklist_response cr
                 JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
                WHERE cr.response_id = NEW.response_id) <> 'SCHEDULE';

    -- ANY overlay state (NA or NOT_INSPECTED) forbids rows.
    SELECT RAISE(ABORT,'overall overlay (NA/NOT_INSPECTED): reconciliation rows must not be recorded')
        WHERE (SELECT cr.overlay_state FROM checklist_response cr
               WHERE cr.response_id = NEW.response_id) IS NOT NULL;

    SELECT RAISE(ABORT,'overall COMPLIANT but a reconciliation row carries a discrepancy')
        WHERE (SELECT av.semantic_class
                 FROM checklist_response cr
                 LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = cr.answered_value_id
                WHERE cr.response_id = NEW.response_id) = 'COMPLIANT'
          AND (NEW.difference <> 0 OR NEW.discrepancy_type IS NOT NULL);
END;

CREATE TRIGGER trg_recon_bu BEFORE UPDATE ON equipment_reconciliation_row
BEGIN
    SELECT RAISE(ABORT,'reconciliation row: identity/response/order fields are fixed')
        WHERE OLD.row_id <> NEW.row_id
           OR OLD.response_id <> NEW.response_id
           OR OLD.sort_order IS NOT NEW.sort_order OR OLD.sort_order <> NEW.sort_order;

    SELECT RAISE(ABORT,'reconciliation rows are immutable once the visit is finalized')
        WHERE (SELECT v.finalized_at
                 FROM checklist_response cr JOIN visit v ON v.visit_id = cr.visit_id
                WHERE cr.response_id = NEW.response_id) IS NOT NULL;

    SELECT RAISE(ABORT,'reconciliation rows may only be corrected while the visit is open (PREPARATION)')
        WHERE (SELECT v.status
                 FROM checklist_response cr JOIN visit v ON v.visit_id = cr.visit_id
                WHERE cr.response_id = NEW.response_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'overall COMPLIANT but a reconciliation row carries a discrepancy')
        WHERE (SELECT av.semantic_class
                 FROM checklist_response cr
                 LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = cr.answered_value_id
                WHERE cr.response_id = NEW.response_id) = 'COMPLIANT'
          AND (NEW.difference <> 0 OR NEW.discrepancy_type IS NOT NULL);
END;

-- ============================================================================
-- ADHOC OBSERVATION mutability & integrity (§2.9)
-- ============================================================================
CREATE TRIGGER trg_obs_bi BEFORE INSERT ON adhoc_observation
BEGIN
    SELECT RAISE(ABORT,'observations may only be recorded while the visit is open (PREPARATION)')
        WHERE (SELECT v.finalized_at FROM visit v WHERE v.visit_id = NEW.visit_id) IS NOT NULL
           OR (SELECT v.status FROM visit v WHERE v.visit_id = NEW.visit_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'observation subject must belong to the same institution as the visit')
        WHERE NEW.subject_id IS NOT NULL
          AND (SELECT s.institution_id FROM inspected_subject s WHERE s.subject_id = NEW.subject_id)
            <> (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id);
END;

CREATE TRIGGER trg_obs_finding_bi AFTER INSERT ON adhoc_observation
BEGIN
    SELECT RAISE(ABORT,'observation-finding link must belong to the same institution as this visit')
        WHERE NEW.finding_id IS NOT NULL
          AND (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f2.institution_id
                  FROM finding f JOIN visit f2 ON f2.visit_id = f.origin_visit_id
                 WHERE f.finding_id = NEW.finding_id);

    SELECT RAISE(ABORT,'the first recorded source of a finding must belong to its origin_visit_id')
        WHERE NEW.finding_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = NEW.finding_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o
                          WHERE o.finding_id = NEW.finding_id AND o.observation_id <> NEW.observation_id)
          AND (SELECT v.visit_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f.origin_visit_id FROM finding f WHERE f.finding_id = NEW.finding_id);
END;

CREATE TRIGGER trg_obs_bu BEFORE UPDATE ON adhoc_observation
BEGIN
    SELECT RAISE(ABORT,'observation: identity/ownership/audit fields are fixed')
        WHERE OLD.observation_id <> NEW.observation_id
           OR OLD.visit_id <> NEW.visit_id
           OR OLD.recorded_at <> NEW.recorded_at
           OR OLD.recorded_by <> NEW.recorded_by;

    SELECT RAISE(ABORT,'observations are immutable once the visit is finalized')
        WHERE (SELECT v.finalized_at FROM visit v WHERE v.visit_id = NEW.visit_id) IS NOT NULL;

    SELECT RAISE(ABORT,'observations may only be corrected while the visit is open (PREPARATION)')
        WHERE (SELECT v.status FROM visit v WHERE v.visit_id = NEW.visit_id) <> 'PREPARATION';

    SELECT RAISE(ABORT,'observation subject must belong to the same institution as the visit')
        WHERE NEW.subject_id IS NOT NULL
          AND (SELECT s.institution_id FROM inspected_subject s WHERE s.subject_id = NEW.subject_id)
            <> (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id);

    SELECT RAISE(ABORT,'cannot remove/reassign the last remaining source of a non-OPEN finding')
        WHERE OLD.finding_id IS NOT NULL
          AND (NEW.finding_id IS NULL OR NEW.finding_id <> OLD.finding_id)
          AND (SELECT f.status FROM finding f WHERE f.finding_id = OLD.finding_id) <> 'OPEN'
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = OLD.finding_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o
                          WHERE o.finding_id = OLD.finding_id AND o.observation_id <> OLD.observation_id);
END;

CREATE TRIGGER trg_obs_finding_bu AFTER UPDATE ON adhoc_observation
BEGIN
    SELECT RAISE(ABORT,'observation-finding link must belong to the same institution as this visit')
        WHERE NEW.finding_id IS NOT NULL
          AND (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f2.institution_id
                  FROM finding f JOIN visit f2 ON f2.visit_id = f.origin_visit_id
                 WHERE f.finding_id = NEW.finding_id);

    SELECT RAISE(ABORT,'the first recorded source of a finding must belong to its origin_visit_id')
        WHERE NEW.finding_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = NEW.finding_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o
                          WHERE o.finding_id = NEW.finding_id AND o.observation_id <> NEW.observation_id)
          AND (SELECT v.visit_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f.origin_visit_id FROM finding f WHERE f.finding_id = NEW.finding_id);
END;

-- ============================================================================
-- FINDING mutability & integrity (§2.10)
-- ============================================================================
CREATE TRIGGER trg_finding_bi BEFORE INSERT ON finding
BEGIN
    SELECT RAISE(ABORT,'finding must be created OPEN')
        WHERE NEW.status <> 'OPEN';

    SELECT RAISE(ABORT,'finding subject must belong to the same institution as the origin visit')
        WHERE NEW.subject_id IS NOT NULL
          AND (SELECT s.institution_id FROM inspected_subject s WHERE s.subject_id = NEW.subject_id)
            <> (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.origin_visit_id);
END;

CREATE TRIGGER trg_finding_bu BEFORE UPDATE ON finding
BEGIN
    SELECT RAISE(ABORT,'finding: identity/creation facts (origin/description/classification/subject) are immutable')
        WHERE OLD.finding_id <> NEW.finding_id
           OR OLD.origin_visit_id <> NEW.origin_visit_id
           OR OLD.description <> NEW.description
           OR OLD.defect_type IS NOT NEW.defect_type OR OLD.defect_type <> NEW.defect_type
           OR OLD.defect_type_other IS NOT NEW.defect_type_other OR OLD.defect_type_other <> NEW.defect_type_other
           OR OLD.location IS NOT NEW.location OR OLD.location <> NEW.location
           OR OLD.subject_id IS NOT NEW.subject_id OR OLD.subject_id <> NEW.subject_id
           OR OLD.urgency <> NEW.urgency
           OR OLD.impact <> NEW.impact
           OR OLD.created_at <> NEW.created_at
           OR OLD.created_by <> NEW.created_by;

    SELECT RAISE(ABORT,'finding: status may not move backwards and RESOLVED is terminal')
        WHERE (OLD.status = 'IN_TREATMENT' AND NEW.status = 'OPEN')
           OR (OLD.status = 'RESOLVED' AND NEW.status <> 'RESOLVED');

    SELECT RAISE(ABORT,'finding cannot be RESOLVED while a corrective action is OPEN or IN_TREATMENT')
        WHERE NEW.status = 'RESOLVED'
          AND EXISTS (SELECT 1 FROM corrective_action ca
                      WHERE ca.finding_id = NEW.finding_id AND ca.status IN ('OPEN','IN_TREATMENT'));

    SELECT RAISE(ABORT,'a finding must have at least one recorded source before leaving OPEN')
        WHERE NEW.status <> 'OPEN'
          AND NOT EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.finding_id = NEW.finding_id)
          AND NOT EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.finding_id = NEW.finding_id);
END;

-- ============================================================================
-- CORRECTIVE ACTION mutability & integrity (§2.12)
-- ============================================================================
CREATE TRIGGER trg_ca_bi BEFORE INSERT ON corrective_action
BEGIN
    SELECT RAISE(ABORT,'corrective action must be created OPEN')
        WHERE NEW.status <> 'OPEN';

    SELECT RAISE(ABORT,'no corrective action may be created under a RESOLVED finding')
        WHERE (SELECT f.status FROM finding f WHERE f.finding_id = NEW.finding_id) = 'RESOLVED';
END;

CREATE TRIGGER trg_ca_bu BEFORE UPDATE ON corrective_action
BEGIN
    SELECT RAISE(ABORT,'corrective action: identity/ownership/type/audit fields are fixed')
        WHERE OLD.action_id <> NEW.action_id
           OR OLD.finding_id <> NEW.finding_id
           OR OLD.action_type <> NEW.action_type
           OR OLD.action_type_other IS NOT NEW.action_type_other OR OLD.action_type_other <> NEW.action_type_other
           OR OLD.created_at <> NEW.created_at
           OR OLD.created_by <> NEW.created_by;

    SELECT RAISE(ABORT,'corrective action is immutable after closure')
        WHERE OLD.closed_at IS NOT NULL;

    SELECT RAISE(ABORT,'status may not move backwards and RESOLVED is terminal')
        WHERE (OLD.status = 'IN_TREATMENT' AND NEW.status = 'OPEN')
           OR (OLD.status = 'RESOLVED' AND NEW.status <> 'RESOLVED');

    SELECT RAISE(ABORT,'resolving a corrective action requires closed_at and verified_by')
        WHERE NEW.status = 'RESOLVED'
          AND (NEW.closed_at IS NULL OR NEW.verified_by IS NULL OR NEW.verified_by = '');

    SELECT RAISE(ABORT,'closure/verification fields are immutable once set')
        WHERE (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS NULL OR OLD.closed_at <> NEW.closed_at))
           OR (OLD.verified_by IS NOT NULL AND (NEW.verified_by IS NULL OR OLD.verified_by <> NEW.verified_by))
           OR (OLD.verification_note IS NOT NULL AND (NEW.verification_note IS NULL OR OLD.verification_note <> NEW.verification_note));
END;

-- ============================================================================
-- FOLLOW-UP insert validation (append-only via trg_fu_bu/trg_fu_bd)
-- ============================================================================
CREATE TRIGGER trg_fu_bi BEFORE INSERT ON follow_up
BEGIN
    SELECT RAISE(ABORT,'context visit must belong to the same institution as the finding origin')
        WHERE NEW.visit_id IS NOT NULL
          AND (SELECT v.institution_id FROM visit v WHERE v.visit_id = NEW.visit_id)
            <> (SELECT f2.institution_id
                  FROM finding f JOIN visit f2 ON f2.visit_id = f.origin_visit_id
                 WHERE f.finding_id = NEW.finding_id);

    SELECT RAISE(ABORT,'corrective action must belong to the same finding as the follow-up')
        WHERE NEW.corrective_action_id IS NOT NULL
          AND (SELECT ca.finding_id FROM corrective_action ca
               WHERE ca.action_id = NEW.corrective_action_id) <> NEW.finding_id;
END;

-- ============================================================================
-- EVIDENCE (§2.11): every field except note is immutable.
-- ============================================================================
CREATE TRIGGER trg_evidence_bi BEFORE INSERT ON evidence
BEGIN
    SELECT RAISE(ABORT,'evidence owner does not exist')
        WHERE NOT (
            (NEW.owner_kind = 'VISIT'              AND EXISTS (SELECT 1 FROM visit v WHERE v.visit_id = NEW.owner_ref))
         OR (NEW.owner_kind = 'CHECKLIST_RESPONSE' AND EXISTS (SELECT 1 FROM checklist_response cr WHERE cr.response_id = NEW.owner_ref))
         OR (NEW.owner_kind = 'ADHOC_OBSERVATION'  AND EXISTS (SELECT 1 FROM adhoc_observation o WHERE o.observation_id = NEW.owner_ref))
         OR (NEW.owner_kind = 'FINDING'            AND EXISTS (SELECT 1 FROM finding f WHERE f.finding_id = NEW.owner_ref))
         OR (NEW.owner_kind = 'CORRECTIVE_ACTION'  AND EXISTS (SELECT 1 FROM corrective_action ca WHERE ca.action_id = NEW.owner_ref))
         OR (NEW.owner_kind = 'FOLLOW_UP'          AND EXISTS (SELECT 1 FROM follow_up fu WHERE fu.followup_id = NEW.owner_ref))
        );
END;

CREATE TRIGGER trg_evidence_bu BEFORE UPDATE ON evidence
BEGIN
    SELECT RAISE(ABORT,'evidence metadata is immutable except note')
        WHERE OLD.evidence_id <> NEW.evidence_id
           OR OLD.owner_kind <> NEW.owner_kind
           OR OLD.owner_ref <> NEW.owner_ref
           OR OLD.storage_ref <> NEW.storage_ref
           OR OLD.content_hash IS NOT NEW.content_hash OR OLD.content_hash <> NEW.content_hash
           OR OLD.file_name <> NEW.file_name
           OR OLD.mime_type <> NEW.mime_type
           OR OLD.file_size IS NOT NEW.file_size OR OLD.file_size <> NEW.file_size
           OR OLD.captured_at IS NOT NEW.captured_at OR OLD.captured_at <> NEW.captured_at
           OR OLD.device_note IS NOT NEW.device_note OR OLD.device_note <> NEW.device_note
           OR OLD.recorded_at <> NEW.recorded_at
           OR OLD.recorded_by <> NEW.recorded_by;
END;

-- ============================================================================
-- REPORT (§2.15)
-- ============================================================================
CREATE TRIGGER trg_report_bu BEFORE UPDATE ON report
BEGIN
    SELECT RAISE(ABORT,'report metadata is immutable after GENERATED')
        WHERE OLD.status = 'GENERATED';

    SELECT RAISE(ABORT,'report: scope/snapshot/generation fields are fixed')
        WHERE OLD.report_id <> NEW.report_id
           OR OLD.report_type <> NEW.report_type
           OR OLD.mission_id IS NOT NEW.mission_id OR OLD.mission_id <> NEW.mission_id
           OR OLD.visit_id IS NOT NEW.visit_id OR OLD.visit_id <> NEW.visit_id
           OR OLD.institution_id IS NOT NEW.institution_id OR OLD.institution_id <> NEW.institution_id
           OR OLD.data_snapshot_ref <> NEW.data_snapshot_ref
           OR OLD.generated_at <> NEW.generated_at
           OR OLD.generated_by <> NEW.generated_by;

    SELECT RAISE(ABORT,'report: artifacts are append-only')
        WHERE (OLD.artifacts IS NOT NULL AND NEW.artifacts IS NULL)
           OR (OLD.artifacts IS NOT NULL AND NEW.artifacts NOT LIKE OLD.artifacts || '%');
END;
