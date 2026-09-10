import type { SqlAdapter, SqlValue } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError, isDomainError } from "./errors.ts";
import {
    OWNER_TABLES, attemptMatchesCommittedRow, canonicalAllocationUsesSameUuid, errorText,
    isCanonicalSha256, isCanonicalStorageRef, isStrictUtcTimestamp, normalizeOptionalText,
    parseEvidenceRow, toEvidenceState,
    type AcquisitionOutcome, type CreateEvidenceInput, type CreateEvidenceResult, type EvidenceAttempt,
    type EvidenceDbRow, type EvidenceObjectAllocation, type EvidenceOwnerKind, type EvidenceSource,
    type EvidenceSourceAcquisition, type EvidenceSourceKind, type EvidenceStorage, type StagedEvidenceObject,
    type StoredEvidenceStat,
} from "./evidence-contract.ts";

const DEFAULT_CANDIDATE_ATTEMPTS = 4;

export class EvidenceCreateOrchestrator {
    private readonly db: SqlAdapter;
    private readonly acquisition: EvidenceSourceAcquisition;
    private readonly storage: EvidenceStorage;
    private readonly maxAttempts: number;
    constructor(
        db: SqlAdapter,
        acquisition: EvidenceSourceAcquisition,
        storage: EvidenceStorage,
        maxCandidateAttempts = DEFAULT_CANDIDATE_ATTEMPTS,
    ) {
        this.db = db;
        this.acquisition = acquisition;
        this.storage = storage;
        if (!Number.isInteger(maxCandidateAttempts) || maxCandidateAttempts < 1) {
            throw new DomainError(APP_ERR.CONFIG, "Evidence: maxCandidateAttempts must be a positive integer");
        }
        this.maxAttempts = maxCandidateAttempts;
    }

