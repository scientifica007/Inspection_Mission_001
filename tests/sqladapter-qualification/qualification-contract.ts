// ============================================================================
// SqlAdapter Qualification Harness v1 — REUSABLE HOST-side qualification
// contract (Part A).
//
// Experiment: HNT-001 (SqlAdapter Qualification Harness v1). This is NOT Gate
// 6B. It turns the HOST-testable portion of DEVICE-ADAPTER-CONTRACT-v1 (§2 and
// the §3 matrix rows that can run on a dev/test host) into executable,
// repository-hosted qualification infrastructure. The existing NodeSqliteAdapter
// (dev/node-sqlite-adapter.ts) is the reference HOST candidate; a future
// Gate-6B Android/native candidate reuses this contract unchanged by supplying
// its own candidate-specific lifecycle factory (Part B).
//
// HOST vs DEVICE — IMPORTANT NON-CLAIMS.
// This qualification run proves NOTHING about:
//   * Android app-private storage;
//   * Capacitor / WebView lifecycle;
//   * physical Android process kill;
//   * device reboot;
//   * camera / filesystem behaviour;
//   * Android-plugin-specific transaction behaviour;
//   * physical-device currentVisitState restart reconstruction.
// Those remain Gate-6B / device-work items and are deliberately NOT covered
// here. Every case id carries the "HQ-" (Host Qualification) prefix and the
// report footer prints an explicit SCOPE: HOST note.
//
// REUSABILITY RULE (mandatory separation A vs B).
//   * Part A (this file) is runtime-neutral: it imports NO node:* API and no
//     dev/* adapter. It depends only on the existing runtime-neutral SqlAdapter
//     seam (src/bootstrap/adapter.ts) and the existing closed bootstrap modules
//     (loader / artifact / manifest).
//   * Part B (the candidate-specific runner) is the only place node:* may be
//     imported; it implements the HostQualificationSeam below over its own
//     driver and calls runHostQualification(...).
//   * No closed source/test/schema/bootstrap/document file is modified; the
//     qualification contract only ADDS executable coverage.
//
// Environment contract a candidate runner must honour:
//   * createFreshEnvironment() provisions the EXACT adopted schema
//     (docs/schema/schema.sql) into a brand-new durable database and returns an
//     environment whose openConnection() always targets that SAME durable
//     database (a real file for the reference host — never two unrelated
//     ":memory:" databases).
//   * every connection returned by openConnection() must run with SQLite
//     foreign-key enforcement ON (PRAGMA foreign_keys = ON). The contract
//     verifies this per connection and behaviourally (invalid-FK writes fail).
//   * dispose() releases every connection and removes any durable storage.
//
// Determinism: cases run sequentially, each on its OWN fresh environment, so no
// case can observe rows/state written by another case. No sleeps are used as
// correctness mechanisms; concurrency is proven by real SQLite lock semantics.
// ============================================================================

import type { SqlAdapter, SqlRow, SqlValue } from "../../src/bootstrap/adapter.ts";
import type { BootstrapArtifact } from "../../src/bootstrap/artifact.ts";
import { BootstrapLoader } from "../../src/bootstrap/loader.ts";
import type { LoadReport } from "../../src/bootstrap/loader.ts";
import { loadActiveP0Codes, verifyLoadedActiveP0 } from "../../src/bootstrap/manifest.ts";

export const QUALIFICATION_NAME = "SqlAdapter Qualification Harness";
export const QUALIFICATION_VERSION = "v1";
/** HOST qualification scope — never claims device qualification (see header). */
export const QUALIFICATION_SCOPE = "HOST" as const;

// ---------------------------------------------------------------------------
// Candidate seam (Part B implements this over a concrete driver)
// ---------------------------------------------------------------------------

export interface QualifiedConnection {
    readonly adapter: SqlAdapter;
    close(): Promise<void>;
}

export interface QualificationEnvironment {
    /** unique label used in failure messages */
    readonly label: string;
    /** Open a NEW connection to the SAME durable database with foreign_keys ON. */
    openConnection(): Promise<QualifiedConnection>;
    /** Close every still-open connection and remove durable storage. Idempotent. */
    dispose(): Promise<void>;
}

export interface HostQualificationSeam {
    /** human-readable candidate label, e.g. "node:sqlite NodeSqliteAdapter (reference HOST candidate)" */
    readonly candidateLabel: string;
    /** Create a fresh durable environment with the exact adopted schema provisioned. */
    createFreshEnvironment(): Promise<QualificationEnvironment>;
}

// ---------------------------------------------------------------------------
// Adopted-schema object inventory (schema.sql v1 authority)
// ---------------------------------------------------------------------------

export interface SchemaObjectInventory {
    tables: number;
    triggers: number;
    views: number;
    /** explicit indexes: sqlite_master type='index' excluding sqlite_autoindex_* */
    indexes: number;
}

/**
 * Object inventory of the exact adopted schema (docs/schema/schema.sql v1):
 * 15 tables / 44 triggers / 1 view / 24 explicit indexes (22 idx_* + 2 uq_*).
 * These are the same counts the closed Gate-4A schema regression asserts. Any
 * future owner-authorized schema revision must update this constant in the
 * same deliberate way the closed regression baselines are updated.
 */
