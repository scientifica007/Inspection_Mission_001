import type { SqlAdapter } from "../bootstrap/adapter.ts";
import { BootstrapLoader } from "../bootstrap/loader.ts";
import { VisitScopeService } from "../application/visit-scope.ts";
import { InitialDispositionService, type ResponseCellRef } from "../application/initial-disposition.ts";
import { ObservationCreateService } from "../application/observation-create.ts";
import { ObservationFindingService } from "../application/observation-finding.ts";
import { CorrectiveActionCreateService } from "../application/corrective-action-create.ts";
import { VisitFinalizationService } from "../application/visit-finalization.ts";
import { CurrentVisitStateService, type CurrentVisitState } from "../application/current-visit-state.ts";
import { APP_ERR } from "../application/errors.ts";
import {
  closeGate6BDatabase,
  deleteGate6BDatabase,
  GATE6B_PROBE_DB_NAME,
  GATE6B_PROOF_DB_NAME,
  openGate6BDatabase,
  type OpenGate6BDatabase,
} from "../device/gate6b-database.ts";
import { CANONICAL_BOOTSTRAP, CANONICAL_BOOTSTRAP_TEXT, CANONICAL_SCHEMA_SQL, GATE6B_PACKAGE_VERSIONS } from "./assets.ts";
import { canonicalProofJson, sha256Hex } from "./hash.ts";
import {
  actualInventory,
  canonicalInventoryCountIsAdopted,
  expectedInventoryFromCanonicalSchema,
  inventoryDiff,
} from "./schema-inventory.ts";
import { overallOf, type Gate6BProofOutput, type QualificationCase } from "./proof-types.ts";

const APP_ID = "com.scientifica.inspection.gate6bproof";
const SQLITE_PLUGIN = "@capacitor-community/sqlite" as const;
const SYNTHETIC_MISSION = "G6B-PROOF-MISSION::v1";
const SYNTHETIC_INSTITUTION_CODE = "G6B-PROOF-INST-V1";
const SYNTHETIC_INSTITUTION = "Synthetic Gate 6B Institution";
const SYNTHETIC_WORKSHOP = "Synthetic Gate 6B Workshop";
const SYNTHETIC_OBSERVATION = "Synthetic Gate 6B observation — no operational data";
const FIXED_NOW = "2026-09-09T08:00:00.000Z";
const FIXED_NOW_2 = "2026-09-09T08:05:00.000Z";
const FIXED_VISIT_DATE = "2026-09-09";
const FIXED_FINAL = "2026-09-09T09:00:00.000Z";

function testedSha(): string {
  return String(import.meta.env.VITE_GIT_COMMIT ?? "UNAVAILABLE");
}

function pass(id: string, evidence: string): QualificationCase {
  return { id, status: "PASS", evidence };
}
function fail(id: string, evidence: string): QualificationCase {
  return { id, status: "FAIL", evidence };
}
function blocked(id: string, evidence: string): QualificationCase {
  return { id, status: "BLOCKED", evidence };
}

async function baseOutput(opened: OpenGate6BDatabase, phase: string): Promise<Omit<Gate6BProofOutput, "qualification" | "visitIdentifierRecoveredFromSqlite" | "currentVisitStateZeroWrite" | "overallResult">> {
  return {
    gate: "6B",
    proofFormatVersion: 1,
    testedGitCommitSha: testedSha(),
    androidAppPackageId: APP_ID,
    capacitorVersion: GATE6B_PACKAGE_VERSIONS.capacitorCore,
    sqlitePlugin: {
      package: SQLITE_PLUGIN,
      version: GATE6B_PACKAGE_VERSIONS.sqlitePlugin,
      status: "PROVISIONAL_CANDIDATE_PENDING_DEVICE_PROOF",
    },
    sqliteEngineVersion: opened.sqliteVersion,
    schemaAssetSha256: await sha256Hex(CANONICAL_SCHEMA_SQL),
    bootstrapAssetSha256: await sha256Hex(CANONICAL_BOOTSTRAP_TEXT),
    phase,
    timestamp: new Date().toISOString(),
  };
}

