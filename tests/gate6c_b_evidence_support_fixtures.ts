import { FakeAcquisition, EvidenceApplicationContext, EvidenceService, CAPTURED, NOW, HASH_A, SCHEMA_SQL, assert, openFreshDb } from "./gate6c_b_evidence_support_core.ts";
export function syntheticEvidenceRow(storageRef, evidenceId = 900, overrides = {}) {
    return {
        evidence_id: evidenceId,
        owner_kind: "VISIT",
        owner_ref: 1,
        storage_ref: storageRef,
        content_hash: HASH_A,
        file_name: "inspection.bin",
        mime_type: "application/octet-stream",
        file_size: 321,
        captured_at: CAPTURED,
        device_note: "synthetic-device-note",
        note: null,
        recorded_at: NOW,
        recorded_by: "inspector-a",
        ...overrides,
    };
}
export async function freshWorld() {
    const db = openFreshDb(SCHEMA_SQL);
    const missionId = Number((await db.run(`INSERT INTO mission(name,status,created_at,created_by) VALUES ('M','PREPARATION',?,'owner')`, [NOW])).lastInsertRowid);
    const institutionId = Number((await db.run(`INSERT INTO institution(name,created_at,created_by) VALUES ('I',?,'owner')`, [NOW])).lastInsertRowid);
    const visitId = Number((await db.run(`INSERT INTO visit(mission_id,institution_id,visit_type,visit_date,status,inspector,created_at,created_by)
         VALUES (?,?,'PLANNED','2026-09-10','PREPARATION','inspector-a',?,'owner')`, [missionId, institutionId, NOW])).lastInsertRowid);
    const rule = JSON.stringify({
        rule_schema_version: 1,
        item_code: "G6C-FIXTURE",
        decision_kind: "AUTO",
        subject_kinds: ["INSTITUTION"],
        source_ar: "synthetic fixture",
    });
    const defId = Number((await db.run(`INSERT INTO checklist_item_definition(item_code,version_no,domain_id,arabic_question,response_model,priority,
                                               traceability,requirement_refs,applicability_rule,status)
         VALUES ('G6C-FIXTURE',1,'DOM-14','سؤال تجريبي','SINGLE_VALUE','P0','PROJECT','PRJ-04',?,'ACTIVE')`, [rule])).lastInsertRowid);
    const responseId = Number((await db.run(`INSERT INTO checklist_response(visit_id,item_definition_id,subject_id,overlay_state,recorded_at,recorded_by)
         VALUES (?,?,NULL,'NA',?,'owner')`, [visitId, defId, NOW])).lastInsertRowid);
    const observationId = Number((await db.run(`INSERT INTO adhoc_observation(visit_id,subject_id,text,finding_id,recorded_at,recorded_by)
         VALUES (?,NULL,'synthetic observation',NULL,?,'owner')`, [visitId, NOW])).lastInsertRowid);
    const findingId = Number((await db.run(`INSERT INTO finding(origin_visit_id,description,urgency,impact,status,created_at,created_by)
         VALUES (?,'synthetic finding','ROUTINE','LOW','OPEN',?,'owner')`, [visitId, NOW])).lastInsertRowid);
    const actionId = Number((await db.run(`INSERT INTO corrective_action(finding_id,action_type,description,responsible_role,status,created_at,created_by)
         VALUES (?,'MAINTENANCE_WORK','synthetic action','INSPECTOR','OPEN',?,'owner')`, [findingId, NOW])).lastInsertRowid);
    const followupId = Number((await db.run(`INSERT INTO follow_up(finding_id,corrective_action_id,visit_id,status_target,status_after,event_datetime,
                              actor_role,actor_name,note,recorded_by)
         VALUES (?,NULL,?,NULL,NULL,?,'INSPECTOR','synthetic inspector','synthetic follow-up','owner')`, [findingId, visitId, NOW])).lastInsertRowid);
    return {
        db,
        ownerIds: {
            VISIT: visitId,
            CHECKLIST_RESPONSE: responseId,
            ADHOC_OBSERVATION: observationId,
            FINDING: findingId,
            CORRECTIVE_ACTION: actionId,
            FOLLOW_UP: followupId,
        },
    };
}
export function createInput(ownerKind, ownerRef, sourceKind = "GENERIC_FILE") {
    return { ownerKind, ownerRef, sourceKind, recordedAt: NOW, recordedBy: " inspector-a ", note: " synthetic note " };
}
export async function insertEvidenceRaw(db, ownerKind, ownerRef, storageRef, options = {}) {
    const res = await db.run(`INSERT INTO evidence(owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,
                              device_note,note,recorded_at,recorded_by)
         VALUES (?,?,?,?,?,'application/octet-stream',?,?,NULL,NULL,?,?)`, [
        ownerKind,
        ownerRef,
        storageRef,
        options.hash === undefined ? HASH_A : options.hash,
        options.fileName ?? "inspection.bin",
        options.fileSize === undefined ? 321 : options.fileSize,
        CAPTURED,
        NOW,
        options.recordedBy ?? "inspector-a",
    ]);
    assert(res.changes === 1 && res.lastInsertRowid !== null, "raw Evidence fixture insert failed");
    return Number(res.lastInsertRowid);
}
export function serviceFor(db, storage, acquisition = new FakeAcquisition(), options = {}) {
    const context = options.context ?? new EvidenceApplicationContext();
    const svc = new EvidenceService(db, acquisition, storage, context, { maxCandidateAttempts: options.maxCandidateAttempts });
    const rawCreate = svc.createEvidence.bind(svc);
    const rawReconcile = svc.reconcileEvidence.bind(svc);
    svc.createEvidence = async (input) => {
        if (context.readiness !== "READY")
            await rawReconcile();
        return rawCreate(input);
    };
    svc.reconcileEvidence = async (opts = {}) => rawReconcile(opts);
    return svc;
}
export function getItem(report, kind, ref) {
    return report.items.find((item) => {
        if (item.kind !== kind)
            return false;
        if (ref === undefined)
            return true;
        return ("storageRef" in item ? item.storageRef : item.ref) === ref;
    });
}
export function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}