export const ADOPTED_SCHEMA_V1_INVENTORY: SchemaObjectInventory = {
    tables: 15,
    triggers: 44,
    views: 1,
    indexes: 24,
};

export const ADOPTED_SCHEMA_V1_TABLES: readonly string[] = [
    "mission",
    "institution",
    "inspected_subject",
    "visit",
    "checklist_item_definition",
    "checklist_allowed_value",
    "checklist_response",
    "equipment_reconciliation_row",
    "adhoc_observation",
    "finding",
    "evidence",
    "corrective_action",
    "follow_up",
    "external_system_tracking",
    "report",
];

export const ADOPTED_SCHEMA_V1_RESULT_VIEW = "v_response_outcome";

// ---------------------------------------------------------------------------
// Deterministic fixtures (synthetic only — never real field data)
// ---------------------------------------------------------------------------

const TS = "2025-06-01T08:00:00.000Z";
const BY = "host-qual-harness";

/** Arabic + ASCII-single/double-quote sample used ONLY to prove byte-exact
 *  parameter round-tripping. No test asserts the prose itself. */
const AR_QUOTED = "قال المفتش: \"الورشة مغلقة\" ثم 'سأعود لاحقاً' — تحقق رقم ٥";

/** Large integer inside the SQLite int64 / JS safe-integer range. */
const BIG_INT = 1234567890123;

// ---------------------------------------------------------------------------
// Shared tally / async helpers
// ---------------------------------------------------------------------------

class Tally {
    private _passed = 0;
    private readonly _failed: string[] = [];

    get passed(): number {
        return this._passed;
    }

    get failed(): readonly string[] {
        return this._failed;
    }

    check(cond: boolean, message: string): void {
        if (cond) this._passed += 1;
        else this._failed.push(message);
    }
}

async function expectReject(tally: Tally, act: () => Promise<unknown>, message: string): Promise<void> {
    let threw = false;
    try {
        await act();
    } catch {
        threw = true;
    }
    tally.check(threw, message);
}

async function expectResolve(tally: Tally, act: () => Promise<unknown>, message: string): Promise<void> {
    let ok = true;
    try {
        await act();
    } catch {
        ok = false;
    }
    tally.check(ok, message);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every((x) => sb.has(x));
}

/** Open one authoritative connection and verify foreign keys are ON on it. */
async function openAuthoritative(ctx: CaseContext): Promise<QualifiedConnection> {
    const conn = await ctx.env.openConnection();
    try {
        const pragma = await conn.adapter.query("PRAGMA foreign_keys");
        ctx.tally.check(
            pragma.length === 1 && Number(pragma[0]?.foreign_keys) === 1,
            `${ctx.env.label}: every authoritative connection must run with PRAGMA foreign_keys = ON`,
        );
    } catch (e) {
        ctx.tally.check(false, `${ctx.env.label}: could not read PRAGMA foreign_keys (${describeError(e)})`);
    }
    return conn;
}

