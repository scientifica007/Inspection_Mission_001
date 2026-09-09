import { useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import {
  resetSyntheticProofDatabase,
  runAdapterQualification,
  runApplicationCoreProof,
  runRestartPhaseA,
  runRestartPhaseB,
} from "../gate6b/proof-runner.ts";
import { canonicalProofJson } from "../gate6b/hash.ts";
import type { Gate6BProofOutput } from "../gate6b/proof-types.ts";

export function Gate6BProofApp() {
  const [result, setResult] = useState<Gate6BProofOutput | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const nativeAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  const resultText = useMemo(() => (result ? canonicalProofJson(result) : ""), [result]);

  async function invoke(label: string, fn: () => Promise<Gate6BProofOutput>) {
    setBusy(label);
    setMessage("");
    try {
      const out = await fn();
      setResult(out);
      setMessage(`${label}: ${out.overallResult}`);
    } catch (error) {
      setMessage(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("Reset proof databases");
    setMessage("");
    try {
      await resetSyntheticProofDatabase();
      setResult(null);
      setMessage("Synthetic proof databases deleted. No operational data was touched.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!resultText) return;
    await navigator.clipboard.writeText(resultText);
    setMessage("Proof JSON copied. External preservation is not application authority.");
  }

  return (
    <main className="proof-shell">
      <header className="proof-header">
        <p className="eyebrow">INSPECTION_MISSION_001</p>
        <h1>GATE 6B DEVICE PROOF — NOT FIELD UI</h1>
        <p>
          Diagnostic shell for the provisional native SQLite adapter and the existing runtime-neutral Application Core.
          Gate 6B remains open until physical-device kill/restart evidence is executed and independently reviewed.
        </p>
        <div className={`runtime ${nativeAndroid ? "ok" : "warn"}`}>
          Runtime: {Capacitor.getPlatform()} {nativeAndroid ? "— native Android proof enabled" : "— proof actions require native Android"}
        </div>
      </header>

      <section className="controls" aria-label="Gate 6B proof controls">
        <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Adapter qualification", runAdapterQualification)}>
          Run Adapter Qualification
        </button>
        <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Application-Core proof", runApplicationCoreProof)}>
          Run Application-Core Proof
        </button>
        <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Restart Phase A", runRestartPhaseA)}>
          Run Restart Phase A
        </button>
        <button disabled={!nativeAndroid || busy !== null} onClick={() => invoke("Restart Phase B", runRestartPhaseB)}>
          Run Restart Phase B
        </button>
        <button className="danger" disabled={!nativeAndroid || busy !== null} onClick={reset}>
          Reset Synthetic Proof DB
        </button>
        <button disabled={result === null || busy !== null} onClick={copy}>
          Copy Proof JSON
        </button>
      </section>

      <section className="protocol">
        <h2>Physical restart protocol</h2>
        <ol>
          <li>Run Restart Phase A and preserve the displayed JSON externally.</li>
          <li>After Phase A reports completion, force-stop the app process. Preferred: <code>adb shell am force-stop com.scientifica.inspection.gate6bproof</code>.</li>
          <li>Do not uninstall the app and do not reset/delete the database.</li>
          <li>Launch the app again and run Restart Phase B. Phase B discovers the Visit from SQLite markers; it does not use prior React/process state.</li>
        </ol>
      </section>

      <section className="output">
        <h2>Machine-readable proof</h2>
        <p className="status">{busy ? `${busy}…` : message || "No proof run yet."}</p>
        <pre>{resultText || "{}"}</pre>
      </section>
    </main>
  );
}
