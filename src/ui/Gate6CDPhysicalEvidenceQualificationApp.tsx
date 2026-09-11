import { useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import type { EvidenceSourceKind } from "../application/evidence-contract.ts";
import {
  gate6cdPhysicalQualificationHarness,
  type Gate6CDCommittedEvidenceSummary,
  type Gate6CDHarnessSnapshot,
} from "../gate6c/physical-qualification.ts";
import {
  canonicalGate6CDQualificationJson,
  type Gate6CDQualificationResult,
} from "../gate6c/physical-qualification-model.ts";

const EMPTY_SNAPSHOT: Gate6CDHarnessSnapshot = {
  testedGitSha: "UNAVAILABLE",
  database: "inspection_gate6c_d_physical_qualification_v1",
  ownerVisitId: null,
  runtimeReadiness: "NOT_OPEN",
  pendingSource: null,
  restoredPending: null,
};

export function Gate6CDPhysicalEvidenceQualificationApp() {
  const [snapshot, setSnapshot] = useState<Gate6CDHarnessSnapshot>(EMPTY_SNAPSHOT);
  const [evidence, setEvidence] = useState<Gate6CDCommittedEvidenceSummary[]>([]);
  const [result, setResult] = useState<Gate6CDQualificationResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("Initialize the synthetic qualification database before Evidence operations.");
  const [evidenceIdText, setEvidenceIdText] = useState("");
  const nativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  const resultText = useMemo(() => result === null ? "{}" : canonicalGate6CDQualificationJson(result), [result]);

  async function refresh() {
    setSnapshot(gate6cdPhysicalQualificationHarness.getSnapshot());
    setEvidence(await gate6cdPhysicalQualificationHarness.listCommittedEvidence().catch(() => []));
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function invoke(label: string, work: () => Promise<Gate6CDQualificationResult>) {
    setBusy(label);
    setMessage("");
    try {
      const out = await work();
      setResult(out);
      setMessage(`${label}: ${out.status}${out.failureCode ? ` / ${out.failureCode}` : ""}`);
    } catch (error) {
      setMessage(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await refresh();
      setBusy(null);
    }
  }

  function requireEvidenceId(): number | null {
    const value = Number(evidenceIdText);
    if (!Number.isInteger(value) || value < 1) {
      setMessage("Enter a positive committed Evidence ID first.");
      return null;
    }
    return value;
  }

  async function copyJson() {
    if (result === null) return;
    try {
      await navigator.clipboard.writeText(resultText);
      setMessage("Canonical qualification JSON copied. It intentionally contains no raw source URI or device serial.");
    } catch (error) {
      setMessage(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function pendingAcquire(label: string, scenarioId: Parameters<typeof gate6cdPhysicalQualificationHarness.acquireOnly>[0], kind: EvidenceSourceKind) {
    return invoke(label, () => gate6cdPhysicalQualificationHarness.acquireOnly(scenarioId, kind));
  }

  return (
    <main className="g6cd-shell">
      <header className="g6cd-header">
        <p className="eyebrow">INSPECTION_MISSION_001 · SYNTHETIC QUALIFICATION DATA ONLY</p>
        <h1>GATE 6C-D PHYSICAL EVIDENCE QUALIFICATION — NOT FIELD UI</h1>
        <p>
          Diagnostic surface for owner-executed physical Android qualification. Successful commits use the production Evidence acquisition,
          EvidenceService, durable EvidenceStorage, native adapter, and SQLite path. This APK is not Gate 6D and is not field-usable UI.
        </p>
        <div className={`runtime ${nativeAndroid ? "ok" : "warn"}`}>
          Runtime: {Capacitor.getPlatform()} · native={String(Capacitor.isNativePlatform())} · Android={String(nativeAndroid)}
        </div>
        <dl className="snapshot">
          <div><dt>Tested Git SHA</dt><dd><code>{snapshot.testedGitSha}</code></dd></div>
          <div><dt>Synthetic Visit owner</dt><dd>{snapshot.ownerVisitId ?? "not reconstructed"}</dd></div>
          <div><dt>Evidence readiness</dt><dd>{snapshot.runtimeReadiness}</dd></div>
          <div><dt>Volatile source</dt><dd>{snapshot.pendingSource ? `${snapshot.pendingSource.pendingId} / ${snapshot.pendingSource.sourceKind}` : "none"}</dd></div>
          <div><dt>Restored Camera source</dt><dd>{snapshot.restoredPending ? `${snapshot.restoredPending.pendingId} / ${snapshot.restoredPending.methodName} / ${snapshot.restoredPending.sourceKind}` : "none"}</dd></div>
        </dl>
      </header>

      <section className="g6cd-card">
        <h2>1. Synthetic runtime</h2>
        <p>Reset is destructive only to this diagnostic package's synthetic qualification state. Never install this APK as production field software.</p>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Initialize/reset synthetic owner", () => gate6cdPhysicalQualificationHarness.initializeReset())}>
            Initialize / Reset Synthetic DB
          </button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q08 restart reconciliation", () => gate6cdPhysicalQualificationHarness.reconstructOwnerAndReconcile("G6CD-Q08-RESTART-RECONCILIATION"))}>
            Q08 Reopen + Reconcile
          </button>
        </div>
      </section>

      <section className="g6cd-card">
        <h2>2. Production acquisition → EvidenceService commit</h2>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q01 Camera commit", () => gate6cdPhysicalQualificationHarness.commitProductionSource("G6CD-Q01-CAMERA-COMMIT", "CAMERA_PHOTO"))}>Q01 Camera Commit</button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q02 Gallery commit", () => gate6cdPhysicalQualificationHarness.commitProductionSource("G6CD-Q02-GALLERY-COMMIT", "GALLERY_MEDIA"))}>Q02 Gallery Commit</button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q03 Generic file commit", () => gate6cdPhysicalQualificationHarness.commitProductionSource("G6CD-Q03-GENERIC-FILE-COMMIT", "GENERIC_FILE"))}>Q03 Generic File Commit</button>
        </div>
      </section>

      <section className="g6cd-card">
        <h2>3. Real platform negative acquisition</h2>
        <p>These actions do not commit a successful source. Exercise real platform Cancel or Camera permission denial and verify zero Evidence-row delta.</p>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q04 real cancel", () => gate6cdPhysicalQualificationHarness.runAcquisitionExpectation("G6CD-Q04-CANCEL", "CAMERA_PHOTO", "USER_CANCELLED"))}>Q04 Camera → Cancel</button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q05 permission denied", () => gate6cdPhysicalQualificationHarness.runAcquisitionExpectation("G6CD-Q05-PERMISSION-DENIED", "CAMERA_PHOTO", "PERMISSION_DENIED"))}>Q05 Camera → Deny Permission</button>
        </div>
      </section>

      <section className="g6cd-card">
        <h2>4. Acquisition-only volatile source</h2>
        <p>No pending source is written to SQLite or another persistent authority. Use the documented external step before committing Q06/Q12.</p>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null || snapshot.pendingSource !== null} onClick={() => pendingAcquire("Q06 acquire source only", "G6CD-Q06-SOURCE-LOSS", "GENERIC_FILE")}>Q06 Acquire Generic File Only</button>
          <button disabled={!nativeAndroid || busy !== null || snapshot.pendingSource !== null} onClick={() => pendingAcquire("Q09 acquire orphan source", "G6CD-Q09-ORPHAN-CLEANUP", "GENERIC_FILE")}>Q09 Acquire Orphan Source</button>
          <button disabled={!nativeAndroid || busy !== null || snapshot.pendingSource !== null} onClick={() => pendingAcquire("Q11 acquire large file", "G6CD-Q11-LARGE-FILE", "GENERIC_FILE")}>Q11 Acquire Large File</button>
          <button disabled={!nativeAndroid || busy !== null || snapshot.pendingSource !== null} onClick={() => pendingAcquire("Q12 acquire write-failure source", "G6CD-Q12-WRITE-FAILURE", "GENERIC_FILE")}>Q12 Acquire Write-Failure Source</button>
          <button disabled={!nativeAndroid || busy !== null || snapshot.pendingSource !== null} onClick={() => pendingAcquire("Q07 start Camera process-death protocol", "G6CD-Q07-RESTORED-CAMERA", "CAMERA_PHOTO")}>Q07 Start Camera — Kill App While Camera Active</button>
        </div>
        <div className="button-grid secondary">
          <button disabled={busy !== null || snapshot.pendingSource === null} onClick={() => invoke("Q06 commit pending source", () => gate6cdPhysicalQualificationHarness.commitPendingScenario("G6CD-Q06-SOURCE-LOSS"))}>Commit Pending as Q06</button>
          <button disabled={busy !== null || snapshot.pendingSource === null} onClick={() => invoke("Q09 publish zero-row orphan", () => gate6cdPhysicalQualificationHarness.publishPendingAsZeroRowOrphan())}>Publish Pending as Q09 Zero-Row Orphan</button>
          <button disabled={busy !== null || snapshot.pendingSource === null} onClick={() => invoke("Q11 commit large file", () => gate6cdPhysicalQualificationHarness.commitPendingScenario("G6CD-Q11-LARGE-FILE"))}>Commit Pending as Q11</button>
          <button disabled={busy !== null || snapshot.pendingSource === null} onClick={() => invoke("Q12 commit under controlled write failure", () => gate6cdPhysicalQualificationHarness.commitPendingScenario("G6CD-Q12-WRITE-FAILURE"))}>Commit Pending as Q12</button>
          <button className="danger" disabled={busy !== null || snapshot.pendingSource === null} onClick={() => { gate6cdPhysicalQualificationHarness.discardPendingSource(); setMessage("Volatile pending source discarded; no SQLite/sidecar source authority existed."); void refresh(); }}>Discard Volatile Source</button>
        </div>
      </section>

      <section className="g6cd-card restored">
        <h2>5. Genuine appRestoredResult observation</h2>
        <p>
          The listener is registered before React renders. The UI can only display/adopt/discard what the real Capacitor App restored-result coordinator received;
          it does not synthesize <code>acceptRestoredEvent()</code>.
        </p>
        <p className="pending-line">
          {snapshot.restoredPending
            ? `PENDING: ${snapshot.restoredPending.pendingId} / ${snapshot.restoredPending.methodName} / ${snapshot.restoredPending.sourceKind}`
            : "No pending restored Camera source."}
        </p>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null || snapshot.restoredPending === null || snapshot.ownerVisitId === null || snapshot.runtimeReadiness !== "READY"} onClick={() => invoke("Q07 adopt restored Camera", () => gate6cdPhysicalQualificationHarness.adoptRestoredCamera())}>Q07 Explicit Adopt to Synthetic Visit</button>
          <button className="danger" disabled={busy !== null || snapshot.restoredPending === null} onClick={() => { const ok = gate6cdPhysicalQualificationHarness.discardRestoredCamera(); setMessage(ok ? "Restored Camera source discarded." : "Restored source changed before discard."); void refresh(); }}>Discard Restored Source</button>
        </div>
      </section>

      <section className="g6cd-card">
        <h2>6. Restart, orphan, missing-file, retrieval diagnostics</h2>
        <div className="button-grid">
          <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Q09 restart reconciliation orphan cleanup", () => gate6cdPhysicalQualificationHarness.reconstructOwnerAndReconcile("G6CD-Q09-ORPHAN-CLEANUP"))}>Q09 Reopen + Normal Orphan Cleanup</button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => { const id = requireEvidenceId(); if (id !== null) void invoke("Q10 missing-file diagnosis", () => gate6cdPhysicalQualificationHarness.diagnoseMissingFile(id)); }}>Q10 Diagnose Missing File</button>
          <button disabled={!nativeAndroid || busy !== null} onClick={() => { const id = requireEvidenceId(); if (id !== null) void invoke("Q13 retrieval after restart", () => gate6cdPhysicalQualificationHarness.retrieveAfterRestart(id)); }}>Q13 Retrieve After Restart</button>
        </div>
        <label className="evidence-id-field">
          Evidence ID for Q10/Q13
          <input inputMode="numeric" value={evidenceIdText} onChange={(event) => setEvidenceIdText(event.target.value)} placeholder="e.g. 1" />
        </label>
      </section>

      <section className="g6cd-card">
        <h2>Committed synthetic Evidence metadata</h2>
        {evidence.length === 0 ? <p>No committed Evidence rows in the qualification DB.</p> : (
          <div className="table-wrap"><table><thead><tr><th>ID</th><th>storage_ref</th><th>bytes</th><th>SHA-256</th></tr></thead><tbody>
            {evidence.map((item) => <tr key={item.evidenceId}><td>{item.evidenceId}</td><td><code>{item.storageRef}</code></td><td>{item.fileSize ?? "null"}</td><td><code>{item.contentHash ?? "null"}</code></td></tr>)}
          </tbody></table></div>
        )}
      </section>

      <section className="g6cd-card output">
        <h2>Machine-readable qualification evidence</h2>
        <p className="status">{busy ? `${busy}…` : message}</p>
        <button disabled={result === null || busy !== null} onClick={copyJson}>Copy Canonical JSON</button>
        <pre>{resultText}</pre>
      </section>

      <footer className="g6cd-footer">
        Physical-device PASS is not produced by CI/emulators. Follow the versioned Gate 6C-D physical protocol and preserve external ADB/device evidence for independent review.
      </footer>
    </main>
  );
}
