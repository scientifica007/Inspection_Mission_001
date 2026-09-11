import { useState } from "react";
import { CapacitorEvidenceStorage } from "../device/capacitor-evidence-storage.ts";
import { gate6cdPhysicalQualificationHarness } from "../gate6c/physical-qualification.ts";
import {
  canonicalGate6CDQualificationJson,
  type Gate6CDQualificationResult,
} from "../gate6c/physical-qualification-model.ts";

export function Gate6CDPhysicalQualificationAugment() {
  const [busy, setBusy] = useState(false);
  const [deepResult, setDeepResult] = useState<Gate6CDQualificationResult | null>(null);
  const [resolveHandle, setResolveHandle] = useState<string | null>(null);
  const [message, setMessage] = useState("Q08 deep proof and local resolve-handle display.");

  async function runDeepRestartProof() {
    setBusy(true);
    setResolveHandle(null);
    try {
      const base = await gate6cdPhysicalQualificationHarness.reconstructOwnerAndReconcile("G6CD-Q08-RESTART-RECONCILIATION");
      const committed = await gate6cdPhysicalQualificationHarness.listCommittedEvidence();
      let retrievalPassCount = 0;
      let resolveVerifiedCount = 0;
      let hashVerifiedCount = 0;
      let metadataVerifiedCount = 0;

      for (const item of committed) {
        const proof = await gate6cdPhysicalQualificationHarness.retrieveAfterRestart(item.evidenceId);
        if (proof.status === "PASS") retrievalPassCount += 1;
        if (proof.resolveResult.status === "RESOLVED") resolveVerifiedCount += 1;
        if (proof.hashVerificationResult === "MATCH") hashVerifiedCount += 1;
        if (proof.details.metadataSurvivedRestart === true) metadataVerifiedCount += 1;
      }

      const allVerified = committed.length > 0
        && retrievalPassCount === committed.length
        && resolveVerifiedCount === committed.length
        && hashVerifiedCount === committed.length
        && metadataVerifiedCount === committed.length;

      const merged: Gate6CDQualificationResult = {
        ...base,
        status: base.status === "PASS" && allVerified ? "PASS" : committed.length === 0 ? "BLOCKED" : "FAIL",
        failureStage: committed.length === 0 ? "restart_retrieval_precondition" : base.failureStage,
        failureCode: committed.length === 0 ? "NO_COMMITTED_EVIDENCE" : base.failureCode,
        details: {
          ...base.details,
          committedEvidenceCount: committed.length,
          retrievalPassCount,
          resolveVerifiedCount,
          hashVerifiedCount,
          metadataVerifiedCount,
          allCommittedEvidenceVerified: allVerified,
        },
      };
      setDeepResult(merged);
      setMessage(`Q08 deep proof: ${merged.status}; verified ${retrievalPassCount}/${committed.length} committed Evidence objects.`);
    } catch (error) {
      setMessage(`Q08 deep proof failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function resolveFirstCommittedHandle() {
    setBusy(true);
    try {
      const committed = await gate6cdPhysicalQualificationHarness.listCommittedEvidence();
      if (committed.length === 0) {
        setResolveHandle(null);
        setMessage("No committed synthetic Evidence exists to resolve.");
        return;
      }
      const selected = committed[committed.length - 1];
      const resolved = await new CapacitorEvidenceStorage().resolve(selected.storageRef);
      setResolveHandle(resolved.handleRef);
      setMessage(`Local resolve handle displayed for Evidence ${selected.evidenceId}. It is intentionally excluded from canonical GitHub JSON.`);
    } catch (error) {
      setResolveHandle(null);
      setMessage(`Resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function copyDeepJson() {
    if (deepResult === null) return;
    try {
      await navigator.clipboard.writeText(canonicalGate6CDQualificationJson(deepResult));
      setMessage("Q08 deep canonical JSON copied without the local resolve URI.");
    } catch (error) {
      setMessage(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <section className="g6cd-card">
      <h2>7. Q08 deep restart proof + local resolve handle</h2>
      <p>
        The deep action reopens the same synthetic database through normal Evidence startup reconciliation and then runs normal
        EvidenceService retrieval/hash/resolve proof for every committed synthetic Evidence row. The raw app-private resolve handle is
        local diagnostic display only and is never included in the canonical JSON intended for GitHub review.
      </p>
      <div className="button-grid">
        <button disabled={busy} onClick={() => void runDeepRestartProof()}>
          Q08 Deep Reopen + Reconcile + Resolve/Hash All
        </button>
        <button disabled={busy} onClick={() => void resolveFirstCommittedHandle()}>
          Show Latest Committed Resolve Handle Locally
        </button>
        <button disabled={busy || deepResult === null} onClick={() => void copyDeepJson()}>
          Copy Q08 Deep Canonical JSON
        </button>
      </div>
      <p className="status">{message}</p>
      <dl className="snapshot">
        <div>
          <dt>Local app-private resolve handle</dt>
          <dd><code>{resolveHandle ?? "not resolved"}</code></dd>
        </div>
      </dl>
      {deepResult !== null && <pre>{canonicalGate6CDQualificationJson(deepResult)}</pre>}
    </section>
  );
}
