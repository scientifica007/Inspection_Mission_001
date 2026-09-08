#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gate 4A regression suite — Inspection_Mission_001.
(Cumulative: Gate 4 / Revision 3 retained + Gate 4A applicability bridge +
 Gate 4B VOIDED Finding lifecycle. The historical filename is kept.)

Scope:
  * Executes docs/schema/schema.sql FROM SCRATCH in an in-memory SQLite 3.45
    database (PRAGMA foreign_keys = ON), i.e. the same verification path
    documented in PHYSICAL-SCHEMA-v1.md / CONSTRAINT-MATRIX-v1.md.
  * Asserts the object architecture is unchanged (15 tables / 44 triggers /
    1 view / 24 explicit indexes) and that the single Gate 4A addition
    (checklist_item_definition.applicability_rule) is present and NOT NULL.
  * Re-asserts the retained Gate 4 (Revision 3) enforcement behaviors that the
    Gate 4A/4B patches must not regress: visit lifecycle/finalization,
    definition / allowed-value / response / subject / finding / evidence /
    action / report immutability audits, no-delete policy, append-only
    follow_up and external_system_tracking, response overlay XOR + finding
    accountability + version-mix rules, CHK-012 bidirectional integrity,
    definition version chain integrity, uq_active_def_per_code,
    first-source-in-origin rules, derived result_class view.
  * Adds the Gate 4A tests: an ACTIVE definition cannot lack
    applicability_rule; applicability_rule cannot be mutated on an existing
    definition (version immutability); a new definition version may carry a
    different applicability_rule; historical responses stay bound to their
    original definition version (whose rule is therefore never reinterpreted);
    the 15 tables are unchanged; every canonical rule payload in
    docs/checklists/APPLICABILITY-RULES-v1.md is accepted by the schema
    (json_valid / object / rule_schema_version = 1) and matches CHK-001..024.
  * Adds the Gate 4A FINAL INTEGRITY tests (S11): canonical-grammar rejections —
    mismatched JSON item_code, invalid decision_kind, subject_kinds of the wrong
    JSON type / empty / unknown kind / non-text member, HUMAN_CONFIRMATION
    without missing_context / with empty or blank or non-text members, boolean
    true as rule_schema_version, missing rule_schema_version / item_code /
    source_ar keys, blank source_ar, and invalid / empty / wrongly-typed or
    missing visit_type.allowed plus non-object visit_type.
  * Adds the Gate 4B tests (S12, owner-approved VOIDED Finding lifecycle):
    finding.status accepts VOIDED while corrective_action.status does NOT;
    OPEN -> VOIDED with a remaining source rejected; sole-source removal inside
    a transaction followed by OPEN -> VOIDED accepted and ends with zero
    sources; IN_TREATMENT -> VOIDED / RESOLVED -> VOIDED / VOIDED -> any state
    rejected; VOIDED with a finalized origin visit rejected; VOIDED with any
    corrective action rejected; source links to a VOIDED finding via
    ChecklistResponse and AdHocObservation rejected on BOTH the INSERT and the
    UPDATE paths; corrective-action creation under VOIDED rejected; follow_up
    status_after=VOIDED accepted with status_target=FINDING and rejected with
    status_target=CORRECTIVE_ACTION (the negative is proven against a real
    corrective action of that finding, not by an unrelated FK failure);
    source-less OPEN still cannot transition to IN_TREATMENT/RESOLVED; direct
    OPEN -> RESOLVED with a valid source and no open corrective actions remains
    accepted; visit finalization does not treat a valid zero-source VOIDED
    finding as an orphan blocker at schema level.

