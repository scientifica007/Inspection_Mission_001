// Gate 5C — Visit scope composition (first executable Application-Core slice)
// (runtime-neutral TypeScript, no node:* imports).
//
// Implements the domain operations of the Gate-5A catalog that this gate is
// allowed to build:
//   * createVisit          — T0 (TRANSACTION-CONTRACTS §2 / APPLICATION-CORE §4.1):
//                            mission gate → manifest-vs-ACTIVE-P0 exact-set
//                            equality (both directions, P1 excluded) → Visit row
//                            (PREPARATION) → institution-context cell set that
//                            freezes the captured instrument universe.
//   * addSubjectToScope    — T1 (§4.2 / TRANSACTION §3): expected grid derived
//                            ONLY from the Visit's captured institution-context
//                            rows (pinned item_definition_id values — never a
//                            current-ACTIVE discovery). Existing subject:
//                            A full grid → idempotent no-INSERT success;
//                            B zero actual → atomic full-grid insert;
//                            C partial/mismatch → ROLLBACK + E_SCOPE_GAP
//                            (never silently repaired). New subject: subject
//                            creation (identity-creating, class B) + full-grid
//                            insert in the same transaction.
//   * evaluateApplicability is applied per pinned rule (see applicability.ts).
//
// Transaction rules (TRANSACTION §1, RECOVERY §1.5):
//   * every operation is ONE explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK;
//   * every write expected to affect exactly one row passes an affected-row
//     cardinality check (B5);
//   * on any failure the whole unit rolls back — no partial Visit/grid remains;
//   * T0 and the new-subject path are idempotency class B (identity-creating,
//     no exactly-once claim); the existing-subject path is class A through the
//     exact grid comparison inside the transaction.

import type { SqlAdapter, SqlResult, SqlValue } from "../bootstrap/adapter.ts";
import { verifyLoadedActiveP0 } from "../bootstrap/manifest.ts";
import { isBootstrapError } from "../bootstrap/errors.ts";
import { APP_ERR, DomainError, type AppErrorCode } from "./errors.ts";
import { evaluateApplicability, overlayStateForOutcome, type ContextKind, type VisitType } from "./applicability.ts";

// ---------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------

export interface CreateVisitInput {
    missionId: number;
    institutionId: number;
    visitType: VisitType;
    /** ISO-8601 visit date text (schema has no parser; app-supplied) */
    visitDate: string;
    inspector: string;
    /** the verified Gate-5B manifest expected v1 P0 item-code set (authority) */
    expectedP0ItemCodes: readonly string[];
    actor: string;
    /** ISO-8601 UTC instant reused for visit.created_at and every cell recorded_at */
    now: string;
}

export interface CreateVisitResult {
    visitId: number;
    capturedCount: number;
}

/** New on-site subject data. institution_id is pinned to the Visit's institution. */
export interface NewSubjectInput {
    subjectType: ContextKind;
    name: string;
    subjectTypeOther?: string | null;
    locationDesc?: string | null;
    specialty?: string | null;
    active?: boolean;
}

export type AddSubjectToScopeInput =
    | {
          kind: "existing";
          visitId: number;
          subjectId: number;
          actor: string;
          now: string;
      }
    | {
          kind: "new";
          visitId: number;
          subject: NewSubjectInput;
          actor: string;
          now: string;
      };

export interface AddSubjectToScopeResult {
    subjectId: number;
    /** false only for the idempotent existing-subject branch A (no INSERT) */
    materialized: boolean;
    materializedCount: number;
}

interface VisitSnapshot {
    visitId: number;
    status: string;
    institutionId: number;
    visitType: VisitType;
}