    async createEvidence(input: CreateEvidenceInput): Promise<CreateEvidenceResult> {
        const ownerKind=this.requireOwnerKind(input.ownerKind);
        const ownerRef=this.positive(input.ownerRef,"createEvidence: ownerRef");
        const recordedAt=this.utc(input.recordedAt,"createEvidence: recordedAt");
        const recordedBy=this.meaningful(input.recordedBy,"createEvidence: recordedBy");
        const note=normalizeOptionalText(input.note);
        this.requireSourceKind(input.sourceKind);

        await this.assertOwnerExists(ownerKind,ownerRef,"preflight");
        const acquired=await this.acquire(input.sourceKind);
        if (acquired.status==="USER_CANCELLED") return {status:"USER_CANCELLED"};
        if (acquired.status!=="SUCCESS") throw acquisitionError(acquired);
        const source=this.validateSource(acquired.source,input.sourceKind);

        for (let n=0;n<this.maxAttempts;n+=1) {
            let a:EvidenceObjectAllocation;
            try { a=await this.storage.allocate(source); }
            catch(e){ throw this.storageFailure("candidate allocation failed",e); }
            if (!canonicalAllocationUsesSameUuid(a)) {
                throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED,"createEvidence: allocation is not canonical final/staging UUID-v4 identity");
            }

            const before=await this.queryByRef(a.storageRef,"pre-publication preflight");
            if (before.length===1) continue;
            if (before.length>1) throw this.refConflict(`pre-publication found ${before.length} committed rows for ${a.storageRef}`);

            let staged:StagedEvidenceObject;
            try { staged=await this.storage.stage(source,a); this.validateStaged(staged,a); }
            catch(e){ await this.cleanupIncoming(a.stagingRef,e); throw this.stageFailure(e); }

            let exists:boolean;
            try { exists=await this.storage.finalExists(a.storageRef); }
            catch(e){ await this.cleanupIncoming(a.stagingRef,e); throw this.storageFailure("final-path existence check failed",e); }
            if (exists) { await this.cleanupIncoming(a.stagingRef,new Error("final path collision")); continue; }

            try {
                const published=await this.storage.publish(staged);
                if (published.storageRef!==a.storageRef || !isCanonicalStorageRef(published.storageRef))
                    throw new Error("publish returned unexpected storage_ref");
            } catch(e){ await this.cleanupIncoming(a.stagingRef,e); throw this.storageFailure("final publication failed",e); }

            let stat:StoredEvidenceStat;
            try {
                stat=await this.storage.stat(a.storageRef);
                if (stat.storageRef!==a.storageRef || !Number.isInteger(stat.fileSize) || stat.fileSize<0 || stat.fileSize!==staged.fileSize)
                    throw new Error("final stat does not match staged object");
            } catch(e){ await this.cleanupPublished(a.storageRef,e); throw this.storageFailure("final stat failed",e); }

            const attempt:EvidenceAttempt={ ownerKind,ownerRef,storageRef:a.storageRef,contentHash:staged.contentHash,
                fileName:staged.fileName,mimeType:staged.mimeType,fileSize:stat.fileSize,capturedAt:staged.capturedAt??null,
                deviceNote:normalizeOptionalText(staged.deviceNote),note,recordedAt,recordedBy };
            return this.commitAttempt(attempt);
        }
        throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED,`createEvidence: candidate retry limit (${this.maxAttempts}) exhausted`);
    }

    private async commitAttempt(a:EvidenceAttempt):Promise<CreateEvidenceResult>{
        let began=false;
        try {
            await this.db.beginImmediate(); began=true;
            await this.assertOwnerExists(a.ownerKind,a.ownerRef,"transactional owner revalidation");
            const rows=await this.queryByRef(a.storageRef,"transactional recheck");
            if(rows.length>0) throw this.refConflict(`transactional recheck found ${rows.length} committed row(s) for ${a.storageRef}`);
            const res=await this.db.run(
                `INSERT INTO evidence(owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,device_note,note,recorded_at,recorded_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [a.ownerKind,a.ownerRef,a.storageRef,a.contentHash,a.fileName,a.mimeType,a.fileSize,a.capturedAt,a.deviceNote,a.note,a.recordedAt,a.recordedBy] as readonly SqlValue[]);
            if(res.changes!==1 || res.lastInsertRowid===null) throw new DomainError(APP_ERR.STATE_CONFLICT,"createEvidence: INSERT requires changes=1 and lastInsertRowid");
            const id=Number(res.lastInsertRowid);
            try { await this.db.commit(); began=false; }
            catch(e){ began=false; return this.recoverCommit(a,e); }
            return {status:"CREATED",evidence:toEvidenceState(id,a)};
        } catch(e){
            if(began){ try{await this.db.rollback();}catch{/* preserve primary */} }
            if(isDomainError(e)&&e.code===APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT) throw e;
            await this.cleanupPublished(a.storageRef,e);
            if(isDomainError(e)) throw e;
            throw this.sqliteFailure("transaction/INSERT failed",e);
        }
    }

    private async recoverCommit(a:EvidenceAttempt,commitError:unknown):Promise<CreateEvidenceResult>{
        try{await this.db.rollback();}catch{/* durable commit ACK-loss commonly leaves no tx */}
        let rows:EvidenceDbRow[];
        try{rows=await this.freshRows(a.storageRef);}catch(e){throw this.sqliteFailure(`COMMIT uncertain; state not established; final preserved (${errorText(commitError)})`,e);}
        if(rows.length===0){
            try{await this.storage.removeConfirmedOrphan(a.storageRef);}catch(e){throw new DomainError(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED,`createEvidence: zero refs proven but orphan cleanup failed: ${errorText(e)}`);}
            throw this.sqliteFailure("COMMIT uncertain/failed and fresh SQLite proves zero rows",commitError);
        }
        if(rows.length===1){
            if(attemptMatchesCommittedRow(a,rows[0])) return {status:"CREATED",evidence:toEvidenceState(rows[0].evidenceId,a)};
            throw this.refConflict(`uncertain COMMIT found one mismatching row for ${a.storageRef}`);
        }
        throw this.refConflict(`uncertain COMMIT found ${rows.length} rows for ${a.storageRef}; no arbitrary winner`);
    }

    private async freshRows(ref:string):Promise<EvidenceDbRow[]>{
        let began=false;
        try{await this.db.beginImmediate();began=true;const rows=await this.queryByRef(ref,"fresh committed-state read");await this.db.rollback();began=false;return rows;}
        catch(e){if(began){try{await this.db.rollback();}catch{/* preserve */}}throw e;}
    }
    private async cleanupPublished(ref:string,primary:unknown):Promise<void>{
        let rows:EvidenceDbRow[];try{rows=await this.freshRows(ref);}catch{return;}
        if(rows.length!==0)return;
        try{await this.storage.removeConfirmedOrphan(ref);}catch(e){throw new DomainError(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED,`createEvidence: zero refs proven after ${errorText(primary)}, orphan cleanup failed: ${errorText(e)}`);}
    }
    private async cleanupIncoming(ref:string,primary:unknown):Promise<void>{
        try{await this.storage.removeIncoming(ref);}catch(e){throw new DomainError(APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED,`createEvidence: incoming cleanup failed after ${errorText(primary)}: ${errorText(e)}`);}
    }
    private async acquire(k:EvidenceSourceKind):Promise<AcquisitionOutcome>{
        try{if(k==="CAMERA_PHOTO")return await this.acquisition.takeCameraPhoto();if(k==="GALLERY_MEDIA")return await this.acquisition.chooseGalleryMedia();return await this.acquisition.chooseGenericFile();}
        catch(e){if(isDomainError(e))throw e;throw new DomainError(APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE,`createEvidence: acquisition adapter failed: ${errorText(e)}`);}
    }
    private validateSource(s:EvidenceSource,k:EvidenceSourceKind):EvidenceSource{
        this.requireSourceKind(s.kind);if(s.kind!==k)throw new DomainError(APP_ERR.EVIDENCE_UNSUPPORTED_SOURCE,"createEvidence: acquisition source kind mismatch");
        this.meaningful(s.sourceRef,"createEvidence: sourceRef");if(s.capturedAt!==undefined)this.utc(s.capturedAt,"createEvidence: source capturedAt");
        if(s.sizeHint!==undefined&&(!Number.isFinite(s.sizeHint)||s.sizeHint<0))throw new DomainError(APP_ERR.CONFIG,"createEvidence: sizeHint must be non-negative");return s;
    }
    private validateStaged(s:StagedEvidenceObject,a:EvidenceObjectAllocation):void{
        if(s.storageRef!==a.storageRef||s.stagingRef!==a.stagingRef)throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED,"createEvidence: staged identity drift");
        if(!isCanonicalSha256(s.contentHash))throw new DomainError(APP_ERR.EVIDENCE_HASH_FAILED,"createEvidence: content_hash must be canonical SHA-256");
        this.meaningful(s.fileName,"createEvidence: fileName");this.meaningful(s.mimeType,"createEvidence: mimeType");
        if(!Number.isInteger(s.fileSize)||s.fileSize<0)throw new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED,"createEvidence: fileSize must be non-negative integer");
        if(s.capturedAt!==undefined&&s.capturedAt!==null)this.utc(s.capturedAt,"createEvidence: capturedAt");
    }
    private async assertOwnerExists(k:EvidenceOwnerKind,id:number,ctx:string):Promise<void>{
        const t=OWNER_TABLES[k];try{const rows=await this.db.query(`SELECT ${t.pk} AS owner_id FROM ${t.table} WHERE ${t.pk} = ?`,[id]);
            if(rows.length!==1)throw new DomainError(APP_ERR.EVIDENCE_OWNER_NOT_FOUND,`createEvidence ${ctx}: ${k} owner ${id} not found`);
        }catch(e){if(isDomainError(e))throw e;throw this.sqliteFailure(`${ctx} owner lookup failed`,e);}
    }
    private async queryByRef(ref:string,ctx:string):Promise<EvidenceDbRow[]>{
        try{return (await this.db.query(`SELECT evidence_id,owner_kind,owner_ref,storage_ref,content_hash,file_name,mime_type,file_size,captured_at,device_note,note,recorded_at,recorded_by FROM evidence WHERE storage_ref = ? ORDER BY evidence_id`,[ref])).map(parseEvidenceRow);}
        catch(e){if(isDomainError(e))throw e;throw this.sqliteFailure(`${ctx} storage_ref lookup failed`,e);}
    }
    private requireOwnerKind(k:EvidenceOwnerKind):EvidenceOwnerKind{if(!Object.prototype.hasOwnProperty.call(OWNER_TABLES,k))throw new DomainError(APP_ERR.EVIDENCE_OWNER_INVALID,`createEvidence: invalid owner_kind '${String(k)}'`);return k;}
    private requireSourceKind(k:EvidenceSourceKind):EvidenceSourceKind{if(k!=="CAMERA_PHOTO"&&k!=="GALLERY_MEDIA"&&k!=="GENERIC_FILE")throw new DomainError(APP_ERR.EVIDENCE_UNSUPPORTED_SOURCE,`createEvidence: unsupported source '${String(k)}'`);return k;}
    private positive(v:number,w:string):number{if(!Number.isInteger(v)||v<1)throw new DomainError(APP_ERR.CONFIG,`${w} must be positive integer`);return v;}
    private meaningful(v:string,w:string):string{if(typeof v!=="string"||v.trim().length===0)throw new DomainError(APP_ERR.CONFIG,`${w} must be meaningful`);return v.trim();}
    private utc(v:string,w:string):string{const t=this.meaningful(v,w);if(!isStrictUtcTimestamp(t))throw new DomainError(APP_ERR.CONFIG,`${w} must be strict ISO-8601 UTC`);return t;}
    private stageFailure(e:unknown):DomainError{if(isDomainError(e)&&[APP_ERR.EVIDENCE_HASH_FAILED,APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE,APP_ERR.EVIDENCE_UNSUPPORTED_SOURCE,APP_ERR.EVIDENCE_PERMISSION_DENIED,APP_ERR.EVIDENCE_ORPHAN_CLEANUP_FAILED].includes(e.code as never))return e;return this.storageFailure("staging failed",e);}
    private storageFailure(c:string,e:unknown):DomainError{if(isDomainError(e))return e;return new DomainError(APP_ERR.EVIDENCE_STORAGE_WRITE_FAILED,`createEvidence ${c}: ${errorText(e)}`);}
    private sqliteFailure(c:string,e:unknown):DomainError{if(isDomainError(e)&&e.code===APP_ERR.EVIDENCE_SQLITE_FAILED)return e;return new DomainError(APP_ERR.EVIDENCE_SQLITE_FAILED,`createEvidence ${c}: ${errorText(e)}`);}
    private refConflict(m:string):DomainError{return new DomainError(APP_ERR.EVIDENCE_STORAGE_REF_CONFLICT,`createEvidence: ${m}`);}
}

function acquisitionError(o:Exclude<AcquisitionOutcome,{status:"SUCCESS"}|{status:"USER_CANCELLED"}>):DomainError{
    const d=o.detail?.trim();const s=d?`: ${d}`:"";
    if(o.status==="PERMISSION_DENIED")return new DomainError(APP_ERR.EVIDENCE_PERMISSION_DENIED,`createEvidence: permission denied${s}`);
    if(o.status==="SOURCE_UNAVAILABLE")return new DomainError(APP_ERR.EVIDENCE_SOURCE_UNAVAILABLE,`createEvidence: source unavailable${s}`);
    return new DomainError(APP_ERR.EVIDENCE_UNSUPPORTED_SOURCE,`createEvidence: unsupported source${s}`);
}
