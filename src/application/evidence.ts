// Gate 6C-B — runtime-neutral Evidence facade. No node:*, Capacitor, Android,
// React, browser storage, Blob/base64, or whole-binary Application-Core API.
import type { SqlAdapter } from "../bootstrap/adapter.ts";
import { EvidenceCreateOrchestrator } from "./evidence-create.ts";
import { EvidenceReconciliationOrchestrator } from "./evidence-reconciliation.ts";
import type {
    CreateEvidenceInput, CreateEvidenceResult, EvidenceHashDiagnostic, EvidenceReconciliationReport,
    EvidenceSourceAcquisition, EvidenceStorage, ReconcileEvidenceOptions, ResolvedEvidenceHandle,
} from "./evidence-contract.ts";

export * from "./evidence-contract.ts";

/** One application-level single-process Evidence maintenance/write boundary. */
export class EvidenceMaintenanceQueue {
    private tail:Promise<void>=Promise.resolve();
    async runExclusive<T>(work:()=>Promise<T>):Promise<T>{
        let release!:()=>void;const mine=new Promise<void>(r=>{release=r;});const previous=this.tail;
        this.tail=previous.then(()=>mine,()=>mine);await previous;try{return await work();}finally{release();}
    }
}

export class EvidenceService {
    private readonly createOrchestrator:EvidenceCreateOrchestrator;
    private readonly reconciliation:EvidenceReconciliationOrchestrator;
    private readonly maintenance:EvidenceMaintenanceQueue;
    constructor(db:SqlAdapter,acquisition:EvidenceSourceAcquisition,storage:EvidenceStorage,options:{maintenance?:EvidenceMaintenanceQueue;maxCandidateAttempts?:number}={}){
        this.maintenance=options.maintenance??new EvidenceMaintenanceQueue();
        this.createOrchestrator=new EvidenceCreateOrchestrator(db,acquisition,storage,options.maxCandidateAttempts);
        this.reconciliation=new EvidenceReconciliationOrchestrator(db,storage);
    }
    createEvidence(input:CreateEvidenceInput):Promise<CreateEvidenceResult>{return this.maintenance.runExclusive(()=>this.createOrchestrator.createEvidence(input));}
    reconcileEvidence(options:ReconcileEvidenceOptions={}):Promise<EvidenceReconciliationReport>{return this.maintenance.runExclusive(()=>this.reconciliation.reconcileEvidence(options));}
    verifyEvidenceHash(evidenceId:number):Promise<EvidenceHashDiagnostic>{return this.maintenance.runExclusive(()=>this.reconciliation.verifyEvidenceHash(evidenceId));}
    resolveEvidence(evidenceId:number):Promise<ResolvedEvidenceHandle>{return this.maintenance.runExclusive(()=>this.reconciliation.resolveEvidence(evidenceId));}
}