async function executeCanonicalSchema(opened: OpenGate6BDatabase): Promise<QualificationCase> {
  try {
    await opened.connection.execute(CANONICAL_SCHEMA_SQL, false);
    const expected = expectedInventoryFromCanonicalSchema(CANONICAL_SCHEMA_SQL);
    const actual = await actualInventory(opened.adapter);
    const diff = inventoryDiff(expected, actual);
    const integrity = await opened.adapter.query("PRAGMA integrity_check;");
    const ok = String(integrity[0]?.integrity_check ?? "") === "ok";
    if (!canonicalInventoryCountIsAdopted(expected)) {
      return fail("Q8_SCHEMA", `canonical asset parser did not yield adopted counts: ${JSON.stringify({ tables: expected.table.length, triggers: expected.trigger.length, views: expected.view.length, indexes: expected.index.length })}`);
    }
    if (!diff.equal || !ok) {
      return fail("Q8_SCHEMA", `canonical asset executed but inventory/integrity mismatch: ${JSON.stringify({ diff, integrity })}`);
    }
    return pass("Q8_SCHEMA", `exact canonical docs/schema/schema.sql executed with transaction=false; exact object-name sets match (${actual.table.length} tables/${actual.trigger.length} triggers/${actual.view.length} view/${actual.index.length} indexes); integrity_check=ok`);
  } catch (error) {
    return fail("Q8_SCHEMA", error instanceof Error ? error.message : String(error));
  }
}

async function bootstrapCanonical(db: SqlAdapter): Promise<QualificationCase> {
  try {
    const first = await new BootstrapLoader(db, CANONICAL_BOOTSTRAP).load();
    const second = await new BootstrapLoader(db, CANONICAL_BOOTSTRAP).load();
    const counts = await db.query(
      `SELECT
         (SELECT count(*) FROM checklist_item_definition) AS definitions,
         (SELECT count(*) FROM checklist_allowed_value) AS allowed_values,
         (SELECT count(*) FROM checklist_item_definition WHERE priority='P0') AS p0,
         (SELECT count(*) FROM checklist_item_definition WHERE priority='P1') AS p1`,
    );
    const expectedAllowed = CANONICAL_BOOTSTRAP.definitions.reduce((n, d) => n + d.allowed_values.length, 0);
    const row = counts[0];
    const good = first.loaded.length === 24 && second.loaded.length === 0 && second.alreadyPresent.length === 24
      && Number(row.definitions) === 24 && Number(row.allowed_values) === expectedAllowed
      && Number(row.p0) === CANONICAL_BOOTSTRAP.manifest.expected_p0_item_codes.length
      && Number(row.p1) === CANONICAL_BOOTSTRAP.manifest.expected_p1_item_codes.length;
    if (!good) return fail("Q9_BOOTSTRAP", `canonical loader state mismatch: ${JSON.stringify({ first, second, counts: row, expectedAllowed })}`);
    return pass("Q9_BOOTSTRAP", `canonical BootstrapLoader: first load 24 definitions; second load 24 no-ops; P0=${row.p0}, P1=${row.p1}, allowed_values=${row.allowed_values}`);
  } catch (error) {
    return fail("Q9_BOOTSTRAP", error instanceof Error ? error.message : String(error));
  }
}

async function totalChanges(db: SqlAdapter): Promise<number> {
  const rows = await db.query("SELECT total_changes() AS n;");
  return Number(rows[0]?.n ?? 0);
}