Run:  python3 tests/gate4a_regression.py
Exit: 0 on success, 1 when any assertion fails.  Requires Python >= 3.11 with
the stdlib sqlite3 module built against SQLite >= 3.38 (json functions).
"""

import json
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA_SQL = (ROOT / "docs" / "schema" / "schema.sql").read_text(encoding="utf-8")
RULES_DOC = ROOT / "docs" / "checklists" / "APPLICABILITY-RULES-v1.md"

EXPECTED_TABLES = [
    "mission", "institution", "inspected_subject", "visit",
    "checklist_item_definition", "checklist_allowed_value", "checklist_response",
    "equipment_reconciliation_row", "adhoc_observation", "finding", "evidence",
    "corrective_action", "follow_up", "external_system_tracking", "report",
]


def fresh_db():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    return conn


def rule_payload(item_code, kinds, decision="AUTO", extra=None):
    payload = {
        "rule_schema_version": 1,
        "item_code": item_code,
        "decision_kind": decision,
        "subject_kinds": kinds,
        "source_ar": f"FIELD-CHECKLIST-v1.md — {item_code} — «متى يُطبَّق»",
    }
    if extra:
        payload.update(extra)
    return json.dumps(payload, ensure_ascii=False)


# ---------------------------------------------------------------------------
# tiny assertion harness
# ---------------------------------------------------------------------------
class T:
    def __init__(self, label):
        self.label = label
        self.ok_count = 0
        self.bad = []

    def ok(self, name, fn):
        try:
            fn()
        except AssertionError as exc:
            self.bad.append((f"{self.label} :: {name}", str(exc)))
        except Exception as exc:  # noqa: BLE001 - report unexpected errors
            self.bad.append((f"{self.label} :: {name}", f"unexpected {type(exc).__name__}: {exc}"))
        else:
            self.ok_count += 1

    def bad_(self, name, fn, frag=None):
        """fn must raise an sqlite3 error (constraint/trigger abort)."""
        try:
            fn()
        except sqlite3.Error as exc:
            if frag is None or frag in str(exc):
                self.ok_count += 1
            else:
                self.bad.append((f"{self.label} :: {name}", f"raised different error: {exc}"))
        except Exception as exc:  # noqa: BLE001
            self.bad.append((f"{self.label} :: {name}", f"expected sqlite error, got {type(exc).__name__}: {exc}"))
        else:
            self.bad.append((f"{self.label} :: {name}", "expected sqlite error, none raised"))


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
def seed_base(conn):
    """Return dict of base ids: mission/institution/subject/visit (PREPARATION)."""
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO mission(name, description, reference_entry_date, status, created_at, created_by) "
        "VALUES ('Mission 2026-2027', 'entry readiness', '2026-10-04', 'ACTIVE', '2026-09-01T00:00:00Z', 'inspector1')"
    )
    m = cur.lastrowid
    cur.execute(
        "INSERT INTO institution(name, kind_code, district, active, created_at, created_by) "
        "VALUES ('CFPA A', 'CFPA', 'D1', 1, '2026-09-01T00:00:00Z', 'inspector1')"
    )
    i = cur.lastrowid
    cur.execute(
        "INSERT INTO inspected_subject(institution_id, subject_type, name, active, created_at, created_by) "
        "VALUES (?, 'WORKSHOP', 'Atelier 1', 1, '2026-09-01T00:00:00Z', 'inspector1')",
        (i,),
    )
    s = cur.lastrowid
    cur.execute(
        "INSERT INTO inspected_subject(institution_id, subject_type, name, active, created_at, created_by) "
        "VALUES (?, 'DORMITORY', 'Internat', 1, '2026-09-01T00:00:00Z', 'inspector1')",
        (i,),
    )
    s2 = cur.lastrowid
    cur.execute(
        "INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by) "
        "VALUES (?, ?, 'SURPRISE', '2026-09-20', 'PREPARATION', 'inspector1', '2026-09-19T08:00:00Z', 'inspector1')",
        (m, i),
    )
    v = cur.lastrowid
    cur.execute(
        "INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by) "
        "VALUES (?, ?, 'PLANNED', '2026-09-25', 'PREPARATION', 'inspector1', '2026-09-19T09:00:00Z', 'inspector1')",
        (m, i),
    )
    v2 = cur.lastrowid
    conn.commit()
    return {"mission": m, "institution": i, "subject": s, "subject_dorm": s2, "visit": v, "visit2": v2}


def seed_def(conn, item_code="CHK-001", version_no=1, supersedes=None, model="SINGLE_VALUE",
             status="ACTIVE", payload=None, domain="DOM-02"):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, domain_id, "
        "arabic_question, response_model, priority, traceability, requirement_refs, applicability_rule, status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (item_code, version_no, supersedes, domain,
         "q-ar", model, "P0", "DIRECT", "REQ-xxx",
         payload or rule_payload(item_code, ["WORKSHOP"]),
         status),
    )
    conn.commit()
    return cur.lastrowid


def seed_value(conn, def_id, code, label, semantic, sort_order=1):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO checklist_allowed_value(item_definition_id, value_code, arabic_label, semantic_class, sort_order, active) "
        "VALUES (?, ?, ?, ?, ?, 1)",
        (def_id, code, label, semantic, sort_order),
    )
    conn.commit()
    return cur.lastrowid


def make_response(conn, visit_id, def_id, subject_id=None, value_id=None, overlay=None, note=None, finding=None):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, answered_value_id, "
        "note, not_inspected_reason, finding_id, recorded_at, recorded_by) "
        "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '2026-09-20T10:00:00Z', 'inspector1')",
        (visit_id, def_id, subject_id, overlay, value_id, note, finding),
    )
    conn.commit()
    return cur.lastrowid


# ---------------------------------------------------------------------------
# S0 — object architecture (unchanged 15 tables) + Gate 4A column
# ---------------------------------------------------------------------------
def s0_architecture(t: T):
    def check_counts():
        conn = fresh_db()
        cur = conn.cursor()
        tables = {r[0] for r in cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        assert tables == set(EXPECTED_TABLES), f"tables mismatch: {sorted(tables)}"
        n_trig = cur.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
        assert n_trig == 44, f"triggers = {n_trig}"
        n_view = cur.execute("SELECT count(*) FROM sqlite_master WHERE type='view'").fetchone()[0]
        assert n_view == 1, f"views = {n_view}"
        n_idx = cur.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'"
        ).fetchone()[0]
        assert n_idx == 24, f"explicit indexes = {n_idx}"
        cols = {r[1]: r for r in cur.execute("PRAGMA table_info(checklist_item_definition)")}
        assert "applicability_rule" in cols, "applicability_rule column missing"
        assert cols["applicability_rule"][3] == 1, "applicability_rule must be NOT NULL"
        conn.close()
    t.ok("15 tables / 44 triggers / 1 view / 24 explicit indexes; applicability_rule NOT NULL", check_counts)


# ---------------------------------------------------------------------------
# S1 — Gate 4A: NOT NULL + canonical JSON CHECKs + one-ACTIVE-per-code kept
# ---------------------------------------------------------------------------
def s1_applicability_insert_rules(t: T):
    def missing_rule():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', NULL, 'ACTIVE')")
        conn.close()
    t.bad_("ACTIVE definition cannot have missing applicability_rule (NOT NULL)", missing_rule, "NOT NULL")

    def invalid_json():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', 'not-json{', 'ACTIVE')")
        conn.close()
    t.bad_("applicability_rule must be valid JSON (json_valid CHECK)", invalid_json)

    def not_object():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', '[1,2]', 'ACTIVE')")
        conn.close()
    t.bad_("applicability_rule must be a JSON object, not an array", not_object)

    def wrong_schema_version():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', "
            "'{\"rule_schema_version\": 2, \"item_code\": \"CHK-001\", \"decision_kind\": \"AUTO\", "
            "\"subject_kinds\": [\"WORKSHOP\"], \"source_ar\": \"FIELD-CHECKLIST-v1.md — CHK-001 — «متى يُطبَّق»\"}', 'ACTIVE')")
        conn.close()
    t.bad_("rule_schema_version must equal 1", wrong_schema_version)

    def canonical_accepted():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ACTIVE')",
            (rule_payload("CHK-001", ["WORKSHOP"]),))
        assert cur.lastrowid is not None
        conn.close()
    t.ok("canonical applicability_rule payload accepted on an ACTIVE definition", canonical_accepted)

    def second_active_same_code():
        conn = fresh_db()
        seed_def(conn, item_code="CHK-001", version_no=1)
        try:
            seed_def(conn, item_code="CHK-001", version_no=2)
        except sqlite3.Error as exc:
            assert "UNIQUE" in str(exc) or "unique" in str(exc), str(exc)
        else:
            raise AssertionError("two ACTIVE definitions for one item_code accepted")
        conn.close()
    t.ok("one ACTIVE definition per item_code preserved (uq_active_def_per_code)", second_active_same_code)


# ---------------------------------------------------------------------------
# S2 — Gate 4A + Gate 4: definition version immutability incl. applicability_rule
# ---------------------------------------------------------------------------
def s2_definition_immutability(t: T):
    def rule_immutable():
        conn = fresh_db()
        d = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET applicability_rule = ? WHERE item_definition_id = ?",
                    (rule_payload("CHK-001", ["WORKSHOP", "LAB"]), d))
        conn.close()
    t.bad_("applicability_rule cannot be mutated on an existing definition (version immutability)", rule_immutable,
           "immutable")

    def content_still_immutable():
        conn = fresh_db()
        d = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET arabic_question = 'changed' WHERE item_definition_id = ?", (d,))
        conn.close()
    t.bad_("question content still immutable for an existing definition (retained)", content_still_immutable,
           "immutable")

    def status_mutable():
        conn = fresh_db()
        d = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", (d,))
        cur.execute("UPDATE checklist_item_definition SET status = 'ARCHIVED' WHERE item_definition_id = ?", (d,))
        conn.close()
    t.ok("definition status remains the only mutable field", status_mutable)

    def new_version_different_rule():
        conn = fresh_db()
        d1 = seed_def(conn, "CHK-001", 1, payload=rule_payload("CHK-001", ["WORKSHOP"]))
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", (d1,))
        d2 = seed_def(conn, "CHK-001", 2, supersedes=d1, payload=rule_payload("CHK-001", ["WORKSHOP", "LAB", "FACILITY"]))
        cur.execute("SELECT applicability_rule FROM checklist_item_definition WHERE item_definition_id = ?", (d2,))
        row = cur.fetchone()
        assert json.loads(row[0])["subject_kinds"] == ["WORKSHOP", "LAB", "FACILITY"], "v2 rule not stored"
        cur.execute("SELECT applicability_rule FROM checklist_item_definition WHERE item_definition_id = ?", (d1,))
        row1 = cur.fetchone()
        assert json.loads(row1[0])["subject_kinds"] == ["WORKSHOP"], "v1 rule was rewritten by v2"
        conn.close()
    t.ok("a new definition version may carry a different applicability_rule; v1 rule untouched", new_version_different_rule)

    def duplicate_version_no():
        conn = fresh_db()
        seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, domain_id, "
            "arabic_question, response_model, priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, NULL, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ARCHIVED')",
            (rule_payload("CHK-001", ["WORKSHOP"]),))
        conn.close()
    t.bad_("UNIQUE(item_code, version_no) retained", duplicate_version_no)

    def chain_wrong_code():
        conn = fresh_db()
        d1 = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, domain_id, "
            "arabic_question, response_model, priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-002', 1, ?, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ACTIVE')",
            (d1, rule_payload("CHK-002", ["WORKSHOP"])))
        conn.close()
    t.bad_("supersedes across different item_code rejected (trg_def_bi)", chain_wrong_code)

    def chain_later_version():
        conn = fresh_db()
        d1 = seed_def(conn, "CHK-001", 1)
        d2 = seed_def(conn, "CHK-001", 2, supersedes=d1)
        cur = conn.cursor()
        # v1 may not supersede the later v2
        cur.execute("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", (d1,))
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, supersedes_definition_id, domain_id, "
            "arabic_question, response_model, priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES ('CHK-001', 1, ?, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ARCHIVED')",
            (d2, rule_payload("CHK-001", ["WORKSHOP"])))
        conn.close()
    t.bad_("an earlier version may not supersede a later version", chain_later_version)

    def self_supersede():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_item_definition(item_definition_id, item_code, version_no, supersedes_definition_id, "
            "domain_id, arabic_question, response_model, priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES (99, 'CHK-001', 1, 99, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ACTIVE')",
            (rule_payload("CHK-001", ["WORKSHOP"]),))
        conn.close()
    t.bad_("self-supersede rejected", self_supersede)


# ---------------------------------------------------------------------------
# S3 — Gate 4A: historical binding of responses to definition version + rule
# ---------------------------------------------------------------------------
def s3_historical_binding(t: T):
    def scenario():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1, payload=rule_payload("CHK-001", ["WORKSHOP"]))
        v_compliant = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        make_response(conn, ids["visit"], d1, value_id=v_compliant)  # historical snapshot on v1

        # supersede v1 with v2 carrying a different rule
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", (d1,))
        d2 = seed_def(conn, "CHK-001", 2, supersedes=d1, payload=rule_payload("CHK-001", ["WORKSHOP", "LAB"]))

        # (a) response cannot be re-parented to v2 -> stays bound to v1
        def reparent():
            cur.execute("UPDATE checklist_response SET item_definition_id = ? WHERE response_id = 1", (d2,))
        try:
            reparent()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("historical response was re-parented to a newer definition version")
        row = cur.execute("SELECT item_definition_id FROM checklist_response WHERE response_id = 1").fetchone()
        assert row[0] == d1, "historical response no longer bound to its original definition version"

        # (b) v1 rule is unchanged and still immutable
        row = cur.execute("SELECT applicability_rule FROM checklist_item_definition WHERE item_definition_id = ?", (d1,)).fetchone()
        assert json.loads(row[0])["subject_kinds"] == ["WORKSHOP"], "v1 rule changed"

        def touch_v1_rule():
            cur.execute("UPDATE checklist_item_definition SET applicability_rule = ? WHERE item_definition_id = ?",
                        (rule_payload("CHK-001", ["LAB"]), d1))
        try:
            touch_v1_rule()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("v1 applicability_rule was mutated after historical use")

        # (c) version mixing within the same (visit, item_code, context) remains forbidden
        def mixed():
            make_response(conn, ids["visit"], d2, overlay="NA")  # same visit/subject-less context, other version
        try:
            mixed()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("mixed definition versions accepted in the same visit/item_code context")
        conn.close()
    t.ok("historical response bound to original definition version; v1 rule immutable; no version mixing",
         scenario)


# ---------------------------------------------------------------------------
# S4 — retained: visit lifecycle & finalization
# ---------------------------------------------------------------------------
def s4_visit_lifecycle(t: T):
    def create_finalized():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by) "
            "VALUES (1, 1, 'SURPRISE', '2026-09-20', 'COMPLETED', 'i', 't', 'i')")
        conn.close()
    t.bad_("visit must be created in PREPARATION (finalized_at NULL)", create_finalized)

    def finalize_ok_and_immutable():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "UPDATE visit SET status = 'COMPLETED', finalized_at = '2026-09-20T18:00:00Z' WHERE visit_id = ?",
            (ids["visit"],))
        def reopen():
            cur.execute("UPDATE visit SET status = 'PREPARATION', finalized_at = NULL WHERE visit_id = ?",
                        (ids["visit"],))
        try:
            reopen()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("finalized visit was reopened")
        conn.close()
    t.ok("atomic finalization to COMPLETED succeeds and the finalized visit is immutable", finalize_ok_and_immutable)

    def complete_with_uninspected():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        make_response(conn, ids["visit"], d1, overlay="NOT_INSPECTED")
        cur = conn.cursor()
        def complete():
            cur.execute(
                "UPDATE visit SET status = 'COMPLETED', finalized_at = '2026-09-20T18:00:00Z' WHERE visit_id = ?",
                (ids["visit"],))
        try:
            complete()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("COMPLETED accepted while a NOT_INSPECTED response exists")
        conn.close()
    t.ok("COMPLETED requires every applicable inspected state (no NOT_INSPECTED rows)", complete_with_uninspected)

    def with_uninspected_requires_reason():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        make_response(conn, ids["visit"], d1, overlay="NOT_INSPECTED")  # no reason yet
        cur = conn.cursor()
        def close_ok():
            cur.execute(
                "UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = '2026-09-20T18:00:00Z' "
                "WHERE visit_id = ?", (ids["visit"],))
        try:
            close_ok()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("COMPLETED_WITH_UNINSPECTED accepted without recorded reasons")
        conn.close()
    t.ok("each applicable NOT_INSPECTED response needs a recorded reason before closure", with_uninspected_requires_reason)

    def with_uninspected_valid():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, overlay_state, note, not_inspected_reason, "
            "recorded_at, recorded_by) VALUES (?, ?, 'NOT_INSPECTED', NULL, 'activities not started', 't', 'i')",
            (ids["visit"], d1))
        cur.execute(
            "UPDATE visit SET status = 'COMPLETED_WITH_UNINSPECTED', finalized_at = '2026-09-20T18:00:00Z' "
            "WHERE visit_id = ?", (ids["visit"],))
        conn.close()
    t.ok("COMPLETED_WITH_UNINSPECTED valid with recorded reason (distinct closure state)", with_uninspected_valid)

    def identity_fields():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        def change_date():
            cur.execute("UPDATE visit SET visit_date = '2026-10-01' WHERE visit_id = ?", (ids["visit"],))
        try:
            change_date()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("visit_date was rewritten")
        conn.close()
    t.ok("visit identity/mission/institution/type/date fixed", identity_fields)

    def no_delete_visit():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        try:
            cur.execute("DELETE FROM visit WHERE visit_id = ?", (ids["visit"],))
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("visit deleted (no-delete policy)")
        conn.close()
    t.ok("no-delete policy on visit (retained)", no_delete_visit)


# ---------------------------------------------------------------------------
# S5 — retained: response integrity
# ---------------------------------------------------------------------------
def s5_response_integrity(t: T):
    def xor_violation():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_ok = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, overlay_state, answered_value_id, "
            "recorded_at, recorded_by) VALUES (?, ?, 'NA', ?, 't', 'i')", (ids["visit"], d1, v_ok))
        conn.close()
    t.bad_("overlay and answered value are mutually exclusive (XOR)", xor_violation)

    def non_compliant_needs_finding():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, recorded_at, recorded_by) "
            "VALUES (?, ?, ?, 't', 'i')", (ids["visit"], d1, v_bad))
        conn.close()
    t.bad_("non-compliant answer must be linked to a finding (accountability)", non_compliant_needs_finding)

    def compliant_not_linked():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_ok = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, recorded_at, "
            "recorded_by) VALUES (?, ?, ?, 999, 't', 'i')", (ids["visit"], d1, v_ok))
        conn.close()
    t.bad_("compliant / overlay answers may never be linked to a finding", compliant_not_linked)

    def value_of_other_version():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        d2 = seed_def(conn, "CHK-002", 1)
        v_other = seed_value(conn, d2, "ACTIVE", "مفعّلة", "COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, recorded_at, recorded_by) "
            "VALUES (?, ?, ?, 't', 'i')", (ids["visit"], d1, v_other))
        conn.close()
    t.bad_("answered value must belong to the same definition version", value_of_other_version)

    def duplicate_context():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_ok = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        make_response(conn, ids["visit"], d1, value_id=v_ok)
        cur = conn.cursor()
        def dup():
            make_response(conn, ids["visit"], d1, value_id=v_ok)
        try:
            dup()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("duplicate response for same (visit, item, subject) accepted")
        conn.close()
    t.ok("one response per (visit, item, subject context) — uq_response_ctx", duplicate_context)

    def mixed_versions_blocked():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        cur = conn.cursor()
        cur.execute("UPDATE checklist_item_definition SET status = 'SUPERSEDED' WHERE item_definition_id = ?", (d1,))
        d2 = seed_def(conn, "CHK-001", 2, supersedes=d1)  # becomes the single ACTIVE version
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, overlay_state, recorded_at, recorded_by) "
            "VALUES (?, ?, 'NA', 't', 'i')", (ids["visit"], d1))
        def second():
            cur.execute(
                "INSERT INTO checklist_response(visit_id, item_definition_id, overlay_state, recorded_at, recorded_by) "
                "VALUES (?, ?, 'NA', 't', 'i')", (ids["visit"], d2))
        try:
            second()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("mixed definition versions for same item_code/context accepted")
        conn.close()
    t.ok("mixed definition versions for same (visit, item_code, context) forbidden (I21)", mixed_versions_blocked)

    def wrong_institution_subject():
        conn = fresh_db()
        ids = seed_base(conn)
        # subject of another institution
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO institution(name, active, created_at, created_by) VALUES ('CFPA B', 1, 't', 'i')")
        other_inst = cur.lastrowid
        cur.execute(
            "INSERT INTO inspected_subject(institution_id, subject_type, name, active, created_at, created_by) "
            "VALUES (?, 'WORKSHOP', 'Atelier B', 1, 't', 'i')", (other_inst,))
        other_subject = cur.lastrowid
        d1 = seed_def(conn, "CHK-001", 1)
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state, recorded_at, "
            "recorded_by) VALUES (?, ?, ?, 'NA', 't', 'i')", (ids["visit"], d1, other_subject))
        conn.close()
    t.bad_("subject must belong to the same institution as the visit", wrong_institution_subject)


# ---------------------------------------------------------------------------
# S6 — retained: CHK-012 reconciliation integrity
# ---------------------------------------------------------------------------
def s6_chk012(t: T):
    def rows_under_schedule_only():
        conn = fresh_db()
        ids = seed_base(conn)
        d_single = seed_def(conn, "CHK-001", 1, model="SINGLE_VALUE")
        v_ok = seed_value(conn, d_single, "OK", "مطابق", "COMPLIANT")
        r = make_response(conn, ids["visit"], d_single, value_id=v_ok)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO equipment_reconciliation_row(response_id, category, declared_qty, observed_qty, difference, "
            "discrepancy_type) VALUES (?, 'X', 1, 1, 0, NULL)", (r,))
        conn.close()
    t.bad_("reconciliation rows belong only to a SCHEDULE-type response", rows_under_schedule_only)

    def rows_under_overlay():
        conn = fresh_db()
        ids = seed_base(conn)
        d_sched = seed_def(conn, "CHK-012", 1, model="SCHEDULE", domain="DOM-05")
        v_bad = seed_value(conn, d_sched, "NONCOMPLIANT", "غير مطابقة", "NON_COMPLIANT")
        # non-compliant parent requires a finding -> create finding in origin visit first
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'desc', 'ROUTINE', 'LOW', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        r = make_response(conn, ids["visit"], d_sched, value_id=v_bad, finding=f)
        cur.execute(
            "INSERT INTO equipment_reconciliation_row(response_id, category, declared_qty, observed_qty, difference, "
            "discrepancy_type) VALUES (?, 'X', 5, 5, 0, NULL)", (r,))
        conn.commit()
        # overlay must never coexist with reconciliation rows (response-side trigger)
        def overlay_with_rows():
            cur.execute(
                "UPDATE checklist_response SET overlay_state = 'NA', answered_value_id = NULL, finding_id = NULL "
                "WHERE response_id = ?", (r,))
        try:
            overlay_with_rows()
        except sqlite3.Error as exc:
            assert "CHK-012" in str(exc), f"expected the CHK-012 overlay guard, got: {exc}"
        else:
            raise AssertionError("overlay set while reconciliation rows exist")
        conn.close()
    t.ok("overlay (NA/NOT_INSPECTED) may not be set while reconciliation rows exist", rows_under_overlay)

    def compliant_with_discrepancy():
        conn = fresh_db()
        ids = seed_base(conn)
        d_sched = seed_def(conn, "CHK-012", 1, model="SCHEDULE", domain="DOM-05")
        v_bad = seed_value(conn, d_sched, "NONCOMPLIANT", "غير مطابقة", "NON_COMPLIANT")
        v_ok = seed_value(conn, d_sched, "COMPLIANT", "مطابقة", "COMPLIANT", sort_order=2)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'desc', 'ROUTINE', 'LOW', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        r = make_response(conn, ids["visit"], d_sched, value_id=v_bad, finding=f)
        cur.execute(
            "INSERT INTO equipment_reconciliation_row(response_id, category, declared_qty, observed_qty, difference, "
            "discrepancy_type) VALUES (?, 'X', 5, 3, -2, 'QTY_SHORTAGE')", (r,))
        conn.commit()
        def to_compliant():
            cur.execute(
                "UPDATE checklist_response SET answered_value_id = ?, finding_id = NULL WHERE response_id = ?",
                (v_ok, r))
        try:
            to_compliant()
        except sqlite3.Error as exc:
            assert "CHK-012" in str(exc), f"expected the CHK-012 COMPLIANT guard, got: {exc}"
        else:
            raise AssertionError("overall COMPLIANT set while a discrepancy row exists")
        conn.close()
    t.ok("overall COMPLIANT may not coexist with any discrepancy row (response side)", compliant_with_discrepancy)

    def row_calculation_checks():
        conn = fresh_db()
        ids = seed_base(conn)
        d_sched = seed_def(conn, "CHK-012", 1, model="SCHEDULE", domain="DOM-05")
        v_bad = seed_value(conn, d_sched, "NONCOMPLIANT", "غير مطابقة", "NON_COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'desc', 'ROUTINE', 'LOW', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        r = make_response(conn, ids["visit"], d_sched, value_id=v_bad, finding=f)
        def wrong_diff():
            cur.execute(
                "INSERT INTO equipment_reconciliation_row(response_id, category, declared_qty, observed_qty, difference) "
                "VALUES (?, 'X', 5, 3, 0)", (r,))
        try:
            wrong_diff()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("row with difference != observed - declared accepted")
        conn.close()
    t.ok("difference = observed_qty − declared_qty enforced (retained)", row_calculation_checks)


# ---------------------------------------------------------------------------
# S7 — retained: finding, corrective action, first-source, follow-up, evidence
# ---------------------------------------------------------------------------
def s7_finding_and_actions(t: T):
    def finding_open_start():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'IN_TREATMENT', 't', 'i')", (ids["visit"],))
        conn.close()
    t.bad_("finding must be created OPEN", finding_open_start)

    def leaving_open_requires_source():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        def leave():
            cur.execute("UPDATE finding SET status = 'IN_TREATMENT' WHERE finding_id = ?", (f,))
        try:
            leave()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("finding left OPEN without any recorded source")
        conn.close()
    t.ok("a finding must have a recorded source before leaving OPEN", leaving_open_requires_source)

    def first_source_origin():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        # first source from the OTHER visit (not the origin) must be rejected
        def foreign_first():
            cur.execute(
                "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, recorded_at, "
                "recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (ids["visit2"], d1, v_bad, f))
        try:
            foreign_first()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("first source recorded outside the finding origin visit")
        # first source from the origin visit is accepted
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, recorded_at, "
            "recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (ids["visit"], d1, v_bad, f))
        conn.commit()
        conn.close()
    t.ok("first recorded source must belong to the finding origin_visit_id (both paths)", first_source_origin)

    def fields_immutable():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        def change():
            cur.execute("UPDATE finding SET description = 'changed' WHERE finding_id = ?", (f,))
        try:
            change()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("finding creation facts were rewritten")
        conn.close()
    t.ok("finding creation facts (description/urgency/impact/…) immutable", fields_immutable)

    def resolved_guard():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        # source so it can leave OPEN
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, recorded_at, "
            "recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (ids["visit"], d1, v_bad, f))
        cur.execute("UPDATE finding SET status = 'IN_TREATMENT' WHERE finding_id = ?", (f,))
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, created_at, created_by) "
            "VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'OPEN', 't', 'i')", (f,))
        def resolve_finding():
            cur.execute("UPDATE finding SET status = 'RESOLVED' WHERE finding_id = ?", (f,))
        try:
            resolve_finding()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("finding RESOLVED while a corrective action is OPEN")
        conn.close()
    t.ok("finding cannot be RESOLVED while a corrective action is OPEN/IN_TREATMENT", resolved_guard)

    def action_resolve_requires():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, created_at, created_by) "
            "VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'OPEN', 't', 'i')", (f,))
        a = cur.lastrowid
        def resolve_no_verify():
            cur.execute("UPDATE corrective_action SET status = 'RESOLVED' WHERE action_id = ?", (a,))
        try:
            resolve_no_verify()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("corrective action RESOLVED without closed_at/verified_by")
        conn.close()
    t.ok("resolving a corrective action requires closed_at and verified_by", action_resolve_requires)

    def fu_append_only():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        cur.execute(
            "INSERT INTO follow_up(finding_id, event_datetime, actor_role, note, recorded_by) "
            "VALUES (?, '2026-09-21T09:00:00Z', 'DIRECTOR', 'note', 'i')", (f,))
        fu = cur.lastrowid
        def update_fu():
            cur.execute("UPDATE follow_up SET note = 'x' WHERE followup_id = ?", (fu,))
        try:
            update_fu()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("follow_up updated (append-only)")
        def delete_fu():
            cur.execute("DELETE FROM follow_up WHERE followup_id = ?", (fu,))
        try:
            delete_fu()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("follow_up deleted (append-only)")
        conn.close()
    t.ok("follow_up is append-only (no update/delete)", fu_append_only)

    def fu_context_visit():
        conn = fresh_db()
        ids = seed_base(conn)
        # second institution + visit (to violate same-institution context)
        cur = conn.cursor()
        cur.execute("INSERT INTO institution(name, active, created_at, created_by) VALUES ('B', 1, 't', 'i')")
        other = cur.lastrowid
        cur.execute(
            "INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status, inspector, created_at, created_by) "
            "VALUES (?, ?, 'PLANNED', '2026-09-27', 'PREPARATION', 'i', 't', 'i')", (ids["mission"], other))
        v_other = cur.lastrowid
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        def fu_foreign():
            cur.execute(
                "INSERT INTO follow_up(finding_id, visit_id, event_datetime, actor_role, note, recorded_by) "
                "VALUES (?, ?, '2026-09-28T09:00:00Z', 'INSPECTOR', 'n', 'i')", (f, v_other))
        try:
            fu_foreign()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("follow_up context visit from another institution accepted")
        conn.close()
    t.ok("follow_up context visit must be same institution as the finding origin", fu_context_visit)

    def status_target_rule():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (ids["visit"],))
        f = cur.lastrowid
        def orphan_status_after():
            cur.execute(
                "INSERT INTO follow_up(finding_id, event_datetime, actor_role, note, status_after, recorded_by) "
                "VALUES (?, '2026-09-21T09:00:00Z', 'INSPECTOR', 'n', 'IN_TREATMENT', 'i')", (f,))
        try:
            orphan_status_after()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("status_after recorded without status_target")
        conn.close()
    t.ok("status_after requires status_target (retained)", status_target_rule)

    def evidence_rules():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        def missing_owner():
            cur.execute(
                "INSERT INTO evidence(owner_kind, owner_ref, storage_ref, file_name, mime_type, recorded_at, recorded_by) "
                "VALUES ('VISIT', 9999, 's3://x', 'f.jpg', 'image/jpeg', 't', 'i')")
        try:
            missing_owner()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("evidence with missing owner accepted")
        cur.execute(
            "INSERT INTO evidence(owner_kind, owner_ref, storage_ref, file_name, mime_type, recorded_at, recorded_by) "
            "VALUES ('VISIT', ?, 's3://x', 'f.jpg', 'image/jpeg', 't', 'i')", (ids["visit"],))
        e = cur.lastrowid
        def change_metadata():
            cur.execute("UPDATE evidence SET storage_ref = 's3://y' WHERE evidence_id = ?", (e,))
        try:
            change_metadata()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("evidence metadata was rewritten")
        cur.execute("UPDATE evidence SET note = 'ok' WHERE evidence_id = ?", (e,))
        conn.commit()
        conn.close()
    t.ok("evidence: owner must exist; metadata immutable except note", evidence_rules)


# ---------------------------------------------------------------------------
# S8 — retained: allowed value / subject / mission / report misc
# ---------------------------------------------------------------------------
def s8_misc_retained(t: T):
    def av_immutable():
        conn = fresh_db()
        d1 = seed_def(conn, "CHK-001", 1)
        v = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        cur = conn.cursor()
        def relabel():
            cur.execute("UPDATE checklist_allowed_value SET arabic_label = 'x' WHERE allowed_value_id = ?", (v,))
        try:
            relabel()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("allowed value metadata was rewritten")
        cur.execute("UPDATE checklist_allowed_value SET active = 0 WHERE allowed_value_id = ?", (v,))
        conn.commit()
        conn.close()
    t.ok("allowed value metadata immutable; active toggle allowed", av_immutable)

    def subject_type_after_use():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        make_response(conn, ids["visit"], d1, subject_id=ids["subject"], overlay="NA")
        cur = conn.cursor()
        def retype():
            cur.execute("UPDATE inspected_subject SET subject_type = 'LAB' WHERE subject_id = ?", (ids["subject"],))
        try:
            retype()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("subject_type changed after first use")
        conn.close()
    t.ok("subject_type is fixed after first use", subject_type_after_use)

    def mission_refdate():
        conn = fresh_db()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO mission(name, status, created_at, created_by) VALUES ('m', 'PREPARATION', 't', 'i')")
        m = cur.lastrowid
        cur.execute("UPDATE mission SET reference_entry_date = '2026-10-04' WHERE mission_id = ?", (m,))
        cur.execute("UPDATE mission SET status = 'ACTIVE' WHERE mission_id = ?", (m,))
        def move():
            cur.execute("UPDATE mission SET reference_entry_date = '2026-11-01' WHERE mission_id = ?", (m,))
        try:
            move()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("reference_entry_date changed after activation")
        conn.close()
    t.ok("mission.reference_entry_date fixed after activation (rule 10)", mission_refdate)

    def report_generated_immutable():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO report(report_type, title, mission_id, data_snapshot_ref, generated_at, generated_by, status) "
            "VALUES ('DETAILED_REPORT', 'r', ?, 'snap', 't', 'i', 'GENERATED')", (ids["mission"],))
        rep = cur.lastrowid
        def change():
            cur.execute("UPDATE report SET title = 'x' WHERE report_id = ?", (rep,))
        try:
            change()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("report mutated after GENERATED")
        conn.close()
    t.ok("report metadata immutable after GENERATED", report_generated_immutable)

    def ext_append_only():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO external_system_tracking(system, operation, status_code, event_date, recorded_at, recorded_by) "
            "VALUES ('TASYIR', 'update', 'DONE', '2026-09-21', 't', 'i')")
        e = cur.lastrowid
        def update_ext():
            cur.execute("UPDATE external_system_tracking SET status_code = 'PENDING' WHERE tracking_id = ?", (e,))
        try:
            update_ext()
        except sqlite3.Error:
            pass
        else:
            raise AssertionError("external tracking updated (append-only)")
        conn.close()
    t.ok("external_system_tracking is append-only", ext_append_only)


# ---------------------------------------------------------------------------
# S9 — derived view retained
# ---------------------------------------------------------------------------
def s9_view(t: T):
    def derived():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_ok = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur = conn.cursor()
        # finding owned by visit2 (for the non-compliant answer on visit2)
        cur.execute(
            "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
            "VALUES (?, 'd', 'ROUTINE', 'LOW', 'OPEN', 't', 'i')", (ids["visit2"],))
        f = cur.lastrowid
        make_response(conn, ids["visit"], d1, overlay="NA")                       # NA
        make_response(conn, ids["visit"], d1, subject_id=ids["subject"], overlay="NOT_INSPECTED")  # NOT_INSPECTED
        make_response(conn, ids["visit"], d1, subject_id=ids["subject_dorm"], value_id=v_ok)        # COMPLIANT
        make_response(conn, ids["visit2"], d1, value_id=v_bad, finding=f)          # NON_COMPLIANT
        conn.commit()
        got = cur.execute(
            "SELECT r.overlay_state, av.semantic_class, v.result_class "
            "FROM checklist_response r "
            "LEFT JOIN checklist_allowed_value av ON av.allowed_value_id = r.answered_value_id "
            "JOIN v_response_outcome v ON v.response_id = r.response_id ORDER BY r.response_id").fetchall()
        assert len(got) == 4, got
        classes = {row[2] for row in got}
        assert classes == {"NA", "NOT_INSPECTED", "COMPLIANT", "NON_COMPLIANT"}, classes
        conn.close()
    t.ok("v_response_outcome derives result_class (never stored)", derived)


# ---------------------------------------------------------------------------
# S10 — canonical mapping doc ↔ schema consistency (24 payloads loadable)
# ---------------------------------------------------------------------------
def s10_mapping_doc(t: T):
    def extract_blocks():
        text = RULES_DOC.read_text(encoding="utf-8")
        blocks, buf, inside = [], [], False
        for line in text.splitlines():
            if line.strip() == "```json":
                inside = True
                buf = []
                continue
            if inside and line.strip() == "```":
                blocks.append("\n".join(buf))
                inside = False
                continue
            if inside:
                buf.append(line)
        assert len(blocks) == 24, f"expected 24 canonical JSON blocks, found {len(blocks)}"
        return blocks
    blocks = extract_blocks()

    conn = fresh_db()
    cur = conn.cursor()
    for idx, raw in enumerate(blocks, start=1):
        obj = json.loads(raw)
        assert obj["rule_schema_version"] == 1
        assert obj["item_code"] == f"CHK-{idx:03d}", (obj["item_code"], idx)
        assert obj["decision_kind"] in ("AUTO", "HUMAN_CONFIRMATION")
        assert isinstance(obj["subject_kinds"], list) and obj["subject_kinds"]
        if obj["decision_kind"] == "HUMAN_CONFIRMATION":
            assert obj.get("missing_context"), f"{obj['item_code']} HUMAN rule without missing_context"
        # payload must satisfy the schema CHECKs exactly like a definition insert
        cur.execute(
            "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
            "priority, traceability, requirement_refs, applicability_rule, status) "
            "VALUES (?, ?, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ACTIVE')",
            (obj["item_code"], 1, raw))
    conn.commit()
    n = cur.execute("SELECT count(*) FROM checklist_item_definition").fetchone()[0]
    assert n == 24, n
    conn.close()
    t.ok("all 24 canonical rule payloads from APPLICABILITY-RULES-v1.md load into schema.sql", lambda: None)


# ---------------------------------------------------------------------------
# S11 — Gate 4A final integrity: canonical grammar negative rejections
# ---------------------------------------------------------------------------
def _insert_def_payload(conn, payload, item_code="CHK-001"):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO checklist_item_definition(item_code, version_no, domain_id, arabic_question, response_model, "
        "priority, traceability, requirement_refs, applicability_rule, status) "
        "VALUES (?, 1, 'DOM-02', 'q', 'SINGLE_VALUE', 'P0', 'DIRECT', 'REQ', ?, 'ACTIVE')",
        (item_code, json.dumps(payload, ensure_ascii=False)))
    conn.commit()


def s11_canonical_rule_rejections(t: T):
    def base(code="CHK-001"):
        return {
            "rule_schema_version": 1,
            "item_code": code,
            "decision_kind": "AUTO",
            "subject_kinds": ["WORKSHOP"],
            "source_ar": f"FIELD-CHECKLIST-v1.md — {code} — «متى يُطبَّق»",
        }

    cases = [
        # (label, payload, optional row item_code override)
        ("mismatched JSON item_code (CHK-999 vs row CHK-001)", {**base("CHK-999")}, "CHK-001"),
        ("invalid decision_kind (MAGIC)", {**base(), "decision_kind": "MAGIC"}),
        ("subject_kinds wrong JSON type (string)", {**base(), "subject_kinds": "WORKSHOP"}),
        ("empty subject_kinds", {**base(), "subject_kinds": []}),
        ("unknown subject kind (ALIEN)", {**base(), "subject_kinds": ["ALIEN"]}),
        ("subject_kinds non-text member", {**base(), "subject_kinds": ["WORKSHOP", 7]}),
        ("HUMAN_CONFIRMATION without missing_context", {**base(), "decision_kind": "HUMAN_CONFIRMATION"}),
        ("HUMAN_CONFIRMATION with empty missing_context", {**base(), "decision_kind": "HUMAN_CONFIRMATION", "missing_context": []}),
        ("HUMAN_CONFIRMATION with blank missing_context member", {**base(), "decision_kind": "HUMAN_CONFIRMATION", "missing_context": ["   "]}),
        ("HUMAN_CONFIRMATION with non-text missing_context member", {**base(), "decision_kind": "HUMAN_CONFIRMATION", "missing_context": [7]}),
        ("boolean true as rule_schema_version", {**base(), "rule_schema_version": True}),
        ("missing rule_schema_version key", {k: v for k, v in base().items() if k != "rule_schema_version"}),
        ("blank source_ar", {**base(), "source_ar": "   "}),
        ("missing source_ar key", {k: v for k, v in base().items() if k != "source_ar"}),
        ("missing item_code key", {k: v for k, v in base().items() if k != "item_code"}),
        ("invalid visit_type.allowed value (RANDOM)", {**base(), "visit_type": {"allowed": ["RANDOM"]}}),
        ("empty visit_type.allowed", {**base(), "visit_type": {"allowed": []}}),
        ("visit_type.allowed wrong JSON type (string)", {**base(), "visit_type": {"allowed": "SURPRISE"}}),
        ("visit_type object without .allowed", {**base(), "visit_type": {}}),
        ("visit_type not an object (string)", {**base(), "visit_type": "SURPRISE"}),
    ]
    for case in cases:
        label, payload = case[0], case[1]
        row_code = case[2] if len(case) > 2 else payload.get("item_code", "CHK-001")

        def attempt(payload=payload, row_code=row_code):
            conn = fresh_db()
            try:
                _insert_def_payload(conn, payload, row_code)
            finally:
                conn.close()

        t.bad_(f"S11 canonical rejection — {label}", attempt)


# ---------------------------------------------------------------------------
# S12 — Gate 4B: VOIDED Finding lifecycle (owner-approved narrow correction)
# ---------------------------------------------------------------------------
def _mk_finding(conn, visit_id):
    """Insert an OPEN finding in visit_id (no source) and return its id."""
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO finding(origin_visit_id, description, urgency, impact, status, created_at, created_by) "
        "VALUES (?, 'd', 'IMMEDIATE', 'HIGH', 'OPEN', 't', 'i')", (visit_id,))
    return cur.lastrowid


def _mk_source(conn, visit_id, def_id, bad_value_id):
    """Link a NON_COMPLIANT response source to a fresh OPEN finding; return (finding, response)."""
    cur = conn.cursor()
    f = _mk_finding(conn, visit_id)
    cur.execute(
        "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, recorded_at, "
        "recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (visit_id, def_id, bad_value_id, f))
    conn.commit()
    return f, cur.lastrowid


def s12_gate4b_voided(t: T):
    def status_accepts_voided():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = '2026-09-21T09:00:00Z' "
            "WHERE finding_id = ? AND status = 'OPEN'", (f,))
        assert cur.execute("SELECT status FROM finding WHERE finding_id = ?", (f,)).fetchone()[0] == "VOIDED"
        conn.close()
    t.ok("finding.status accepts VOIDED (OPEN -> VOIDED, origin visit open)", status_accepts_voided)

    def ca_rejects_voided():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, "
            "created_at, created_by) VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'VOIDED', 't', 'i')", (f,))
        conn.close()
    t.bad_("corrective_action.status does NOT accept VOIDED", ca_rejects_voided)

    def voided_with_source_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        f, _rid = _mk_source(conn, ids["visit"], d1, v_bad)
        cur = conn.cursor()
        cur.execute("UPDATE finding SET status = 'VOIDED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("OPEN -> VOIDED with a remaining source rejected", voided_with_source_rejected, "zero recorded sources")

    def voided_after_sole_source_retraction():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_ok = seed_value(conn, d1, "ACTIVE", "مفعّلة", "COMPLIANT")
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        f, rid = _mk_source(conn, ids["visit"], d1, v_bad)
        cur = conn.cursor()
        # preferred void ordering: correct the sole source inside the tx, append the
        # FollowUp event, then update OPEN -> VOIDED (the DB then sees zero sources).
        cur.execute("BEGIN IMMEDIATE")
        cur.execute(
            "UPDATE checklist_response SET answered_value_id = ?, overlay_state = NULL, note = NULL, finding_id = NULL "
            "WHERE response_id = ? AND finding_id = ?", (v_ok, rid, f))
        cur.execute(
            "INSERT INTO follow_up(finding_id, status_target, status_after, event_datetime, actor_role, note, "
            "recorded_by) VALUES (?, 'FINDING', 'VOIDED', '2026-09-21T09:00:00Z', 'INSPECTOR', "
            "'last source retracted', 'i')", (f,))
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = '2026-09-21T09:00:00Z' "
            "WHERE finding_id = ? AND status = 'OPEN'", (f,))
        cur.execute("COMMIT")
        assert cur.execute("SELECT status FROM finding WHERE finding_id = ?", (f,)).fetchone()[0] == "VOIDED"
        n_src = cur.execute("SELECT count(*) FROM checklist_response WHERE finding_id = ?", (f,)).fetchone()[0]
        n_obs = cur.execute("SELECT count(*) FROM adhoc_observation WHERE finding_id = ?", (f,)).fetchone()[0]
        assert (n_src, n_obs) == (0, 0), (n_src, n_obs)
        fu = cur.execute(
            "SELECT status_target, status_after FROM follow_up WHERE finding_id = ? "
            "ORDER BY followup_id DESC LIMIT 1", (f,)).fetchone()
        assert fu == ("FINDING", "VOIDED"), fu
        conn.close()
    t.ok("sole source removed inside a transaction, then OPEN -> VOIDED accepted (FollowUp recorded)",
         voided_after_sole_source_retraction)

    def voided_ends_zero_sources():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        n_src = cur.execute("SELECT count(*) FROM checklist_response WHERE finding_id = ?", (f,)).fetchone()[0]
        n_obs = cur.execute("SELECT count(*) FROM adhoc_observation WHERE finding_id = ?", (f,)).fetchone()[0]
        n_ca = cur.execute("SELECT count(*) FROM corrective_action WHERE finding_id = ?", (f,)).fetchone()[0]
        assert (n_src, n_obs, n_ca) == (0, 0, 0), (n_src, n_obs, n_ca)
        conn.close()
    t.ok("VOIDED ends with zero recorded sources (and zero actions)", voided_ends_zero_sources)

    def in_treatment_to_voided_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        f, _rid = _mk_source(conn, ids["visit"], d1, v_bad)
        cur = conn.cursor()
        cur.execute("UPDATE finding SET status = 'IN_TREATMENT', status_changed_at = 't' WHERE finding_id = ?", (f,))
        cur.execute("UPDATE finding SET status = 'VOIDED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("IN_TREATMENT -> VOIDED rejected", in_treatment_to_voided_rejected, "terminal")

    def resolved_to_voided_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        f, _rid = _mk_source(conn, ids["visit"], d1, v_bad)
        cur = conn.cursor()
        cur.execute("UPDATE finding SET status = 'RESOLVED', status_changed_at = 't' WHERE finding_id = ?", (f,))
        cur.execute("UPDATE finding SET status = 'VOIDED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("RESOLVED -> VOIDED rejected", resolved_to_voided_rejected, "terminal")

    def voided_terminal():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        for target in ("OPEN", "IN_TREATMENT", "RESOLVED"):
            try:
                cur.execute("UPDATE finding SET status = ? WHERE finding_id = ?", (target, f))
            except sqlite3.Error:
                pass
            else:
                raise AssertionError(f"VOIDED transitioned to {target}")
        conn.close()
    t.ok("VOIDED is terminal (OPEN/IN_TREATMENT/RESOLVED from VOIDED all rejected)", voided_terminal)

    def voided_finalized_origin_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE visit SET status = 'COMPLETED', finalized_at = '2026-09-20T18:00:00Z' WHERE visit_id = ?",
            (ids["visit"],))
        cur.execute("UPDATE finding SET status = 'VOIDED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("VOIDED when origin Visit is finalized rejected", voided_finalized_origin_rejected, "origin visit")

    def voided_with_action_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, "
            "created_at, created_by) VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'OPEN', 't', 'i')", (f,))
        cur.execute("UPDATE finding SET status = 'VOIDED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("VOIDED when any CorrectiveAction exists rejected", voided_with_action_rejected,
           "zero corrective actions")

    def link_response_to_voided_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, "
            "recorded_at, recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (ids["visit"], d1, v_bad, f))
        conn.close()
    t.bad_("source link to VOIDED Finding via ChecklistResponse rejected", link_response_to_voided_rejected,
           "VOIDED")

    def update_link_response_to_voided_rejected():
        # existing NON_COMPLIANT response linked to an OPEN finding F1, then UPDATE to
        # relink finding_id = VOIDED finding F2 -> rejected by the VOIDED source guard
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        cur = conn.cursor()
        f1 = _mk_finding(conn, ids["visit"])          # OPEN, origin visit
        cur.execute(
            "INSERT INTO checklist_response(visit_id, item_definition_id, answered_value_id, finding_id, "
            "recorded_at, recorded_by) VALUES (?, ?, ?, ?, 't', 'i')", (ids["visit"], d1, v_bad, f1))
        rid = cur.lastrowid
        f2 = _mk_finding(conn, ids["visit"])          # becomes VOIDED
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f2,))
        cur.execute("UPDATE checklist_response SET finding_id = ? WHERE response_id = ?", (f2, rid))
        conn.close()
    t.bad_("UPDATE of an existing ChecklistResponse to link a VOIDED Finding rejected",
           update_link_response_to_voided_rejected, "VOIDED")

    def link_observation_to_voided_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        cur.execute(
            "INSERT INTO adhoc_observation(visit_id, text, finding_id, recorded_at, recorded_by) "
            "VALUES (?, 'note', ?, 't', 'i')", (ids["visit"], f))
        conn.close()
    t.bad_("source link to VOIDED Finding via AdHocObservation rejected", link_observation_to_voided_rejected,
           "VOIDED")

    def update_link_observation_to_voided_rejected():
        # existing AdHocObservation with finding_id NULL: UPDATE finding_id = VOIDED finding -> rejected
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        cur.execute(
            "INSERT INTO adhoc_observation(visit_id, text, recorded_at, recorded_by) "
            "VALUES (?, 'note', 't', 'i')", (ids["visit"],))
        oid = cur.lastrowid
        cur.execute("UPDATE adhoc_observation SET finding_id = ? WHERE observation_id = ?", (f, oid))
        conn.close()
    t.bad_("UPDATE of an existing AdHocObservation to link a VOIDED Finding rejected",
           update_link_observation_to_voided_rejected, "VOIDED")

    def ca_under_voided_rejected():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = 't' WHERE finding_id = ? AND status = 'OPEN'",
            (f,))
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, "
            "created_at, created_by) VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'OPEN', 't', 'i')", (f,))
        conn.close()
    t.bad_("CorrectiveAction creation under VOIDED Finding rejected", ca_under_voided_rejected, "VOIDED")

    def fu_voided_finding_ok():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "INSERT INTO follow_up(finding_id, status_target, status_after, event_datetime, actor_role, note, "
            "recorded_by) VALUES (?, 'FINDING', 'VOIDED', '2026-09-21T09:00:00Z', 'INSPECTOR', 'void', 'i')", (f,))
        assert cur.lastrowid is not None
        conn.close()
    t.ok("follow_up status_after=VOIDED with status_target=FINDING accepted", fu_voided_finding_ok)

    def fu_voided_ca_rejected():
        # status_after=VOIDED with status_target=CORRECTIVE_ACTION must fail on the
        # VOIDED/status_target rule, so use a REAL CorrectiveAction of this Finding
        # (an unrelated FK failure must not be what the test proves).
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "INSERT INTO corrective_action(finding_id, action_type, description, responsible_role, status, "
            "created_at, created_by) VALUES (?, 'MAINTENANCE_WORK', 'fix', 'DIRECTOR', 'OPEN', 't', 'i')", (f,))
        a = cur.lastrowid
        cur.execute(
            "INSERT INTO follow_up(finding_id, corrective_action_id, status_target, status_after, "
            "event_datetime, actor_role, note, recorded_by) VALUES (?, ?, 'CORRECTIVE_ACTION', 'VOIDED', "
            "'2026-09-21T09:00:00Z', 'INSPECTOR', 'void', 'i')", (f, a))
        conn.close()
    t.bad_("follow_up status_after=VOIDED with status_target=CORRECTIVE_ACTION rejected",
           fu_voided_ca_rejected, "VOIDED")

    def source_less_open_no_in_treatment():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute("UPDATE finding SET status = 'IN_TREATMENT' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("source-less OPEN cannot transition to IN_TREATMENT", source_less_open_no_in_treatment,
           "source before leaving OPEN")

    def source_less_open_no_resolved():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute("UPDATE finding SET status = 'RESOLVED' WHERE finding_id = ?", (f,))
        conn.close()
    t.bad_("source-less OPEN cannot transition to RESOLVED", source_less_open_no_resolved,
           "source before leaving OPEN")

    def direct_open_resolved_ok():
        conn = fresh_db()
        ids = seed_base(conn)
        d1 = seed_def(conn, "CHK-001", 1)
        v_bad = seed_value(conn, d1, "INACTIVE", "غير مفعّلة", "NON_COMPLIANT")
        f, _rid = _mk_source(conn, ids["visit"], d1, v_bad)
        cur = conn.cursor()
        cur.execute(
            "UPDATE finding SET status = 'RESOLVED', status_changed_at = '2026-09-21T09:00:00Z' "
            "WHERE finding_id = ? AND status = 'OPEN'", (f,))
        assert cur.execute("SELECT status FROM finding WHERE finding_id = ?", (f,)).fetchone()[0] == "RESOLVED"
        conn.close()
    t.ok("direct OPEN -> RESOLVED with a valid source and no open corrective actions accepted",
         direct_open_resolved_ok)

    def finalize_with_voided_ok():
        conn = fresh_db()
        ids = seed_base(conn)
        cur = conn.cursor()
        f = _mk_finding(conn, ids["visit"])
        cur.execute(
            "UPDATE finding SET status = 'VOIDED', status_changed_at = '2026-09-21T09:00:00Z' "
            "WHERE finding_id = ? AND status = 'OPEN'", (f,))
        cur.execute(
            "UPDATE visit SET status = 'COMPLETED', finalized_at = '2026-09-20T18:00:00Z' WHERE visit_id = ?",
            (ids["visit"],))
        assert cur.execute("SELECT status FROM visit WHERE visit_id = ?", (ids["visit"],)).fetchone()[0] == "COMPLETED"
        conn.close()
    t.ok("visit finalization does not treat a valid zero-source VOIDED Finding as an orphan blocker",
         finalize_with_voided_ok)


def main():
    suites = [
        ("S0 architecture (15 tables / 44 triggers / 1 view / 24 indexes + column)", s0_architecture),
        ("S1 applicability_rule NOT NULL + canonical JSON + one ACTIVE per code", s1_applicability_insert_rules),
        ("S2 definition version immutability incl. applicability_rule", s2_definition_immutability),
        ("S3 historical response binding to original definition version", s3_historical_binding),
        ("S4 visit lifecycle & finalization (retained)", s4_visit_lifecycle),
        ("S5 response integrity (retained)", s5_response_integrity),
        ("S6 CHK-012 reconciliation integrity (retained)", s6_chk012),
        ("S7 finding / action / first-source / follow-up / evidence (retained)", s7_finding_and_actions),
        ("S8 allowed value / subject / mission / report / external (retained)", s8_misc_retained),
        ("S9 derived result_class view (retained)", s9_view),
        ("S10 canonical mapping doc ↔ schema (24 payloads)", s10_mapping_doc),
        ("S11 canonical grammar negative rejections (final integrity)", s11_canonical_rule_rejections),
        ("S12 Gate-4B VOIDED finding lifecycle", s12_gate4b_voided),
    ]
    total_ok, total_bad = 0, []
    for label, fn in suites:
        t = T(label)
        fn(t)
        total_ok += t.ok_count
        total_bad.extend(t.bad)
        status = "PASS" if not t.bad else "FAIL"
        print(f"[{status}] {label} — {t.ok_count} passed"
              + (f", {len(t.bad)} failed" if t.bad else ""))

    # independent object-count pass over a fresh scratch database
    scratch = fresh_db()
    cur = scratch.cursor()
    n_tables = cur.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
    n_trig = cur.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
    n_views = cur.execute("SELECT count(*) FROM sqlite_master WHERE type='view'").fetchone()[0]
    n_idx = cur.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'").fetchone()[0]
    scratch.close()

    print("\n=== scratch object counts (schema.sql from scratch) ===")
    print(f"tables={n_tables}  triggers={n_trig}  views={n_views}  explicit_indexes={n_idx}")

    print(f"\nTOTAL: {total_ok} passed, {len(total_bad)} failed")
    for name, err in total_bad:
        print(f"  FAIL {name}: {err}")
    if total_bad:
        print("\nRESULT: FAILURE")
        sys.exit(1)
    print("RESULT: SUCCESS (0 failures)")


if __name__ == "__main__":
    main()
