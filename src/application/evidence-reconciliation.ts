import type { SqlAdapter } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError, isDomainError } from "./errors.ts";
import {
    errorText, isCanonicalSha256, isCanonicalStagingRef, isCanonicalStorageRef, parseEvidenceRow,
    type EvidenceDbRow, type EvidenceHashDiagnostic, type EvidenceReconciliationItem,
    type EvidenceReconciliationReport, type EvidenceStorage, type ReconcileEvidenceOptions,
    type ResolvedEvidenceHandle,
} from "./evidence-contract.ts";

export class EvidenceReconciliationOrchestrator {
    private readonly db: SqlAdapter;
    private readonly storage: EvidenceStorage;
    constructor(db: SqlAdapter, storage: EvidenceStorage) {
        this.db = db;
        this.storage = storage;
    }

    async reconcileEvidence(options:ReconcileEvidenceOptions={}):Promise<EvidenceReconciliationReport>{
        let rows:EvidenceDbRow[];
        try{rows=(await this.db.query(`SELECT evidence_id,owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,device_note,note,recorded_at,recorded_by FROM evidence ORDER BY storage_ref,evidence_id`)).map(parseEvidenceRow);}
        catch(e){throw this.sqliteFailure("reconcileEvidence: Evidence read failed",e);}
        let objects;try{objects=await this.storage.listManagedObjects();}catch(e){throw new DomainError(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED,`reconcileEvidence: enumeration failed: ${errorText(e)}`);}

        const items:EvidenceReconciliationItem[]=[];
        const groups=new Map<string,EvidenceDbRow[]>();
        for(const r of rows){
            if(!isCanonicalStorageRef(r.storageRef)){items.push({kind:"BROKEN_STORAGE_REFERENCE",storageRef:r.storageRef,evidenceId:r.evidenceId});continue;}
            const g=groups.get(r.storageRef)??[];g.push(r);groups.set(r.storageRef,g);
        }
        const duplicates=new Set<string>();
        for(const [ref,g] of groups)if(g.length>1){duplicates.add(ref);items.push({kind:"STORAGE_REF_CONFLICT",storageRef:ref,evidenceIds:g.map(x=>x.evidenceId).sort((a,b)=>a-b)});}

        const finalRefs=new Set<string>();
        for(const o of [...objects].sort((a,b)=>`${a.ref}\0${a.kind}`.localeCompare(`${b.ref}\0${b.kind}`))){
            if(o.kind==="INCOMING"){
                if(!isCanonicalStagingRef(o.ref)){items.push({kind:"UNKNOWN_MANAGED_OBJECT",ref:o.ref});continue;}
                try{await this.storage.removeIncoming(o.ref);items.push({kind:"INCOMING_REMOVED",ref:o.ref});}
                catch{items.push({kind:"ORPHAN_CLEANUP_FAILED",ref:o.ref});}
                continue;
            }
            if(o.kind!=="FINAL"||!isCanonicalStorageRef(o.ref)){items.push({kind:"UNKNOWN_MANAGED_OBJECT",ref:o.ref});continue;}
            finalRefs.add(o.ref);
            const g=groups.get(o.ref)??[];
            if(duplicates.has(o.ref))continue;
            if(g.length===0){try{await this.storage.removeConfirmedOrphan(o.ref);items.push({kind:"ORPHAN_REMOVED",storageRef:o.ref});}catch{items.push({kind:"ORPHAN_CLEANUP_FAILED",ref:o.ref});}continue;}
            const r=g[0];
            try{const st=await this.storage.stat(r.storageRef);if(st.storageRef!==r.storageRef||!Number.isInteger(st.fileSize)||st.fileSize<0||(r.fileSize!==null&&st.fileSize!==r.fileSize)){items.push({kind:"STORAGE_DIAGNOSTIC_FAILED",ref:r.storageRef});continue;}}
            catch{items.push({kind:"STORAGE_DIAGNOSTIC_FAILED",ref:r.storageRef});continue;}
            if(options.verifyHashes===true&&r.contentHash!==null){
                if(!isCanonicalSha256(r.contentHash)){items.push({kind:"BROKEN_STORAGE_REFERENCE",storageRef:r.storageRef,evidenceId:r.evidenceId});continue;}
                try{if(!(await this.storage.verifyHash(r.storageRef,r.contentHash)).matches){items.push({kind:"HASH_MISMATCH",storageRef:r.storageRef,evidenceId:r.evidenceId});continue;}}
                catch{items.push({kind:"STORAGE_DIAGNOSTIC_FAILED",ref:r.storageRef});continue;}
            }
            items.push({kind:"VALID_REFERENCE",storageRef:r.storageRef,evidenceId:r.evidenceId});
        }
        for(const [ref,g] of groups){if(duplicates.has(ref)||finalRefs.has(ref))continue;for(const r of g)items.push({kind:"BROKEN_STORAGE_REFERENCE",storageRef:ref,evidenceId:r.evidenceId});}
        items.sort((a,b)=>sortKey(a).localeCompare(sortKey(b)));
        return {items};
    }