async function createSyntheticRoots(db: SqlAdapter, suffix = ""): Promise<{ missionId: number; institutionId: number }> {
  const mission = await db.run(
    `INSERT INTO mission(name, description, status, created_at, created_by)
     VALUES (?, 'synthetic Gate 6B proof only', 'PREPARATION', ?, 'gate6b-proof')`,
    [`${SYNTHETIC_MISSION}${suffix}`, FIXED_NOW],
  );
  const institution = await db.run(
    `INSERT INTO institution(name, official_code, kind_code, active, created_at, created_by)
     VALUES (?, ?, 'CFPA', 1, ?, 'gate6b-proof')`,
    [`${SYNTHETIC_INSTITUTION}${suffix}`, `${SYNTHETIC_INSTITUTION_CODE}${suffix}`, FIXED_NOW],
  );
  if (mission.lastInsertRowid === null || institution.lastInsertRowid === null) throw new Error("synthetic root insert returned no rowid");
  return { missionId: mission.lastInsertRowid, institutionId: institution.lastInsertRowid };
}

async function cellOf(db: SqlAdapter, visitId: number, subjectId: number | null, itemCode: string): Promise<ResponseCellRef> {
  const rows = await db.query(
    `SELECT cr.item_definition_id
       FROM checklist_response cr
       JOIN checklist_item_definition d ON d.item_definition_id=cr.item_definition_id
      WHERE cr.visit_id=? AND d.item_code=? ${subjectId === null ? "AND cr.subject_id IS NULL" : "AND cr.subject_id=?"}`,
    subjectId === null ? [visitId, itemCode] : [visitId, itemCode, subjectId],
  );
  if (rows.length !== 1) throw new Error(`expected one ${itemCode} cell, got ${rows.length}`);
  return { visitId, itemDefinitionId: Number(rows[0].item_definition_id), subjectId };
}

async function valueId(db: SqlAdapter, definitionId: number, code: string): Promise<number> {
  const rows = await db.query(
    "SELECT allowed_value_id FROM checklist_allowed_value WHERE item_definition_id=? AND value_code=?",
    [definitionId, code],
  );
  if (rows.length !== 1) throw new Error(`expected one allowed value ${definitionId}/${code}`);
  return Number(rows[0].allowed_value_id);
}

async function zeroWriteState(db: SqlAdapter, visitId: number): Promise<{ state: CurrentVisitState; before: number; after: number; delta: number }> {
  const before = await totalChanges(db);
  const state = await new CurrentVisitStateService(db).currentVisitState(visitId);
  const after = await totalChanges(db);
  return { state, before, after, delta: after - before };
}

async function representativeCoreFlow(opened: OpenGate6BDatabase): Promise<{ visitId: number; state: CurrentVisitState; zero: { before: number; after: number; delta: number }; cases: QualificationCase[] }> {
  const db = opened.adapter;
  const roots = await createSyntheticRoots(db);
  const scope = new VisitScopeService(db);
  const visit = await scope.createVisit({
    missionId: roots.missionId,
    institutionId: roots.institutionId,
    visitType: "PLANNED",
    visitDate: FIXED_VISIT_DATE,
    inspector: "gate6b-proof",
    expectedP0ItemCodes: CANONICAL_BOOTSTRAP.manifest.expected_p0_item_codes,
    actor: "gate6b-proof",
    now: FIXED_NOW,
  });
  const workshop = await scope.addSubjectToScope({
    kind: "new",
    visitId: visit.visitId,
    subject: { subjectType: "WORKSHOP", name: SYNTHETIC_WORKSHOP },
    actor: "gate6b-proof",
    now: FIXED_NOW,
  });
  const chk1 = await cellOf(db, visit.visitId, workshop.subjectId, "CHK-001");
  await new InitialDispositionService(db).answerSingle({
    cell: chk1,
    allowedValueId: await valueId(db, chk1.itemDefinitionId, "ACTIVE"),
  });
  const obs = await new ObservationCreateService(db).createAdHocObservation({
    visitId: visit.visitId,
    subjectId: workshop.subjectId,
    text: SYNTHETIC_OBSERVATION,
    recordedAt: FIXED_NOW_2,
    recordedBy: "gate6b-proof",
  });
  const finding = await new ObservationFindingService(db).createFindingWithObservationSource({
    observationId: obs.observationId,
    finding: {
      description: "Synthetic proof finding",
      defectType: "EQUIPMENT_FAULT",
      location: "synthetic workshop",
      urgency: "ROUTINE",
      impact: "LOW",
    },
    actor: "gate6b-proof",
    now: FIXED_NOW_2,
  });
  await new CorrectiveActionCreateService(db).createCorrectiveAction({
    findingId: finding.findingId,
    actionType: "ADMIN_ORGANIZATIONAL",
    description: "Synthetic proof corrective action",
    responsibleRole: "INSPECTOR",
    responsibleName: "synthetic",
    dueDate: null,
    createdAt: FIXED_NOW_2,
    createdBy: "gate6b-proof",
  });
  const zero = await zeroWriteState(db, visit.visitId);
  const cases = [
    pass("CORE_FLOW", `existing services used: BootstrapLoader/T0/T1/T2/OBS-1/T7/T9/currentVisitState; visit=${visit.visitId}`),
    zero.delta === 0
      ? pass("Q_CURRENT_VISIT_ZERO_WRITE", `total_changes before=${zero.before}, after=${zero.after}, delta=0`)
      : fail("Q_CURRENT_VISIT_ZERO_WRITE", `total_changes delta=${zero.delta}`),
  ];
  return { visitId: visit.visitId, state: zero.state, zero: { before: zero.before, after: zero.after, delta: zero.delta }, cases };
}