function describeError(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function firstValue(row: SqlRow, column: string, ctxLabel: string, what: string): SqlValue {
    if (!(column in row)) throw new Error(`${ctxLabel}: ${what} — column "${column}" missing from result row`);
    return row[column];
}

// ---------------------------------------------------------------------------
// Fixture writers (real adopted tables only; synthetic values)
// ---------------------------------------------------------------------------

async function insertInstitution(db: SqlAdapter, name: string, officialCode: string | null = null, address: string | null = null): Promise<number> {
    const res = await db.run(
        `INSERT INTO institution (name, official_code, address, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [name, officialCode, address, TS, BY],
    );
    if (res.lastInsertRowid === null) throw new Error("institution fixture insert returned no rowid");
    return Number(res.lastInsertRowid);
}

async function insertMission(db: SqlAdapter, name: string): Promise<number> {
    const res = await db.run(
        `INSERT INTO mission (name, status, created_at, created_by) VALUES (?, 'PREPARATION', ?, ?)`,
        [name, TS, BY],
    );
    if (res.lastInsertRowid === null) throw new Error("mission fixture insert returned no rowid");
    return Number(res.lastInsertRowid);
}

async function insertVisit(db: SqlAdapter, missionId: number, institutionId: number): Promise<number> {
    const res = await db.run(
        `INSERT INTO visit (mission_id, institution_id, visit_type, visit_date, inspector, created_at, created_by)
         VALUES (?, ?, 'PLANNED', '2025-06-02', 'inspector-hq', ?, ?)`,
        [missionId, institutionId, TS, BY],
    );
    if (res.lastInsertRowid === null) throw new Error("visit fixture insert returned no rowid");
    return Number(res.lastInsertRowid);
}

async function insertObservation(db: SqlAdapter, visitId: number, text: string): Promise<number> {
    const res = await db.run(
        `INSERT INTO adhoc_observation (visit_id, text, recorded_at, recorded_by) VALUES (?, ?, ?, ?)`,
        [visitId, text, TS, BY],
    );
    if (res.lastInsertRowid === null) throw new Error("observation fixture insert returned no rowid");
    return Number(res.lastInsertRowid);
}

async function insertEvidence(
    db: SqlAdapter,
    ownerKind: string,
    ownerRef: number,
    storageRef: string,
    fileSize: number | null,
): Promise<number> {
    const res = await db.run(
        `INSERT INTO evidence
           (owner_kind, owner_ref, storage_ref, file_name, mime_type, file_size,
            content_hash, captured_at, device_note, note, recorded_at, recorded_by)
         VALUES (?, ?, ?, 'evidence-fixture.bin', 'application/octet-stream', ?,
                 NULL, NULL, NULL, NULL, ?, ?)`,
        [ownerKind, ownerRef, storageRef, fileSize, TS, BY],
    );
    if (res.lastInsertRowid === null) throw new Error("evidence fixture insert returned no rowid");
    return Number(res.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Qualification cases
// ---------------------------------------------------------------------------

interface CaseContext {
    env: QualificationEnvironment;
    artifact: BootstrapArtifact;
    tally: Tally;
}

interface QualificationCase {
    readonly id: string;
    readonly title: string;
    run(ctx: CaseContext): Promise<void>;
}

/** HQ-01: the exact adopted schema is provisioned and present (HOST). */
async function case01SchemaProvisioned(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const inventory = ADOPTED_SCHEMA_V1_INVENTORY;
    const expectedTables = ADOPTED_SCHEMA_V1_TABLES;

    const objects = await c1.adapter.query(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
    const tables = objects.filter((o) => o.type === "table").map((o) => String(o.name));
    const triggers = objects.filter((o) => o.type === "trigger").map((o) => String(o.name));
    const views = objects.filter((o) => o.type === "view").map((o) => String(o.name));
    const indexes = objects
        .filter((o) => o.type === "index")
        .map((o) => String(o.name))
        .filter((n) => !n.startsWith("sqlite_autoindex_"));

    t.check(tables.length === inventory.tables, `provisioned table count must be ${inventory.tables} (got ${tables.length})`);
    t.check(sameSet(tables, expectedTables), `provisioned table set must be exactly the adopted 15 (got ${tables.sort().join(",")})`);
    t.check(triggers.length === inventory.triggers, `provisioned trigger count must be ${inventory.triggers} (got ${triggers.length})`);
    t.check(
        views.length === inventory.views && views[0] === ADOPTED_SCHEMA_V1_RESULT_VIEW,
        `provisioned view must be exactly ${ADOPTED_SCHEMA_V1_RESULT_VIEW} (got ${views.join(",")})`,
    );
    t.check(indexes.length === inventory.indexes, `explicit index count must be ${inventory.indexes} (got ${indexes.length})`);
    t.check(
        indexes.includes("uq_active_def_per_code") && indexes.includes("idx_mission_status"),
        "provisioned explicit indexes must include uq_active_def_per_code and idx_mission_status",
    );

    // A SECOND connection to the same durable DB must observe the same
    // provisioned schema (provisioning is durable, not connection-local).
    const c2 = await openAuthoritative(ctx);
    const objects2 = await c2.adapter.query(
        "SELECT type, name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    t.check(objects2.length === inventory.tables, "a reopened connection must still observe the exact provisioned schema");
    await c2.close();
    await c1.close();
}

/** HQ-02: parameterized SQL preserves text (incl. quotes + Arabic), integer, NULL (HOST). */
async function case02ParameterizedValues(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const db = c1.adapter;

    // --- TEXT (Arabic + single/double quotes) and NULL through institution ---
    const rInst = await db.run(
        `INSERT INTO institution (name, official_code, address, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [AR_QUOTED, null, null, TS, BY],
    );
    t.check(rInst.changes === 1, "institution parameterized INSERT must report changes == 1");
    t.check(rInst.lastInsertRowid !== null, "institution parameterized INSERT must return a rowid");
    const instId = Number(rInst.lastInsertRowid);

    const instRows = await db.query(
        "SELECT name, official_code, address FROM institution WHERE institution_id = ?",
        [instId],
    );
    t.check(instRows.length === 1, "parameterized read must return the inserted institution row");
    const nameBack = firstValue(instRows[0], "name", ctx.env.label, "institution.name");
    t.check(nameBack === AR_QUOTED, "Arabic/quote-containing text must round-trip byte-exact through parameters");
    t.check(instRows[0].official_code === null, "explicit NULL official_code must round-trip as NULL");
    t.check(instRows[0].address === null, "explicit NULL address must round-trip as NULL");

    // --- INTEGER and more NULL/TEXT through the real evidence table ----------
    // (evidence.file_size is an unconstrained nullable INTEGER in the adopted
    // schema; a valid ADHOC_OBSERVATION owner row is created first so the
    // closed trg_evidence_bi owner-existence audit is satisfied.)
    const inst2 = await insertInstitution(db, "host-qual-int-fixture");
    const missionId = await insertMission(db, "host-qual-mission-fixture");
    const visitId = await insertVisit(db, missionId, inst2);
    const obsId = await insertObservation(db, visitId, "host-qual observation fixture (synthetic)");

    const e1 = await db.run(
        `INSERT INTO evidence
           (owner_kind, owner_ref, storage_ref, content_hash, file_name, mime_type, file_size,
            captured_at, device_note, note, recorded_at, recorded_by)
         VALUES ('ADHOC_OBSERVATION', ?, 'host-qual://storage/e1', NULL, 'evidence-e1.bin',
                 'application/octet-stream', ?, NULL, ?, NULL, ?, ?)`,
        [obsId, BIG_INT, AR_QUOTED, TS, BY],
    );
    t.check(e1.changes === 1, "evidence parameterized INSERT must report changes == 1");
    t.check(e1.lastInsertRowid !== null, "evidence parameterized INSERT must return a rowid");

    const e1Rows = await db.query(
        `SELECT file_size, file_name, device_note, note, content_hash, captured_at
           FROM evidence WHERE evidence_id = ?`,
        [Number(e1.lastInsertRowid)],
    );
    t.check(e1Rows.length === 1, "parameterized read must return the inserted evidence row");
    const sizeBack = firstValue(e1Rows[0], "file_size", ctx.env.label, "evidence.file_size");
    t.check(sizeBack === BIG_INT && typeof sizeBack === "number", `integer ${BIG_INT} must round-trip as an exact number`);
    t.check(e1Rows[0].file_name === "evidence-e1.bin", "plain text column must round-trip byte-exact");
    t.check(e1Rows[0].device_note === AR_QUOTED, "Arabic/quote text in a second column must round-trip byte-exact");
    t.check(e1Rows[0].note === null, "explicit NULL note must round-trip as NULL");
    t.check(e1Rows[0].content_hash === null, "explicit NULL content_hash must round-trip as NULL");
    t.check(e1Rows[0].captured_at === null, "explicit NULL captured_at must round-trip as NULL");

    // NULL integer variant.
    const e2 = await insertEvidence(db, "ADHOC_OBSERVATION", obsId, "host-qual://storage/e2", null);
    const e2Rows = await db.query("SELECT file_size, file_name FROM evidence WHERE evidence_id = ?", [e2]);
    t.check(e2Rows.length === 1 && e2Rows[0].file_size === null, "NULL file_size must round-trip as NULL");

    // Parameterized filtering by the exact integer value and by NULL.
    const byInt = await db.query("SELECT file_name FROM evidence WHERE file_size = ?", [BIG_INT]);
    t.check(
        byInt.length === 1 && byInt[0].file_name === "evidence-e1.bin",
        "parameterized integer equality filter must select exactly the big-int row",
    );
    const byNull = await db.query("SELECT count(*) AS n FROM evidence WHERE file_size IS NULL");
    t.check(byNull.length === 1 && Number(byNull[0].n) === 1, "NULL predicate must select exactly the NULL-file_size row");

    await c1.close();
}

/** HQ-03: SqlResult affected-row normalization and insert row identity (HOST). */
async function case03AffectedRows(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const db = c1.adapter;

    const r1 = await db.run(
        `INSERT INTO institution (name, official_code, address, created_at, created_by)
         VALUES (?, NULL, NULL, ?, ?)`,
        ["hq-result-a", TS, BY],
    );
    t.check(r1.changes === 1 && typeof r1.changes === "number", "successful INSERT must report normalized numeric changes == 1");
    t.check(
        r1.lastInsertRowid !== null && typeof r1.lastInsertRowid === "number" && Number(r1.lastInsertRowid) > 0,
        "INSERT row identity must be normalized to a positive number",
    );
    const id1 = Number(r1.lastInsertRowid);

    const lastId = await db.query("SELECT last_insert_rowid() AS rid");
    t.check(
        lastId.length === 1 && Number(lastId[0].rid) === id1,
        "run() lastInsertRowid must equal the connection's last_insert_rowid()",
    );

    const r2 = await db.run("INSERT INTO institution (name, created_at, created_by) VALUES (?, ?, ?)", [
        "hq-result-b",
        TS,
        BY,
    ]);
    t.check(r2.changes === 1 && typeof r2.lastInsertRowid === "number", "second INSERT reports changes == 1 with numeric rowid");
    t.check(Number(r2.lastInsertRowid) > id1, "insert row identity must increase monotonically");

    // Guarded write that matches exactly one row → changes == 1.
    const upd = await db.run("UPDATE institution SET address = ? WHERE institution_id = ? AND name = ?", [
        "addr-updated",
        id1,
        "hq-result-a",
    ]);
    t.check(upd.changes === 1 && typeof upd.changes === "number", "matching guarded write must report normalized numeric changes == 1");
    const after = await db.query("SELECT address FROM institution WHERE institution_id = ?", [id1]);
    t.check(after.length === 1 && after[0].address === "addr-updated", "guarded write must actually update the row");

    // Guarded write that matches zero rows → changes == 0 (closed contracts
    // rely on this: a non-matching guard is not an error and changes nothing).
    const noMatch = await db.run("UPDATE institution SET address = ? WHERE institution_id = ? AND name = ?", [
        "must-not-land",
        id1,
        "hq-no-such-name",
    ]);
    t.check(noMatch.changes === 0 && typeof noMatch.changes === "number", "non-matching guarded write must report normalized numeric changes == 0");
    const unchanged = await db.query("SELECT address FROM institution WHERE institution_id = ?", [id1]);
    t.check(unchanged.length === 1 && unchanged[0].address === "addr-updated", "zero-change guarded write must leave durable state untouched");

    await c1.close();
}

/** HQ-04: explicit BEGIN IMMEDIATE … COMMIT; second connection isolation (HOST). */
async function case04ExplicitTransaction(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const c2 = await openAuthoritative(ctx);

    await c1.adapter.beginImmediate();
    await insertInstitution(c1.adapter, "HQ-ISO-ALPHA");
    await insertInstitution(c1.adapter, "HQ-ISO-BETA");

    const probeSql = "SELECT name FROM institution WHERE name IN ('HQ-ISO-ALPHA','HQ-ISO-BETA') ORDER BY name";
    const writerView = await c1.adapter.query(probeSql);
    t.check(writerView.length === 2, "the writing connection must see its own uncommitted writes");

    const readerView = await c2.adapter.query(probeSql);
    t.check(readerView.length === 0, "a second connection must NOT observe uncommitted rows");

    await c1.adapter.commit();
    const committedView = await c2.adapter.query(probeSql);
    t.check(
        committedView.length === 2 &&
            String(committedView[0].name) === "HQ-ISO-ALPHA" &&
            String(committedView[1].name) === "HQ-ISO-BETA",
        "a second connection MUST observe committed rows after COMMIT",
    );

    await c1.close();
    await c2.close();
}

/** HQ-05: ROLLBACK returns durable state to its pre-transaction condition (HOST). */
async function case05Rollback(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const db = c1.adapter;

    const baseId = await insertInstitution(db, "HQ-RB-BASE");
    const preTx = await db.query("SELECT address FROM institution WHERE institution_id = ?", [baseId]);
    t.check(preTx.length === 1 && preTx[0].address === null, "pre-transaction durable state: base row present with NULL address");

    await db.beginImmediate();
    await insertInstitution(db, "HQ-RB-TMP");
    await db.run("UPDATE institution SET address = ? WHERE institution_id = ?", ["changed-in-tx", baseId]);
    const inTx = await db.query(
        "SELECT count(*) AS n FROM institution WHERE name IN ('HQ-RB-BASE','HQ-RB-TMP')",
    );
    t.check(inTx.length === 1 && Number(inTx[0].n) === 2, "inside the transaction both writes must be visible to the writer");

    await db.rollback();
    const afterRb = await db.query(
        "SELECT count(*) AS n FROM institution WHERE name IN ('HQ-RB-BASE','HQ-RB-TMP')",
    );
    t.check(afterRb.length === 1 && Number(afterRb[0].n) === 1, "after ROLLBACK only the pre-transaction row must remain");
    const baseAfter = await db.query("SELECT address FROM institution WHERE institution_id = ?", [baseId]);
    t.check(baseAfter.length === 1 && baseAfter[0].address === null, "ROLLBACK must restore the row's pre-transaction value");
    await c1.close();

    // Durable check: reopen the same DB and confirm pre-transaction state.
    const c2 = await openAuthoritative(ctx);
    const reopened = await c2.adapter.query(
        "SELECT name, address FROM institution WHERE name IN ('HQ-RB-BASE','HQ-RB-TMP') ORDER BY name",
    );
    t.check(
        reopened.length === 1 && String(reopened[0].name) === "HQ-RB-BASE" && reopened[0].address === null,
        "durable state after close/reopen must equal the pre-transaction condition (injected write gone)",
    );
    await c2.close();
}

/** HQ-06: competing BEGIN IMMEDIATE on the SAME DB is serialized (HOST). */
async function case06CompetingBeginImmediate(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const c2 = await openAuthoritative(ctx);

    await c1.adapter.beginImmediate(); // authoritative writer owns BEGIN IMMEDIATE

    await expectReject(
        t,
        () => c2.adapter.beginImmediate(),
        "a second connection must NOT acquire a competing BEGIN IMMEDIATE while the first owns it",
    );

    const probe = await c2.adapter.query("SELECT 42 AS probe");
    t.check(probe.length === 1 && Number(probe[0].probe) === 42, "the second connection must remain readable while the lock is held");

    await insertInstitution(c1.adapter, "HQ-LOCK-HOLDER");
    await c1.adapter.commit(); // release

    await expectResolve(t, () => c2.adapter.beginImmediate(), "after release the second connection must acquire BEGIN IMMEDIATE again");
    await insertInstitution(c2.adapter, "HQ-LOCK-FOLLOWER");
    await c2.adapter.commit();

    const both = await c2.adapter.query(
        "SELECT name FROM institution WHERE name IN ('HQ-LOCK-HOLDER','HQ-LOCK-FOLLOWER') ORDER BY name",
    );
    t.check(
        both.length === 2 && String(both[0].name) === "HQ-LOCK-FOLLOWER" && String(both[1].name) === "HQ-LOCK-HOLDER",
        "the second connection must remain fully usable after the competing writer releases",
    );

    await c1.close();
    await c2.close();
}

/** HQ-07: foreign-key enforcement ON for every connection; invalid FK write fails (HOST). */
async function case07ForeignKeyEnforcement(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const c2 = await openAuthoritative(ctx);

    const badSubjectSql = `INSERT INTO inspected_subject
        (institution_id, subject_type, name, created_at, created_by)
        VALUES (?, 'WORKSHOP', 'hq-fk-invalid', ?, ?)`;

    await expectReject(
        t,
        () => c1.adapter.run(badSubjectSql, [999999999, TS, BY]),
        "a real invalid FK write (missing institution) must fail on connection 1",
    );
    let orphans = await c1.adapter.query("SELECT count(*) AS n FROM inspected_subject");
    t.check(orphans.length === 1 && Number(orphans[0].n) === 0, "the rejected FK write must leave no row behind");

    await expectReject(
        t,
        () => c2.adapter.run(badSubjectSql, [999999999, TS, BY]),
        "a real invalid FK write (missing institution) must fail on connection 2 as well",
    );

    // Valid FK writes must succeed afterwards on both connections (usable).
    const instId = await insertInstitution(c1.adapter, "hq-fk-valid-institution");
    const ok1 = await c1.adapter.run(
        `INSERT INTO inspected_subject (institution_id, subject_type, name, created_at, created_by)
         VALUES (?, 'WORKSHOP', 'hq-fk-valid-subject', ?, ?)`,
        [instId, TS, BY],
    );
    t.check(ok1.changes === 1, "a valid FK write must succeed on connection 1 after the rejected write");

    const ok2 = await c2.adapter.run(
        `INSERT INTO inspected_subject (institution_id, subject_type, name, created_at, created_by)
         VALUES (?, 'LAB', 'hq-fk-valid-subject-2', ?, ?)`,
        [instId, TS, BY],
    );
    t.check(ok2.changes === 1, "a valid FK write must succeed on connection 2 (FK enforcement must not block valid writes)");

    const subjects = await c1.adapter.query("SELECT count(*) AS n FROM inspected_subject");
    t.check(subjects.length === 1 && Number(subjects[0].n) === 2, "both valid FK writes must be durable and countable");

    await c1.close();
    await c2.close();
}

/** HQ-08: canonical bootstrap loads through BootstrapLoader + candidate adapter (HOST). */
async function case08CanonicalBootstrap(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const db = c1.adapter;
    const artifact = ctx.artifact;

    let report: LoadReport | null = null;
    try {
        report = await new BootstrapLoader(db, artifact).load();
        t.check(true, "canonical bootstrap/v1/checklist-v1.json must load through BootstrapLoader + the candidate adapter");
    } catch (e) {
        t.check(false, `canonical bootstrap load failed: ${describeError(e)}`);
        return;
    }

    t.check(report.loaded.length === artifact.definitions.length, "first load must insert every artifact definition");
    t.check(report.expectedItemCount === artifact.definitions.length, "LoadReport.expectedItemCount must equal the artifact definition count");
    t.check(
        report.p0ExpectedCount === artifact.manifest.expected_p0_item_codes.length,
        "LoadReport.p0ExpectedCount must equal the manifest P0 count",
    );
    const loadedSorted = [...report.loaded].sort();
    const defsSorted = artifact.definitions.map((d) => d.item_code).sort();
    t.check(JSON.stringify(loadedSorted) === JSON.stringify(defsSorted), "loaded item-code set must equal the artifact definition set");

    const activeCount = await db.query("SELECT count(*) AS n FROM checklist_item_definition WHERE status = 'ACTIVE'");
    t.check(activeCount.length === 1 && Number(activeCount[0].n) === artifact.definitions.length, "exactly one ACTIVE row per artifact definition");
    const distinctCodes = await db.query("SELECT count(DISTINCT item_code) AS n FROM checklist_item_definition");
    t.check(
        distinctCodes.length === 1 && Number(distinctCodes[0].n) === artifact.definitions.length,
        "ACTIVE definitions must be unambiguous per item_code",
    );
    const avTotal = artifact.definitions.reduce((sum, d) => sum + d.allowed_values.length, 0);
    const avCount = await db.query("SELECT count(*) AS n FROM checklist_allowed_value");
    t.check(avCount.length === 1 && Number(avCount[0].n) === avTotal, "allowed-value rows must equal the artifact allowed-value total");

    await expectResolve(
        t,
        () => verifyLoadedActiveP0(db, artifact.manifest.expected_p0_item_codes),
        "manifest ACTIVE+P0 verification must pass on the loaded candidate DB",
    );
    const loadedP0 = await loadActiveP0Codes(db);
    t.check(
        JSON.stringify(loadedP0) === JSON.stringify([...artifact.manifest.expected_p0_item_codes].sort()),
        "loaded ACTIVE+P0 code set must equal the manifest P0 authority",
    );

    // Idempotent reload through the SAME candidate adapter (loader convergence).
    let report2: LoadReport | null = null;
    try {
        report2 = await new BootstrapLoader(db, artifact).load();
        t.check(true, "identical second bootstrap load must converge (no-op) on the candidate adapter");
    } catch (e) {
        t.check(false, `idempotent second bootstrap load failed: ${describeError(e)}`);
    }
    if (report2 !== null) {
        t.check(report2.loaded.length === 0 && report2.alreadyPresent.length === artifact.definitions.length, "second load must be a full no-op");
        const activeAfter = await db.query("SELECT count(*) AS n FROM checklist_item_definition WHERE status = 'ACTIVE'");
        t.check(activeAfter.length === 1 && Number(activeAfter[0].n) === artifact.definitions.length, "idempotent reload must not duplicate ACTIVE definitions");
    }

    await c1.close();
}

/** HQ-09: committed data survives closing the connection and reopening the SAME durable DB (HOST). */
async function case09DurableCloseReopen(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const w1 = await c1.adapter.run(
        `INSERT INTO institution (name, official_code, address, created_at, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        ["HQ-DUR-ONE", "DUR-ONE-CODE", "addr-1", TS, BY],
    );
    t.check(w1.changes === 1, "durable write through the adapter must succeed");
    const id1 = Number(w1.lastInsertRowid);
    await c1.close();

    const c2 = await openAuthoritative(ctx);
    const after1 = await c2.adapter.query(
        "SELECT institution_id, name, official_code, address FROM institution WHERE name = 'HQ-DUR-ONE'",
    );
    t.check(after1.length === 1, "reopened connection must still see the committed row");
    t.check(
        Number(after1[0].institution_id) === id1 &&
            after1[0].name === "HQ-DUR-ONE" &&
            after1[0].official_code === "DUR-ONE-CODE" &&
            after1[0].address === "addr-1",
        "committed values must survive close/reopen byte-exact",
    );
    const w2 = await c2.adapter.run(
        "INSERT INTO institution (name, created_at, created_by) VALUES (?, ?, ?)",
        ["HQ-DUR-TWO", TS, BY],
    );
    t.check(w2.changes === 1, "a second durable write on the reopened connection must succeed");
    await c2.close();

    const c3 = await openAuthoritative(ctx);
    const both = await c3.adapter.query("SELECT name FROM institution WHERE name IN ('HQ-DUR-ONE','HQ-DUR-TWO') ORDER BY name");
    t.check(
        both.length === 2 && String(both[0].name) === "HQ-DUR-ONE" && String(both[1].name) === "HQ-DUR-TWO",
        "both commits must survive a second close/reopen cycle",
    );
    await c3.close();
}

/** HQ-10: canonical bootstrap state still exists after close/reopen (HOST). */
async function case10BootstrapPersistence(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const artifact = ctx.artifact;
    const avTotal = artifact.definitions.reduce((sum, d) => sum + d.allowed_values.length, 0);

    let report: LoadReport | null = null;
    try {
        report = await new BootstrapLoader(c1.adapter, artifact).load();
        t.check(true, "canonical bootstrap must load before the close/reopen");
    } catch (e) {
        t.check(false, `bootstrap load before close/reopen failed: ${describeError(e)}`);
        return;
    }
    t.check(report.loaded.length === artifact.definitions.length, "bootstrap load must insert every definition before close");
    await c1.close();

    const c2 = await openAuthoritative(ctx);
    const active = await c2.adapter.query("SELECT count(*) AS n FROM checklist_item_definition WHERE status = 'ACTIVE'");
    t.check(
        active.length === 1 && Number(active[0].n) === artifact.definitions.length,
        "ACTIVE bootstrap definitions must still exist after close/reopen",
    );
    const codes = await c2.adapter.query("SELECT count(DISTINCT item_code) AS n FROM checklist_item_definition");
    t.check(
        codes.length === 1 && Number(codes[0].n) === artifact.definitions.length,
        "ACTIVE bootstrap definitions must be unambiguous per item_code after close/reopen",
    );
    const av = await c2.adapter.query("SELECT count(*) AS n FROM checklist_allowed_value");
    t.check(av.length === 1 && Number(av[0].n) === avTotal, "bootstrap allowed values must still exist after close/reopen");

    await expectResolve(
        t,
        () => verifyLoadedActiveP0(c2.adapter, artifact.manifest.expected_p0_item_codes),
        "manifest ACTIVE+P0 verification must pass on the reopened connection",
    );
    const loadedP0 = await loadActiveP0Codes(c2.adapter);
    t.check(
        JSON.stringify(loadedP0) === JSON.stringify([...artifact.manifest.expected_p0_item_codes].sort()),
        "loaded ACTIVE+P0 set on the reopened connection must equal the manifest P0 authority",
    );

    let report2: LoadReport | null = null;
    try {
        report2 = await new BootstrapLoader(c2.adapter, artifact).load();
        t.check(true, "identical reload after reopen must converge (no-op)");
    } catch (e) {
        t.check(false, `reload after reopen failed: ${describeError(e)}`);
    }
    if (report2 !== null) {
        t.check(
            report2.loaded.length === 0 && report2.alreadyPresent.length === artifact.definitions.length,
            "reload after reopen must be a full no-op (bootstrap state persisted byte-identically)",
        );
    }
    await c2.close();
}

/** HQ-11 (edge): a rejected statement leaves the connection usable with no partial row (HOST). */
async function case11ConstraintFailureLeavesConnectionUsable(ctx: CaseContext): Promise<void> {
    const t = ctx.tally;
    const c1 = await openAuthoritative(ctx);
    const db = c1.adapter;

    const w1 = await db.run(
        `INSERT INTO institution (name, official_code, created_at, created_by) VALUES (?, ?, ?, ?)`,
        ["HQ-UNIQ-A", "UNIQ-CODE", TS, BY],
    );
    t.check(w1.changes === 1, "first insert with a unique official_code must succeed");

    await expectReject(
        t,
        () => db.run(`INSERT INTO institution (name, official_code, created_at, created_by) VALUES (?, ?, ?, ?)`, [
            "HQ-UNIQ-DUP",
            "UNIQ-CODE",
            TS,
            BY,
        ]),
        "a duplicate official_code write must be rejected (UNIQUE constraint)",
    );
    const afterDup = await db.query("SELECT count(*) AS n FROM institution WHERE official_code = 'UNIQ-CODE'");
    t.check(afterDup.length === 1 && Number(afterDup[0].n) === 1, "the rejected write must leave no partial/duplicate row");

    const w2 = await db.run(
        `INSERT INTO institution (name, official_code, created_at, created_by) VALUES (?, ?, ?, ?)`,
        ["HQ-UNIQ-B", "UNIQ-CODE-2", TS, BY],
    );
    t.check(w2.changes === 1, "the same connection must remain fully usable after a rejected statement");
    const all = await db.query("SELECT count(*) AS n FROM institution");
    t.check(all.length === 1 && Number(all[0].n) === 2, "connection must keep working and durable state must be consistent");

    await c1.close();
}

const QUALIFICATION_CASES: readonly QualificationCase[] = [
    { id: "HQ-01", title: "HOST exact adopted schema is provisioned and present", run: case01SchemaProvisioned },
    { id: "HQ-02", title: "HOST parameterized SQL preserves text (quotes + Arabic), integer, NULL", run: case02ParameterizedValues },
    { id: "HQ-03", title: "HOST SqlResult affected-row normalization + insert row identity", run: case03AffectedRows },
    { id: "HQ-04", title: "HOST explicit BEGIN IMMEDIATE … COMMIT isolation across connections", run: case04ExplicitTransaction },
    { id: "HQ-05", title: "HOST ROLLBACK restores durable pre-transaction state", run: case05Rollback },
    { id: "HQ-06", title: "HOST competing BEGIN IMMEDIATE is serialized; loser stays usable", run: case06CompetingBeginImmediate },
    { id: "HQ-07", title: "HOST foreign-key enforcement ON per connection; invalid FK write fails", run: case07ForeignKeyEnforcement },
    { id: "HQ-08", title: "HOST canonical bootstrap loads through BootstrapLoader + candidate adapter", run: case08CanonicalBootstrap },
    { id: "HQ-09", title: "HOST committed data survives durable close/reopen", run: case09DurableCloseReopen },
    { id: "HQ-10", title: "HOST bootstrap state persists across close/reopen", run: case10BootstrapPersistence },
    { id: "HQ-11", title: "HOST rejected statement leaves connection usable with no partial row", run: case11ConstraintFailureLeavesConnectionUsable },
];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface QualificationCaseOutcome {
    readonly id: string;
    readonly title: string;
    readonly passed: number;
    readonly failed: readonly string[];
}

export interface QualificationSummary {
    readonly qualificationName: string;
    readonly qualificationVersion: string;
    readonly qualificationScope: typeof QUALIFICATION_SCOPE;
    readonly candidateLabel: string;
    readonly outcomes: readonly QualificationCaseOutcome[];
    readonly totalPassed: number;
    readonly totalFailed: number;
}

/**
 * Run every qualification case against the supplied candidate seam. Each case
 * gets its own fresh environment (created by the seam) and is disposed in a
 * finally block, so a crash in one case can never leak into the next. The
 * contract itself performs no I/O beyond the SqlAdapter seam and never imports
 * node:* APIs, so a future device candidate can run the identical suite by
 * supplying its own HostQualificationSeam implementation.
 */
export async function runHostQualification(
    seam: HostQualificationSeam,
    artifact: BootstrapArtifact,
): Promise<QualificationSummary> {
    const outcomes: QualificationCaseOutcome[] = [];
    for (const qualificationCase of QUALIFICATION_CASES) {
        const tally = new Tally();
        let env: QualificationEnvironment | null = null;
        try {
            env = await seam.createFreshEnvironment();
            await qualificationCase.run({ env, artifact, tally });
        } catch (e) {
            tally.check(false, `${qualificationCase.id} crashed: ${describeError(e)}`);
        } finally {
            if (env !== null) {
                try {
                    await env.dispose();
                } catch {
                    // dispose is best-effort cleanup; it must not mask case results
                }
            }
        }
        outcomes.push({ id: qualificationCase.id, title: qualificationCase.title, passed: tally.passed, failed: tally.failed });
    }
    return {
        qualificationName: QUALIFICATION_NAME,
        qualificationVersion: QUALIFICATION_VERSION,
        qualificationScope: QUALIFICATION_SCOPE,
        candidateLabel: seam.candidateLabel,
        outcomes,
        totalPassed: outcomes.reduce((s, o) => s + o.passed, 0),
        totalFailed: outcomes.reduce((s, o) => s + o.failed.length, 0),
    };
}
