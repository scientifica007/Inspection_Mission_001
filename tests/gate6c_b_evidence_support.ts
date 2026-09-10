// Gate 6C-B — runtime-neutral Evidence orchestration/reconciliation host regression.
// Uses the canonical schema through the existing Node SqlAdapter host seam.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlResult, SqlRow, SqlValue } from "../src/bootstrap/adapter.ts";
import { openFreshDb } from "../dev/node-sqlite-adapter.ts";
import { APP_ERR, DomainError } from "../src/application/errors.ts";
import {
    EvidenceMaintenanceQueue,
    EvidenceService,
    isCanonicalSha256,
    isCanonicalStagingRef,
    isCanonicalStorageRef,
    type AcquisitionOutcome,
    type CreateEvidenceInput,
    type EvidenceObjectAllocation,
    type EvidenceOwnerKind,
    type EvidenceSource,
    type EvidenceSourceAcquisition,
    type EvidenceSourceKind,
    type EvidenceStorage,
    type HashVerification,
    type ManagedEvidenceObject,
    type ResolvedEvidenceHandle,
    type StagedEvidenceObject,
    type StoredEvidenceObject,
    type StoredEvidenceStat,
} from "../src/application/evidence.ts";

export { openFreshDb, APP_ERR, DomainError, EvidenceMaintenanceQueue, EvidenceService, isCanonicalSha256, isCanonicalStagingRef, isCanonicalStorageRef };
export type { SqlAdapter, SqlResult, SqlRow, SqlValue };
export type { AcquisitionOutcome, CreateEvidenceInput, EvidenceObjectAllocation, EvidenceOwnerKind, EvidenceSource, EvidenceSourceAcquisition, EvidenceSourceKind, EvidenceStorage, HashVerification, ManagedEvidenceObject, ResolvedEvidenceHandle, StagedEvidenceObject, StoredEvidenceObject, StoredEvidenceStat };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
export const NOW = "2026-09-10T10:00:00.000Z";
export const CAPTURED = "2026-09-10T09:59:00.000Z";
export const HASH_A = `sha256:${"a".repeat(64)}`;
export const HASH_B = `sha256:${"b".repeat(64)}`;

const failures: string[] = [];
let passed = 0;

export async function ok(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed += 1; }
    catch (e) { failures.push(`${name} :: ${e instanceof Error ? e.message : String(e)}`); }
}
export function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(`assertion failed: ${message}`); }
export async function rejectsCode(code: string, fn: () => Promise<unknown>): Promise<Error> {
    try { await fn(); }
    catch (e) {
        const actual = e instanceof Error ? (e as { code?: unknown }).code : undefined;
        if (actual !== code) throw new Error(`expected ${code}, got ${String(actual)} :: ${e instanceof Error ? e.message : String(e)}`);
        return e as Error;
    }
    throw new Error(`expected ${code}, operation succeeded`);
}
export async function count(db: SqlAdapter, sql: string, params: readonly SqlValue[] = []): Promise<number> {
    const rows = await db.query(sql, params); return Number(rows[0].c);
}