async function runFinalizationScenario(opened: OpenGate6BDatabase): Promise<QualificationCase> {
  const db = opened.adapter;
  try {
    const roots = await createSyntheticRoots(db, "::T11");
    const scope = new VisitScopeService(db);
    const visit = await scope.createVisit({
      missionId: roots.missionId,
      institutionId: roots.institutionId,
      visitType: "PLANNED",
      visitDate: FIXED_VISIT_DATE,
      inspector: "gate6b-proof",
      expectedP0ItemCodes: CANONICAL_BOOTSTRAP.manifest.expected_p0_item_codes,
      actor: "gate6b-proof",
      now: FIXED_NOW,
    });
    const disp = new InitialDispositionService(db);
    const state = await new CurrentVisitStateService(db).currentVisitState(visit.visitId);
    for (const cell of state.cells) {
      if (cell.classification === "PENDING") {
        await disp.markNotInspected({
          cell: { visitId: visit.visitId, itemDefinitionId: cell.itemDefinitionId, subjectId: cell.subjectId },
          reason: "Synthetic Gate 6B finalization proof: deliberately not inspected",
        });
      } else if (cell.classification === "UNRESOLVED_HUMAN") {
        await disp.markNotInspected({
          cell: { visitId: visit.visitId, itemDefinitionId: cell.itemDefinitionId, subjectId: cell.subjectId },
          reason: "Synthetic Gate 6B finalization proof: human-applicable but deliberately not inspected",
          humanDecision: "APPLICABLE",
        });
      }
    }
    const result = await new VisitFinalizationService(db).finalizeVisit({ visitId: visit.visitId, finalizedAt: FIXED_FINAL });
    if (result.status !== "COMPLETED_WITH_UNINSPECTED" || result.finalizedAt !== FIXED_FINAL) {
      return fail("T11_FINALIZATION", `unexpected final state ${JSON.stringify(result)}`);
    }
    let rejected = false;
    try {
      await new ObservationCreateService(db).createAdHocObservation({
        visitId: visit.visitId,
        text: "forbidden post-finalization mutation",
        recordedAt: "2026-09-09T09:01:00.000Z",
        recordedBy: "gate6b-proof",
      });
    } catch (error) {
      rejected = error instanceof Error && (error as Error & { code?: string }).code === APP_ERR.VISIT_NOT_PREPARATION;
    }
    if (!rejected) return fail("T11_FINALIZATION", "post-finalization OBS-1 mutation was not rejected with E_VISIT_NOT_PREPARATION");
    return pass("T11_FINALIZATION", `Gate-5K finalizeVisit succeeded as ${result.status} at ${result.finalizedAt}; post-finalization field-truth creation rejected by existing Gate-5G service`);
  } catch (error) {
    return fail("T11_FINALIZATION", error instanceof Error ? error.message : String(error));
  }
}

