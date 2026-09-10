// Gate 6C-B — runtime-neutral Evidence facade. No node:*, Capacitor, Android,
// React, browser storage, Blob/base64, or whole-binary Application-Core API.
import type { SqlAdapter } from "../bootstrap/adapter.ts";
import { APP_ERR, DomainError } from "./errors.ts";
import { EvidenceCreateOrchestrator } from "./evidence-create.ts";
import { EvidenceReconciliationOrchestrator } from "./evidence-reconciliation.ts";
import type {
    CreateEvidenceInput, CreateEvidenceResult, EvidenceHashDiagnostic, EvidenceReconciliationReport,
    EvidenceSourceAcquisition, EvidenceStorage, ReconcileEvidenceOptions, ResolvedEvidenceHandle,
} from "./evidence-contract.ts";

export * from "./evidence-contract.ts";

/** Runtime-only readiness; persistent authority remains SQLite + managed Evidence storage. */
export type EvidenceRuntimeReadiness = "RECONCILIATION_REQUIRED" | "RECONCILING" | "READY";

/** One single-process FIFO boundary used by all consumers in one application Evidence context. */
export class EvidenceMaintenanceQueue {
    private tail:Promise<void>=Promise.resolve();
    async runExclusive<T>(work:()=>Promise<T>):Promise<T>{
        let release!:()=>void;
        const mine=new Promise<void>(r=>{release=r;});
        const previous=this.tail;
        this.tail=previous.then(()=>mine,()=>mine);
        await previous;
        try{return await work();}finally{release();}
    }
}

/**
 * Application-scoped runtime context. The application composition root creates
 * ONE instance and injects it into every supported EvidenceService consumer.
 * There is deliberately no per-service default queue/readiness state.
 *
 * This serializes only in-contract operations in this JavaScript process; it
 * does not protect against external processes or out-of-contract direct DB/fs writes.
 */
export class EvidenceApplicationContext {
    private readonly maintenance=new EvidenceMaintenanceQueue();
    private readinessState:EvidenceRuntimeReadiness="RECONCILIATION_REQUIRED";

    get readiness():EvidenceRuntimeReadiness{return this.readinessState;}

    async runCreate<T>(work:()=>Promise<T>):Promise<T>{
        this.assertReady(); // fail before queue/acquisition when startup reconciliation is incomplete
        return this.maintenance.runExclusive(async()=>{
            this.assertReady(); // reconciliation queued ahead may have failed/degraded readiness
            return work();
        });
    }

    async runReconciliation<T>(work:()=>Promise<T>):Promise<T>{
        return this.maintenance.runExclusive(async()=>{
            this.readinessState="RECONCILING";
            try{
                const result=await work();
                this.readinessState="READY";
                return result;
            }catch(e){
                this.readinessState="RECONCILIATION_REQUIRED";
                throw e;
            }
        });
    }

    async runMaintenanceRead<T>(work:()=>Promise<T>):Promise<T>{
        return this.maintenance.runExclusive(work);
    }

    private assertReady():void{
        if(this.readinessState!=="READY"){
            throw new DomainError(
                APP_ERR.EVIDENCE_RECONCILIATION_REQUIRED,
                `Evidence create unavailable while runtime readiness is ${this.readinessState}; successful reconciliation is required`,
            );
        }
    }
}

export class EvidenceService {
    private readonly createOrchestrator:EvidenceCreateOrchestrator;
    private readonly reconciliation:EvidenceReconciliationOrchestrator;
    private readonly context:EvidenceApplicationContext;

    constructor(
        db:SqlAdapter,
        acquisition:EvidenceSourceAcquisition,
        storage:EvidenceStorage,
        context:EvidenceApplicationContext,
        options:{maxCandidateAttempts?:number}={},
    ){
        if(context===undefined||context===null){
            throw new DomainError(APP_ERR.CONFIG,"EvidenceService requires one application-scoped EvidenceApplicationContext");
        }
        this.context=context;
        this.createOrchestrator=new EvidenceCreateOrchestrator(db,acquisition,storage,options.maxCandidateAttempts);
        this.reconciliation=new EvidenceReconciliationOrchestrator(db,storage);
    }

    createEvidence(input:CreateEvidenceInput):Promise<CreateEvidenceResult>{
        return this.context.runCreate(()=>this.createOrchestrator.createEvidence(input));
    }
    reconcileEvidence(options:ReconcileEvidenceOptions={}):Promise<EvidenceReconciliationReport>{
        return this.context.runReconciliation(()=>this.reconciliation.reconcileEvidence(options));
    }
    verifyEvidenceHash(evidenceId:number):Promise<EvidenceHashDiagnostic>{
        return this.context.runMaintenanceRead(()=>this.reconciliation.verifyEvidenceHash(evidenceId));
    }
    resolveEvidence(evidenceId:number):Promise<ResolvedEvidenceHandle>{
        return this.context.runMaintenanceRead(()=>this.reconciliation.resolveEvidence(evidenceId));
    }
}