interface CapturedDefinition {
    itemDefinitionId: number;
    itemCode: string;
    applicabilityRule: string;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class VisitScopeService {
    private readonly db: SqlAdapter;

    constructor(db: SqlAdapter) {
        this.db = db;
    }

    /**
     * T0 — createVisit: one atomic unit. Mission gate + manifest-vs-ACTIVE-P0
     * exact-set equality (both directions, P1 excluded) + Visit row + the
     * institution-context cell set (subject_id NULL) over every expected P0
     * code in deterministic item-code order. Those institution rows ARE the
     * authoritative captured instrument universe of the Visit (§3.5, §6).
     * Any failure rolls everything back — no partial Visit/grid may remain.
     */
    async createVisit(input: CreateVisitInput): Promise<CreateVisitResult> {
        return this.withTransaction(async () => {
            // -- 0) mission gate: re-read mission; only PREPARATION/ACTIVE accept
            //        a new Visit (APP validation, E_MISSION_CLOSED — no schema change)
            const missionRows = await this.db.query("SELECT status FROM mission WHERE mission_id = ?", [input.missionId]);
            if (missionRows.length === 0) {
                throw new DomainError(APP_ERR.MISSION_NOT_FOUND, `createVisit: mission ${input.missionId} does not exist`);
            }
            const missionStatus = String(missionRows[0].status);
            if (missionStatus !== "PREPARATION" && missionStatus !== "ACTIVE") {
                throw new DomainError(
                    APP_ERR.MISSION_CLOSED,
                    `createVisit: mission ${input.missionId} is '${missionStatus}'; ` +
                        "a COMPLETED/ARCHIVED mission accepts no new Visit (PREPARATION/ACTIVE required)",
                );
            }

            // -- 1) manifest-vs-loaded exact-set equality, BOTH directions,
            //        P1 excluded. Reuses the executable Gate-5B check; the
            //        domain never hard-codes CHK codes.
            try {
                await verifyLoadedActiveP0(this.db, input.expectedP0ItemCodes);
            } catch (e) {
                if (isBootstrapError(e)) {
                    throw new DomainError(e.code as AppErrorCode, `createVisit: ${e.message}`);
                }
                throw e;
            }

            // -- 2) resolve exactly one ACTIVE definition per expected P0 code.
            //        uq_active_def_per_code guarantees at most one; the exact-set
            //        equality just proved existence for every expected code, so
            //        these rows are exactly the manifest universe, code-sorted.
            const defRows = await this.db.query(
                `SELECT item_definition_id, item_code, applicability_rule
                   FROM checklist_item_definition
                  WHERE status = 'ACTIVE' AND priority = 'P0'
                  ORDER BY item_code`,
            );
            const resolved: CapturedDefinition[] = [];
            const seen = new Set<string>();
            for (const r of defRows) {
                const code = String(r.item_code);
                if (seen.has(code)) {
                    throw new DomainError(
                        APP_ERR.STATE_CONFLICT,
                        `createVisit: more than one ACTIVE definition for P0 code ${code} (uq_active_def_per_code violated)`,
                    );
                }
                seen.add(code);
                resolved.push({
                    itemDefinitionId: Number(r.item_definition_id),
                    itemCode: code,
                    applicabilityRule: String(r.applicability_rule),
                });
            }

            // -- 3) create the Visit row (PREPARATION; trg_visit_bi guards)
            const visitRes = await this.db.run(
                `INSERT INTO visit(mission_id, institution_id, visit_type, visit_date, status,
                                   inspector, created_at, created_by)
                 VALUES (?, ?, ?, ?, 'PREPARATION', ?, ?, ?)`,
                [
                    input.missionId,
                    input.institutionId,
                    input.visitType,
                    input.visitDate,
                    input.inspector,
                    input.now,
                    input.actor,
                ] as readonly SqlValue[],
            );
            this.guardSingleRow(visitRes, "visit insert");
            if (visitRes.lastInsertRowid === null) {
                throw new DomainError(APP_ERR.STATE_CONFLICT, "createVisit: visit insert returned no rowid");
            }
            const visitId = visitRes.lastInsertRowid;

            // -- 4) materialize the institution context (subject_id NULL) for
            //        every code of the manifest universe — the captured
            //        instrument universe. NOT_APPLICABLE => NA; APPLICABLE and
            //        HUMAN_CONFIRMATION both materialize as the true-pending
            //        NOT_INSPECTED state (answer/reason/finding NULL).
            let captured = 0;
            for (const def of resolved) {
                const outcome = evaluateApplicability(def.applicabilityRule, "INSTITUTION", input.visitType);
                const overlay = overlayStateForOutcome(outcome);
                const cellRes = await this.db.run(
                    `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state,
                                                    recorded_at, recorded_by)
                     VALUES (?, ?, NULL, ?, ?, ?)`,
                    [visitId, def.itemDefinitionId, overlay, input.now, input.actor] as readonly SqlValue[],
                );
                this.guardSingleRow(cellRes, `institution-context cell ${def.itemCode}`);
                captured += 1;
            }

            return { visitId, capturedCount: captured };
        });
    }

    /**
     * T1 — addSubjectToScope (existing subject | new subject data), one atomic
     * unit. The expected grid is derived exclusively from the Visit's captured
     * institution-context rows; a later ACTIVE/definition release never
     * retro-enters an existing Visit.
     */
    async addSubjectToScope(input: AddSubjectToScopeInput): Promise<AddSubjectToScopeResult> {
        return this.withTransaction(async () => {
            // re-read the Visit: must exist and still be in PREPARATION
            const visitRows = await this.db.query(
                "SELECT status, institution_id, visit_type FROM visit WHERE visit_id = ?",
                [input.visitId],
            );
            if (visitRows.length === 0) {
                throw new DomainError(APP_ERR.VISIT_NOT_FOUND, `addSubjectToScope: visit ${input.visitId} does not exist`);
            }
            const visit: VisitSnapshot = {
                visitId: input.visitId,
                status: String(visitRows[0].status),
                institutionId: Number(visitRows[0].institution_id),
                visitType: String(visitRows[0].visit_type) as VisitType,
            };
            if (visit.status !== "PREPARATION") {
                throw new DomainError(
                    APP_ERR.VISIT_NOT_PREPARATION,
                    `addSubjectToScope: visit ${input.visitId} is '${visit.status}'; scope may only be composed while the Visit is PREPARATION`,
                );
            }

            // resolve the subject context
            let subjectId: number;
            let subjectType: ContextKind;
            if (input.kind === "existing") {
                const subjectRows = await this.db.query(
                    "SELECT subject_id, institution_id, subject_type FROM inspected_subject WHERE subject_id = ?",
                    [input.subjectId],
                );
                if (subjectRows.length === 0) {
                    throw new DomainError(
                        APP_ERR.SUBJECT_NOT_FOUND,
                        `addSubjectToScope: subject ${input.subjectId} does not exist`,
                    );
                }
                if (Number(subjectRows[0].institution_id) !== visit.institutionId) {
                    throw new DomainError(
                        APP_ERR.CONTEXT,
                        `addSubjectToScope: subject ${input.subjectId} belongs to institution ` +
                            `${Number(subjectRows[0].institution_id)} but visit ${input.visitId} inspects institution ` +
                            `${visit.institutionId} (E_CONTEXT)`,
                    );
                }
                subjectId = input.subjectId;
                subjectType = String(subjectRows[0].subject_type) as ContextKind;
            } else {
                const s = input.subject;
                // new on-site subject: identity-creating (class B), pinned to the
                // Visit's institution so the subject-institution precondition holds
                const subjectRes = await this.db.run(
                    `INSERT INTO inspected_subject(institution_id, subject_type, subject_type_other, name,
                                                   location_desc, specialty, active, created_at, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        visit.institutionId,
                        s.subjectType,
                        s.subjectTypeOther ?? null,
                        s.name,
                        s.locationDesc ?? null,
                        s.specialty ?? null,
                        s.active === false ? 0 : 1,
                        input.now,
                        input.actor,
                    ] as readonly SqlValue[],
                );
                this.guardSingleRow(subjectRes, "inspected_subject insert");
                if (subjectRes.lastInsertRowid === null) {
                    throw new DomainError(APP_ERR.STATE_CONFLICT, "addSubjectToScope: subject insert returned no rowid");
                }
                subjectId = subjectRes.lastInsertRowid;
                subjectType = s.subjectType;
            }

            return this.composeSubjectGrid(visit, subjectId, subjectType, input.actor, input.now, input.kind === "existing");
        });
    }

    /**
     * Shared T1 body. Expected defs = captured universe (institution-context
     * rows joined to their pinned definitions). Existing subjects additionally
     * run the A/B/C branch comparison; new subjects always insert the full grid.
     */
    private async composeSubjectGrid(
        visit: VisitSnapshot,
        subjectId: number,
        subjectType: ContextKind,
        actor: string,
        now: string,
        existingSubject: boolean,
    ): Promise<AddSubjectToScopeResult> {
        // expected grid: ONLY the captured universe (pinned item_definition_id
        // values + their frozen rules) — never a current-ACTIVE discovery
        const universeRows = await this.db.query(
            `SELECT d.item_code, cr.item_definition_id, d.applicability_rule
               FROM checklist_response cr
               JOIN checklist_item_definition d ON d.item_definition_id = cr.item_definition_id
              WHERE cr.visit_id = ? AND cr.subject_id IS NULL
              ORDER BY d.item_code, cr.response_id`,
            [visit.visitId],
        );
        const expected: CapturedDefinition[] = universeRows.map((r) => ({
            itemDefinitionId: Number(r.item_definition_id),
            itemCode: String(r.item_code),
            applicabilityRule: String(r.applicability_rule),
        }));

        if (existingSubject) {
            const actualRows = await this.db.query(
                "SELECT item_definition_id FROM checklist_response WHERE visit_id = ? AND subject_id = ?",
                [visit.visitId, subjectId],
            );
            const actualIds = actualRows.map((r) => Number(r.item_definition_id));
            const expectedIds = expected.map((d) => d.itemDefinitionId);

            // A — actual == expected full captured universe: idempotent success,
            //     no INSERT (genuinely class A for an existing subject)
            if (actualIds.length === expectedIds.length && actualIds.every((id) => expectedIds.includes(id))) {
                return { subjectId, materialized: false, materializedCount: 0 };
            }

            // C — partial / mismatched grid: ROLLBACK + E_SCOPE_GAP, never a
            //     silent repair (any actual row at all that is not the full grid)
            if (actualIds.length > 0) {
                throw new DomainError(
                    APP_ERR.SCOPE_GAP,
                    `addSubjectToScope: subject ${subjectId} of visit ${visit.visitId} has ${actualIds.length} ` +
                        `materialized cell(s) but the captured universe requires exactly ${expectedIds.length}; ` +
                        "scope composition refuses to repair a partial grid (E_SCOPE_GAP)",
                );
            }
            // B — actual count == 0: fall through to insert the complete grid
        }

        // branch B (existing, empty) and the new-subject path: materialize the
        // full expected grid atomically for this subject context
        let inserted = 0;
        for (const def of expected) {
            const outcome = evaluateApplicability(def.applicabilityRule, subjectType, visit.visitType);
            const overlay = overlayStateForOutcome(outcome);
            const cellRes = await this.db.run(
                `INSERT INTO checklist_response(visit_id, item_definition_id, subject_id, overlay_state,
                                                recorded_at, recorded_by)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [visit.visitId, def.itemDefinitionId, subjectId, overlay, now, actor] as readonly SqlValue[],
            );
            this.guardSingleRow(cellRes, `subject cell ${def.itemCode}`);
            inserted += 1;
        }
        return { subjectId, materialized: true, materializedCount: inserted };
    }

    // -- transaction + cardinality helpers ------------------------------------

    /** One explicit BEGIN IMMEDIATE … COMMIT unit; any failure rolls back. */
    private async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.db.beginImmediate();
        try {
            const result = await fn();
            await this.db.commit();
            return result;
        } catch (e) {
            try {
                await this.db.rollback();
            } catch {
                // rollback must never mask the original failure
            }
            throw e;
        }
    }

    /** B5 affected-row cardinality: a write expected to change one row must. */
    private guardSingleRow(res: SqlResult, what: string): void {
        if (res.changes !== 1) {
            throw new DomainError(
                APP_ERR.STATE_CONFLICT,
                `${what}: expected exactly one affected row, got ${res.changes} (B5 cardinality check failed)`,
            );
        }
    }
}