async function adapterQualificationCases(): Promise<{ opened: OpenGate6BDatabase; cases: QualificationCase[] }> {
  await deleteGate6BDatabase(GATE6B_PROBE_DB_NAME);
  let opened = await openGate6BDatabase(GATE6B_PROBE_DB_NAME);
  const db = opened.adapter;
  const cases: QualificationCase[] = [];
  await opened.connection.execute(
    `CREATE TABLE __g6b_parent(id INTEGER PRIMARY KEY);
     CREATE TABLE __g6b_probe(id INTEGER PRIMARY KEY, text_value TEXT NOT NULL UNIQUE, int_value INTEGER, nullable_value TEXT, parent_id INTEGER REFERENCES __g6b_parent(id));`,
    false,
  );

  try {
    const inserted = await db.run(
      "INSERT INTO __g6b_probe(text_value,int_value,nullable_value,parent_id) VALUES (?,?,?,NULL)",
      ["العربية O'Reilly \"quoted\"", 42, null],
    );
    const row = (await db.query("SELECT text_value,int_value,nullable_value FROM __g6b_probe WHERE id=?", [inserted.lastInsertRowid]))[0];
    cases.push(row && row.text_value === "العربية O'Reilly \"quoted\"" && Number(row.int_value) === 42 && row.nullable_value === null
      ? pass("Q1_PARAMETER_BINDING", "Arabic + apostrophe/quotes + integer + null round-tripped through bound parameters")
      : fail("Q1_PARAMETER_BINDING", `round-trip mismatch ${JSON.stringify(row)}`));

    const update = await db.run("UPDATE __g6b_probe SET int_value=? WHERE id=?", [43, inserted.lastInsertRowid]);
    const zeroUpdate = await db.run("UPDATE __g6b_probe SET int_value=? WHERE id=?", [99, 999999]);
    const insertedDelete = await db.run("INSERT INTO __g6b_probe(text_value) VALUES (?)", ["delete-me"]);
    const del = await db.run("DELETE FROM __g6b_probe WHERE id=?", [insertedDelete.lastInsertRowid]);
    cases.push(update.changes === 1 && zeroUpdate.changes === 0 && del.changes === 1 && inserted.changes === 1
      ? pass("Q2_AFFECTED_ROWS", `INSERT=${inserted.changes}, UPDATE=${update.changes}, ZERO_UPDATE=${zeroUpdate.changes}, DELETE=${del.changes}`)
      : fail("Q2_AFFECTED_ROWS", JSON.stringify({ inserted, update, zeroUpdate, del })));

    const noop = await db.run("INSERT OR IGNORE INTO __g6b_probe(text_value) VALUES (?)", ["العربية O'Reilly \"quoted\""]);
    const rowidOk = typeof inserted.lastInsertRowid === "number" && update.lastInsertRowid === null && zeroUpdate.lastInsertRowid === null
      && del.lastInsertRowid === null && noop.changes === 0 && noop.lastInsertRowid === null;
    cases.push(rowidOk
      ? pass("Q3_LAST_INSERT_ROWID", `INSERT rowid=${inserted.lastInsertRowid}; UPDATE/zero-UPDATE/DELETE/no-op INSERT all null`)
      : fail("Q3_LAST_INSERT_ROWID", JSON.stringify({ inserted, update, zeroUpdate, del, noop })));

    await db.beginImmediate();
    await db.run("INSERT INTO __g6b_probe(text_value) VALUES (?)", ["tx-commit-a"]);
    await db.run("INSERT INTO __g6b_probe(text_value) VALUES (?)", ["tx-commit-b"]);
    await db.commit();
    const committed = Number((await db.query("SELECT count(*) AS c FROM __g6b_probe WHERE text_value LIKE 'tx-commit-%'"))[0].c);
    cases.push(committed === 2 ? pass("Q4_TRANSACTION_COMMIT", "literal BEGIN IMMEDIATE + two run(transaction=false) writes + literal COMMIT persisted both rows") : fail("Q4_TRANSACTION_COMMIT", `committed rows=${committed}`));

    const beforeRollback = Number((await db.query("SELECT int_value FROM __g6b_probe WHERE id=?", [inserted.lastInsertRowid]))[0].int_value);
    await db.beginImmediate();
    await db.run("UPDATE __g6b_probe SET int_value=777 WHERE id=?", [inserted.lastInsertRowid]);
    await db.run("INSERT INTO __g6b_probe(text_value) VALUES ('tx-rollback-row')");
    await db.rollback();
    const afterRollback = Number((await db.query("SELECT int_value FROM __g6b_probe WHERE id=?", [inserted.lastInsertRowid]))[0].int_value);
    const rollbackRows = Number((await db.query("SELECT count(*) AS c FROM __g6b_probe WHERE text_value='tx-rollback-row'"))[0].c);
    cases.push(beforeRollback === afterRollback && rollbackRows === 0
      ? pass("Q5_ROLLBACK", `original int_value=${beforeRollback} restored; rolled-back INSERT absent`)
      : fail("Q5_ROLLBACK", `before=${beforeRollback}, after=${afterRollback}, rollbackRows=${rollbackRows}`));

    const fk = await db.query("PRAGMA foreign_keys;");
    let fkRejected = false;
    try {
      await db.run("INSERT INTO __g6b_probe(text_value,parent_id) VALUES ('bad-fk',999999)");
    } catch {
      fkRejected = true;
    }
    cases.push(Number(fk[0]?.foreign_keys ?? 0) === 1 && fkRejected
      ? pass("Q6_FOREIGN_KEYS", "PRAGMA foreign_keys=1 and invalid FK INSERT rejected")
      : fail("Q6_FOREIGN_KEYS", `foreign_keys=${String(fk[0]?.foreign_keys)}, rejected=${fkRejected}`));

    const usable = await db.run("INSERT INTO __g6b_probe(text_value) VALUES ('after-rejection')");
    cases.push(usable.changes === 1 && usable.lastInsertRowid !== null
      ? pass("Q7_CONNECTION_AFTER_REJECTION", "connection remained usable after rejected FK statement")
      : fail("Q7_CONNECTION_AFTER_REJECTION", JSON.stringify(usable)));

    await db.run("INSERT INTO __g6b_probe(text_value) VALUES ('persistence-marker')");
    await closeGate6BDatabase(GATE6B_PROBE_DB_NAME);
    opened = await openGate6BDatabase(GATE6B_PROBE_DB_NAME);
    const persisted = Number((await opened.adapter.query("SELECT count(*) AS c FROM __g6b_probe WHERE text_value='persistence-marker'"))[0].c);
    cases.push(persisted === 1
      ? pass("Q10_PERSISTENCE", "connection closed and same app-private DB reopened; durable marker survived")
      : fail("Q10_PERSISTENCE", `persistence marker count=${persisted}`));

    cases.push(pass("Q11_NO_NODE_DEPENDENCY", "device adapter + proof runner execute in Android WebView and import existing runtime-neutral core; companion CI statically rejects node:* imports under src/application and src/bootstrap"));
    cases.push(blocked("Q12_COMPETING_WRITE", "UNRESOLVED DEVICE-QUALIFICATION ITEM: @capacitor-community/sqlite Android native layer permits only one RW_<database> connection name and rejects a second RW connection to the same file; no fake Promise-timeout lock proof is claimed. Literal BEGIN IMMEDIATE and transaction=false ownership are separately exercised by Q4/Q5."));
  } catch (error) {
    cases.push(fail("ADAPTER_QUALIFICATION_INTERNAL", error instanceof Error ? error.message : String(error)));
  }
  return { opened, cases };
}