    async verifyEvidenceHash(evidenceId:number):Promise<EvidenceHashDiagnostic>{
        const r=await this.readOne(evidenceId,"verifyEvidenceHash");
        if(!isCanonicalStorageRef(r.storageRef))throw this.broken(evidenceId,"malformed storage_ref");
        if(r.contentHash===null)return {status:"HISTORICAL_HASH_ABSENT",evidenceId,storageRef:r.storageRef};
        if(!isCanonicalSha256(r.contentHash))throw this.broken(evidenceId,"non-canonical stored content_hash");
        try{if(!(await this.storage.finalExists(r.storageRef)))throw this.broken(evidenceId,"managed object missing");
            if(!(await this.storage.verifyHash(r.storageRef,r.contentHash)).matches)throw new DomainError(APP_ERR.EVIDENCE_HASH_MISMATCH,`verifyEvidenceHash: evidence ${evidenceId} digest mismatch`);
        }catch(e){if(isDomainError(e))throw e;throw new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE,`verifyEvidenceHash: managed object unreadable: ${errorText(e)}`);}
        return {status:"MATCH",evidenceId,storageRef:r.storageRef};
    }

    async resolveEvidence(evidenceId:number):Promise<ResolvedEvidenceHandle>{
        const r=await this.readOne(evidenceId,"resolveEvidence");
        if(!isCanonicalStorageRef(r.storageRef))throw this.broken(evidenceId,"malformed storage_ref");
        try{if(!(await this.storage.finalExists(r.storageRef)))throw this.broken(evidenceId,"managed object missing");return await this.storage.resolve(r.storageRef);}
        catch(e){if(isDomainError(e))throw e;throw this.broken(evidenceId,`managed object unresolved: ${errorText(e)}`);}
    }

    private async readOne(id:number,op:string):Promise<EvidenceDbRow>{
        if(!Number.isInteger(id)||id<1)throw new DomainError(APP_ERR.CONFIG,`${op}: evidenceId must be positive integer`);
        try{const rows=await this.db.query(`SELECT evidence_id,owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,device_note,note,recorded_at,recorded_by FROM evidence WHERE evidence_id = ?`,[id]);
            if(rows.length!==1)throw new DomainError(APP_ERR.EVIDENCE_NOT_FOUND,`${op}: evidence ${id} not found`);return parseEvidenceRow(rows[0]);}
        catch(e){if(isDomainError(e))throw e;throw this.sqliteFailure(`${op}: SQLite read failed`,e);}
    }
    private broken(id:number,m:string):DomainError{return new DomainError(APP_ERR.EVIDENCE_BROKEN_STORAGE_REFERENCE,`evidence ${id}: ${m}`);}
    private sqliteFailure(c:string,e:unknown):DomainError{return new DomainError(APP_ERR.EVIDENCE_SQLITE_FAILED,`${c}: ${errorText(e)}`);}
}

function sortKey(i:EvidenceReconciliationItem):string{
    switch(i.kind){
        case"VALID_REFERENCE":return`${i.storageRef}\0VALID\0${String(i.evidenceId).padStart(12,"0")}`;
        case"INCOMING_REMOVED":return`${i.ref}\0INCOMING`;
        case"ORPHAN_REMOVED":return`${i.storageRef}\0ORPHAN`;
        case"BROKEN_STORAGE_REFERENCE":return`${i.storageRef}\0BROKEN\0${String(i.evidenceId).padStart(12,"0")}`;
        case"STORAGE_REF_CONFLICT":return`${i.storageRef}\0CONFLICT`;
        case"HASH_MISMATCH":return`${i.storageRef}\0HASH\0${String(i.evidenceId).padStart(12,"0")}`;
        case"ORPHAN_CLEANUP_FAILED":return`${i.ref}\0CLEANUP`;
        case"STORAGE_DIAGNOSTIC_FAILED":return`${i.ref}\0DIAG`;
        case"UNKNOWN_MANAGED_OBJECT":return`${i.ref}\0UNKNOWN`;
    }
}