export function uuid(n: number): string { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`; }
export function finalRef(n: number, ext = "bin"): string { return `evidence/v1/objects/${uuid(n)}.${ext}`; }
export function stagingRef(n: number): string { return `evidence/v1/.incoming/${uuid(n)}.part`; }
export function allocation(n: number, ext = "bin"): EvidenceObjectAllocation { return { storageRef: finalRef(n, ext), stagingRef: stagingRef(n) }; }

export class FakeAcquisition implements EvidenceSourceAcquisition {
    readonly calls: EvidenceSourceKind[] = [];
    camera: AcquisitionOutcome = successSource("CAMERA_PHOTO");
    gallery: AcquisitionOutcome = successSource("GALLERY_MEDIA");
    file: AcquisitionOutcome = successSource("GENERIC_FILE");
    async takeCameraPhoto(): Promise<AcquisitionOutcome> { this.calls.push("CAMERA_PHOTO"); return this.camera; }
    async chooseGalleryMedia(): Promise<AcquisitionOutcome> { this.calls.push("GALLERY_MEDIA"); return this.gallery; }
    async chooseGenericFile(): Promise<AcquisitionOutcome> { this.calls.push("GENERIC_FILE"); return this.file; }
}
export function successSource(kind: EvidenceSourceKind, extra: Partial<EvidenceSource> = {}): AcquisitionOutcome {
    return { status: "SUCCESS", source: { kind, sourceRef: `opaque:${kind.toLowerCase()}:candidate`, displayName: "inspection.bin", declaredMimeType: "application/octet-stream", sizeHint: 999999, capturedAt: CAPTURED, ...extra } };
}

interface FakeFinal { marker: string; fileSize: number; contentHash: string; }
export class FakeStorage implements EvidenceStorage {
    readonly allocations: EvidenceObjectAllocation[]; readonly allocationLog: string[]=[]; readonly stageLog:string[]=[]; readonly publishLog:string[]=[]; readonly existsLog:string[]=[]; readonly statLog:string[]=[]; readonly removedIncoming:string[]=[]; readonly removedOrphans:string[]=[]; readonly verifyLog:string[]=[]; readonly incoming=new Set<string>(); readonly finals=new Map<string,FakeFinal>(); readonly unknownObjects:ManagedEvidenceObject[]=[]; readonly events?:string[];
    stageHash=HASH_A; stageFileSize=321; stageFileName:string|undefined; stageMimeType:string|undefined; stageDeviceNote:string|null="synthetic-device-note"; failStage:Error|null=null; failPublish=false; failStat=false; failRemoveIncomingRefs=new Set<string>(); failRemoveOrphanRefs=new Set<string>(); mismatchRefs=new Set<string>(); verifyThrowsRefs=new Set<string>(); allocationIndex=0;
    constructor(allocations:EvidenceObjectAllocation[],events?:string[]){this.allocations=allocations;this.events=events;}
    async allocate(_source:EvidenceSource):Promise<EvidenceObjectAllocation>{const next=this.allocations[this.allocationIndex++];if(next===undefined)throw new Error("fake allocation queue exhausted");this.allocationLog.push(next.storageRef);this.events?.push(`allocate:${next.storageRef}`);return next;}
    async stage(source:EvidenceSource,a:EvidenceObjectAllocation):Promise<StagedEvidenceObject>{this.stageLog.push(a.storageRef);this.events?.push(`stage:${a.storageRef}`);this.incoming.add(a.stagingRef);if(this.failStage!==null)throw this.failStage;return{storageRef:a.storageRef,stagingRef:a.stagingRef,fileName:this.stageFileName??source.displayName??"evidence.bin",mimeType:this.stageMimeType??source.declaredMimeType??"application/octet-stream",fileSize:this.stageFileSize,contentHash:this.stageHash,capturedAt:source.capturedAt??null,deviceNote:this.stageDeviceNote};}
    async finalExists(storageRef:string):Promise<boolean>{this.existsLog.push(storageRef);this.events?.push(`exists:${storageRef}`);return this.finals.has(storageRef);}
    async publish(staged:StagedEvidenceObject):Promise<StoredEvidenceObject>{this.publishLog.push(staged.storageRef);this.events?.push(`publish:${staged.storageRef}`);if(this.finals.has(staged.storageRef))throw new Error("fake no-replace collision");if(this.failPublish)throw new Error("injected publish failure");this.incoming.delete(staged.stagingRef);this.finals.set(staged.storageRef,{marker:`new:${staged.storageRef}`,fileSize:staged.fileSize,contentHash:staged.contentHash});return{storageRef:staged.storageRef};}
    async stat(storageRef:string):Promise<StoredEvidenceStat>{this.statLog.push(storageRef);this.events?.push(`stat:${storageRef}`);if(this.failStat)throw new Error("injected stat failure");const f=this.finals.get(storageRef);if(f===undefined)throw new Error("missing final object");return{storageRef,fileSize:f.fileSize};}
    async resolve(storageRef:string):Promise<ResolvedEvidenceHandle>{if(!this.finals.has(storageRef))throw new Error("missing final object");return{storageRef,handleRef:`opaque-handle:${storageRef}`};}
    async listManagedObjects():Promise<ManagedEvidenceObject[]>{this.events?.push("listManagedObjects");return[...[...this.incoming].map(ref=>({kind:"INCOMING" as const,ref})),...[...this.finals.keys()].map(ref=>({kind:"FINAL" as const,ref})),...this.unknownObjects];}
    async removeIncoming(ref:string):Promise<void>{if(this.failRemoveIncomingRefs.has(ref))throw new Error("injected incoming cleanup failure");this.removedIncoming.push(ref);this.incoming.delete(ref);}
    async removeConfirmedOrphan(storageRef:string):Promise<void>{if(this.failRemoveOrphanRefs.has(storageRef))throw new Error("injected orphan cleanup failure");this.removedOrphans.push(storageRef);this.finals.delete(storageRef);}
    async verifyHash(storageRef:string,expectedHash:string):Promise<HashVerification>{this.verifyLog.push(storageRef);if(this.verifyThrowsRefs.has(storageRef))throw new Error("injected verify read failure");const f=this.finals.get(storageRef);if(f===undefined)throw new Error("missing final object");if(this.mismatchRefs.has(storageRef))return{matches:false,actualHash:HASH_B};return{matches:f.contentHash===expectedHash,actualHash:f.contentHash};}
    putFinal(storageRef:string,marker="existing",fileSize=321,contentHash=HASH_A):void{this.finals.set(storageRef,{marker,fileSize,contentHash});}
}

export class ProxyAdapter implements SqlAdapter {
    readonly inner:SqlAdapter; readonly events?:string[]; inTx=false; evidenceInsertCount=0; storageRefQueryCount=0; failEvidenceInsert=false; lieEvidenceInsertChanges:number|null=null; suppressEvidenceInsertRowid=false; commitMode:"NORMAL"|"FAIL_BEFORE_ONCE"|"ACK_LOSS_AFTER_ONCE"="NORMAL"; commitFaultUsed=false; afterAckLoss=false; transactionalStorageRefRows:SqlRow[]|null=null; recoveryStorageRefRows:SqlRow[]|null=null;
    constructor(inner:SqlAdapter,events?:string[]){this.inner=inner;this.events=events;}
    async beginImmediate():Promise<void>{this.events?.push("db:begin");await this.inner.beginImmediate();this.inTx=true;}
    async commit():Promise<void>{this.events?.push("db:commit");if(this.commitMode==="FAIL_BEFORE_ONCE"&&!this.commitFaultUsed){this.commitFaultUsed=true;throw new Error("injected commit failure before durable commit");}if(this.commitMode==="ACK_LOSS_AFTER_ONCE"&&!this.commitFaultUsed){this.commitFaultUsed=true;await this.inner.commit();this.inTx=false;this.afterAckLoss=true;throw new Error("injected ACK loss after durable commit");}await this.inner.commit();this.inTx=false;}
    async rollback():Promise<void>{this.events?.push("db:rollback");try{await this.inner.rollback();}finally{this.inTx=false;}}
    async run(sql:string,params:readonly SqlValue[]=[]):Promise<SqlResult>{if(sql.includes("INSERT INTO evidence")){this.evidenceInsertCount+=1;this.events?.push("db:evidence-insert");if(this.failEvidenceInsert)throw new Error("injected Evidence INSERT failure");const actual=await this.inner.run(sql,params);return{changes:this.lieEvidenceInsertChanges??actual.changes,lastInsertRowid:this.suppressEvidenceInsertRowid?null:actual.lastInsertRowid};}return this.inner.run(sql,params);}
    async query(sql:string,params:readonly SqlValue[]=[]):Promise<SqlRow[]>{const rows=await this.inner.query(sql,params);if(sql.includes("FROM evidence")&&sql.includes("WHERE storage_ref = ?")){this.storageRefQueryCount+=1;this.events?.push(this.inTx?"db:storage-ref-query:tx":"db:storage-ref-query:plain");if(this.afterAckLoss&&this.recoveryStorageRefRows!==null)return this.recoveryStorageRefRows;if(this.inTx&&!this.afterAckLoss&&this.transactionalStorageRefRows!==null)return this.transactionalStorageRefRows;}return rows;}
}

export function syntheticEvidenceRow(storageRef:string,evidenceId=900,overrides:Partial<Record<string,SqlValue>>={}):SqlRow{return{evidence_id:evidenceId,owner_kind:"VISIT",owner_ref:1,storage_ref:storageRef,content_hash:HASH_A,file_name:"inspection.bin",mime_type:"application/octet-stream",file_size:321,captured_at:CAPTURED,device_note:"synthetic-device-note",note:null,recorded_at:NOW,recorded_by:"inspector-a",...overrides};}
export interface World{db:SqlAdapter;ownerIds:Record<EvidenceOwnerKind,number>}
export async function freshWorld():Promise<World>{
    const db=openFreshDb(SCHEMA_SQL);
    const missionId=Number((await db.run(`INSERT INTO mission(name,status,created_at,created_by) VALUES ('M','PREPARATION',?,'owner')`,[NOW])).lastInsertRowid);
    const institutionId=Number((await db.run(`INSERT INTO institution(name,created_at,created_by) VALUES ('I',?,'owner')`,[NOW])).lastInsertRowid);
    const visitId=Number((await db.run(`INSERT INTO visit(mission_id,institution_id,visit_type,visit_date,status,inspector,created_at,created_by) VALUES (?,?,'PLANNED','2026-09-10','PREPARATION','inspector-a',?,'owner')`,[missionId,institutionId,NOW])).lastInsertRowid);
    const rule=JSON.stringify({rule_schema_version:1,item_code:"G6C-FIXTURE",decision_kind:"AUTO",subject_kinds:["INSTITUTION"],source_ar:"synthetic fixture"});
    const defId=Number((await db.run(`INSERT INTO checklist_item_definition(item_code,version_no,domain_id,arabic_question,response_model,priority,traceability,requirement_refs,applicability_rule,status) VALUES ('G6C-FIXTURE',1,'DOM-14','سؤال تجريبي','SINGLE_VALUE','P0','PROJECT','PRJ-04',?,'ACTIVE')`,[rule])).lastInsertRowid);
    const responseId=Number((await db.run(`INSERT INTO checklist_response(visit_id,item_definition_id,subject_id,overlay_state,recorded_at,recorded_by) VALUES (?,?,NULL,'NA',?,'owner')`,[visitId,defId,NOW])).lastInsertRowid);
    const observationId=Number((await db.run(`INSERT INTO adhoc_observation(visit_id,subject_id,text,finding_id,recorded_at,recorded_by) VALUES (?,NULL,'synthetic observation',NULL,?,'owner')`,[visitId,NOW])).lastInsertRowid);
    const findingId=Number((await db.run(`INSERT INTO finding(origin_visit_id,description,urgency,impact,status,created_at,created_by) VALUES (?,'synthetic finding','ROUTINE','LOW','OPEN',?,'owner')`,[visitId,NOW])).lastInsertRowid);
    const actionId=Number((await db.run(`INSERT INTO corrective_action(finding_id,action_type,description,responsible_role,status,created_at,created_by) VALUES (?,'MAINTENANCE_WORK','synthetic action','INSPECTOR','OPEN',?,'owner')`,[findingId,NOW])).lastInsertRowid);
    const followupId=Number((await db.run(`INSERT INTO follow_up(finding_id,corrective_action_id,visit_id,status_target,status_after,event_datetime,actor_role,actor_name,note,recorded_by) VALUES (?,NULL,?,NULL,NULL,?,'INSPECTOR','synthetic inspector','synthetic follow-up','owner')`,[findingId,visitId,NOW])).lastInsertRowid);
    return{db,ownerIds:{VISIT:visitId,CHECKLIST_RESPONSE:responseId,ADHOC_OBSERVATION:observationId,FINDING:findingId,CORRECTIVE_ACTION:actionId,FOLLOW_UP:followupId}};
}
export function createInput(ownerKind:EvidenceOwnerKind,ownerRef:number,sourceKind:EvidenceSourceKind="GENERIC_FILE"):CreateEvidenceInput{return{ownerKind,ownerRef,sourceKind,recordedAt:NOW,recordedBy:" inspector-a ",note:" synthetic note "};}
export async function insertEvidenceRaw(db:SqlAdapter,ownerKind:EvidenceOwnerKind,ownerRef:number,storageRef:string,options:{hash?:string|null;fileName?:string;fileSize?:number|null;recordedBy?:string}={}):Promise<number>{const res=await db.run(`INSERT INTO evidence(owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,device_note,note,recorded_at,recorded_by) VALUES (?,?,?,?,?,'application/octet-stream',?,?,NULL,NULL,?,?)`,[ownerKind,ownerRef,storageRef,options.hash===undefined?HASH_A:options.hash,options.fileName??"inspection.bin",options.fileSize===undefined?321:options.fileSize,CAPTURED,NOW,options.recordedBy??"inspector-a"]);assert(res.changes===1&&res.lastInsertRowid!==null,"raw Evidence fixture insert failed");return Number(res.lastInsertRowid);}
export function serviceFor(db:SqlAdapter,storage:FakeStorage,acquisition=new FakeAcquisition(),options:{maintenance?:EvidenceMaintenanceQueue;maxCandidateAttempts?:number}={}):EvidenceService{return new EvidenceService(db,acquisition,storage,options);}
export function getItem(report:Awaited<ReturnType<EvidenceService["reconcileEvidence"]>>,kind:string,ref?:string){return report.items.find(item=>{if(item.kind!==kind)return false;if(ref===undefined)return true;return("storageRef" in item?item.storageRef:item.ref)===ref;});}
export interface Deferred<T=void>{promise:Promise<T>;resolve:(value:T|PromiseLike<T>)=>void}
export function deferred<T=void>():Deferred<T>{let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
export function finish():void{console.log(`Gate 6C-B Evidence regression: ${passed} passed / ${failures.length} failed`);if(failures.length>0){for(const failure of failures)console.error(`FAIL ${failure}`);process.exitCode=1;}else console.log("PASS");}