export async function runAdapterQualification(): Promise<Gate6BProofOutput> {
  const { opened: probeOpened, cases } = await adapterQualificationCases();
  try {
    await deleteGate6BDatabase(GATE6B_PROOF_DB_NAME);
    const opened = await openGate6BDatabase(GATE6B_PROOF_DB_NAME);
    const schemaCase = await executeCanonicalSchema(opened);
    cases.push(schemaCase);
    if (schemaCase.status === "PASS") cases.push(await bootstrapCanonical(opened.adapter));
    const base = await baseOutput(opened, "ADAPTER_QUALIFICATION");
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME);
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: null,
      currentVisitStateZeroWrite: { measured: false, before: null, after: null, delta: null },
      overallResult: overallOf(cases),
    };
  } finally {
    await closeGate6BDatabase(GATE6B_PROBE_DB_NAME).catch(() => undefined);
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME).catch(() => undefined);
    void probeOpened;
  }
}

export async function runApplicationCoreProof(): Promise<Gate6BProofOutput> {
  await deleteGate6BDatabase(GATE6B_PROOF_DB_NAME);
  const opened = await openGate6BDatabase(GATE6B_PROOF_DB_NAME);
  const cases: QualificationCase[] = [];
  try {
    cases.push(await executeCanonicalSchema(opened));
    if (cases[0].status !== "PASS") throw new Error("canonical schema proof failed");
    cases.push(await bootstrapCanonical(opened.adapter));
    const core = await representativeCoreFlow(opened);
    cases.push(...core.cases);
    cases.push(await runFinalizationScenario(opened));
    const base = await baseOutput(opened, "APPLICATION_CORE_PROOF");
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: core.visitId,
      currentVisitStateZeroWrite: { measured: true, before: core.zero.before, after: core.zero.after, delta: core.zero.delta },
      stateHashSha256: await sha256Hex(canonicalProofJson(core.state)),
      overallResult: overallOf(cases),
    };
  } catch (error) {
    cases.push(fail("APPLICATION_CORE_PROOF_INTERNAL", error instanceof Error ? error.message : String(error)));
    const base = await baseOutput(opened, "APPLICATION_CORE_PROOF");
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: null,
      currentVisitStateZeroWrite: { measured: false, before: null, after: null, delta: null },
      overallResult: "FAIL",
    };
  } finally {
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME).catch(() => undefined);
  }
}

async function findSyntheticVisit(db: SqlAdapter): Promise<number> {
  const rows = await db.query(
    `SELECT v.visit_id
       FROM visit v
       JOIN mission m ON m.mission_id=v.mission_id
       JOIN institution i ON i.institution_id=v.institution_id
      WHERE m.name=? AND i.official_code=?
      ORDER BY v.visit_id DESC`,
    [SYNTHETIC_MISSION, SYNTHETIC_INSTITUTION_CODE],
  );
  if (rows.length !== 1) throw new Error(`restart discovery expected exactly one synthetic Visit, got ${rows.length}`);
  return Number(rows[0].visit_id);
}

export async function runRestartPhaseA(): Promise<Gate6BProofOutput> {
  await deleteGate6BDatabase(GATE6B_PROOF_DB_NAME);
  const opened = await openGate6BDatabase(GATE6B_PROOF_DB_NAME);
  const cases: QualificationCase[] = [];
  let visitId: number | null = null;
  try {
    cases.push(await executeCanonicalSchema(opened));
    cases.push(await bootstrapCanonical(opened.adapter));
    if (cases.some((c) => c.status === "FAIL")) throw new Error("phase A initialization failed");
    const core = await representativeCoreFlow(opened);
    visitId = core.visitId;
    cases.push(...core.cases);
    const hash = await sha256Hex(canonicalProofJson(core.state));
    cases.push(pass("RESTART_PHASE_A", `durable synthetic Visit created; state hash=${hash}; close/reopen must rediscover via SQLite marker, not process memory`));
    const base = await baseOutput(opened, "RESTART_PHASE_A_BEFORE_FORCE_STOP");
    const out: Gate6BProofOutput = {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: visitId,
      currentVisitStateZeroWrite: { measured: true, before: core.zero.before, after: core.zero.after, delta: core.zero.delta },
      stateHashSha256: hash,
      overallResult: overallOf(cases, true),
    };
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME);
    return out;
  } catch (error) {
    cases.push(fail("RESTART_PHASE_A_INTERNAL", error instanceof Error ? error.message : String(error)));
    const base = await baseOutput(opened, "RESTART_PHASE_A_BEFORE_FORCE_STOP");
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: visitId,
      currentVisitStateZeroWrite: { measured: false, before: null, after: null, delta: null },
      overallResult: "FAIL",
    };
  } finally {
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME).catch(() => undefined);
  }
}

export async function runRestartPhaseB(): Promise<Gate6BProofOutput> {
  const opened = await openGate6BDatabase(GATE6B_PROOF_DB_NAME);
  const cases: QualificationCase[] = [];
  let visitId: number | null = null;
  try {
    const expected = expectedInventoryFromCanonicalSchema(CANONICAL_SCHEMA_SQL);
    const actual = await actualInventory(opened.adapter);
    const diff = inventoryDiff(expected, actual);
    const integrity = await opened.adapter.query("PRAGMA integrity_check;");
    cases.push(diff.equal && String(integrity[0]?.integrity_check) === "ok"
      ? pass("Q8_SCHEMA_REOPEN", "same DB reopened after process restart; canonical-derived exact inventory still matches and integrity_check=ok")
      : fail("Q8_SCHEMA_REOPEN", JSON.stringify({ diff, integrity })));
    visitId = await findSyntheticVisit(opened.adapter);
    const zero = await zeroWriteState(opened.adapter, visitId);
    const hash = await sha256Hex(canonicalProofJson(zero.state));
    const expectedShape = zero.state.mission.name === SYNTHETIC_MISSION
      && zero.state.institution.officialCode === SYNTHETIC_INSTITUTION_CODE
      && zero.state.observations.some((o) => o.text === SYNTHETIC_OBSERVATION)
      && zero.state.correctiveActions.length === 1;
    cases.push(expectedShape
      ? pass("RESTART_PHASE_B", `visit ${visitId} rediscovered from SQLite markers only; representative durable state reconstructed; state hash=${hash}`)
      : fail("RESTART_PHASE_B", "reconstructed durable state does not match fixed synthetic scenario"));
    cases.push(zero.delta === 0
      ? pass("Q_CURRENT_VISIT_ZERO_WRITE", `total_changes before=${zero.before}, after=${zero.after}, delta=0 after real restart path`)
      : fail("Q_CURRENT_VISIT_ZERO_WRITE", `delta=${zero.delta}`));
    const base = await baseOutput(opened, "RESTART_PHASE_B_AFTER_FORCE_STOP");
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: visitId,
      currentVisitStateZeroWrite: { measured: true, before: zero.before, after: zero.after, delta: zero.delta },
      stateHashSha256: hash,
      overallResult: overallOf(cases),
    };
  } catch (error) {
    cases.push(fail("RESTART_PHASE_B_INTERNAL", error instanceof Error ? error.message : String(error)));
    const base = await baseOutput(opened, "RESTART_PHASE_B_AFTER_FORCE_STOP");
    return {
      ...base,
      qualification: cases,
      visitIdentifierRecoveredFromSqlite: visitId,
      currentVisitStateZeroWrite: { measured: false, before: null, after: null, delta: null },
      overallResult: "FAIL",
    };
  } finally {
    await closeGate6BDatabase(GATE6B_PROOF_DB_NAME).catch(() => undefined);
  }
}

export async function resetSyntheticProofDatabase(): Promise<void> {
  await deleteGate6BDatabase(GATE6B_PROOF_DB_NAME);
  await deleteGate6BDatabase(GATE6B_PROBE_DB_NAME);
}
