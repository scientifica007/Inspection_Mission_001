// ============================================================================
// SqlAdapter Qualification Harness v1 — candidate-specific HOST runner /
// lifecycle factory (Part B) + suite entry point.
//
// Experiment HNT-001. The reference HOST candidate under test is the current
// repository's NodeSqliteAdapter (dev/node-sqlite-adapter.ts, node:sqlite).
//
// This Part-B file is the ONLY place node:* may be imported (reusability rule
// A/B): it provisions the exact adopted schema (docs/schema/schema.sql) into a
// real temporary FILE-BACKED SQLite database, opens real secondary connections
// to that SAME file, sets PRAGMA foreign_keys = ON on EVERY connection it
// opens, closes connections on demand for durable close/reopen tests, and
// removes all temporary files on dispose. It never introduces a permanent DB
// file into the repository.
//
// The reusable qualification logic lives in qualification-contract.ts (Part A)
// and is runtime-neutral. A future Gate-6B Android/native candidate reuses
// Part A unchanged and implements its own HostQualificationSeam (Part B) over
// its own driver — this file is then simply replaced by that candidate's
// runner.
//
// SCOPE: HOST qualification only. This run does NOT prove Android app-private
// storage, Capacitor/WebView lifecycle, physical process kill, device reboot,
// camera/filesystem behaviour, Android-plugin-specific transactions, or
// physical-device currentVisitState restart reconstruction. Those remain
// Gate-6B / device-work items.
//
// Run (repository root; Node.js >= 22 is the adopted development/test host):
//   Node 22.x:   node --experimental-strip-types tests/sqladapter-qualification/node-host-runner.ts
//   Node 24.x:   node tests/sqladapter-qualification/node-host-runner.ts
// Exit: 0 on success, 1 when any assertion fails.
// ============================================================================

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeSqliteAdapter } from "../../dev/node-sqlite-adapter.ts";
import { parseArtifact } from "../../src/bootstrap/artifact.ts";
import type { QualifiedConnection, QualificationEnvironment } from "./qualification-contract.ts";
import { runHostQualification } from "./qualification-contract.ts";
import type { HostQualificationSeam } from "./qualification-contract.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const ARTIFACT_TEXT = readFileSync(join(ROOT, "bootstrap", "v1", "checklist-v1.json"), "utf8");

// ---------------------------------------------------------------------------
// Reference host lifecycle factory: real temporary FILE-BACKED durable DB.
// ---------------------------------------------------------------------------

class FileBackedNodeEnvironment implements QualificationEnvironment {
    readonly label: string;
    private readonly dirPath: string;
    private readonly filePath: string;
    private readonly connections = new Set<DatabaseSync>();
    private disposed = false;

    constructor(label: string, dirPath: string, filePath: string) {
        this.label = label;
        this.dirPath = dirPath;
        this.filePath = filePath;
    }

    async openConnection(): Promise<QualifiedConnection> {
        if (this.disposed) throw new Error(`${this.label}: environment already disposed`);
        const db = new DatabaseSync(this.filePath);
        // Explicit per-connection SQLite foreign-key enforcement. Raw SQLite
        // defaults foreign_keys to OFF; every authoritative connection used by
        // the qualification environment must run with it ON regardless of the
        // driver's default. (node:sqlite happens to default it ON; we never
        // rely on that driver-specific default.)
        db.exec("PRAGMA foreign_keys = ON;");
        this.connections.add(db);
        const adapter = new NodeSqliteAdapter(db);
        return {
            adapter,
            close: async () => {
                if (!this.connections.delete(db)) return; // already closed
                try {
                    db.close();
                } catch {
                    // already closed by a previous close — nothing to do
                }
            },
        };
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const db of [...this.connections]) {
            try {
                db.close();
            } catch {
                // best-effort
            }
        }
        this.connections.clear();
        try {
            rmSync(this.dirPath, { recursive: true, force: true });
        } catch {
            // best-effort cleanup of the temporary directory
        }
    }
}

let environmentSeq = 0;

const seam: HostQualificationSeam = {
    candidateLabel: "node:sqlite DatabaseSync via dev/NodeSqliteAdapter (reference HOST candidate)",
    async createFreshEnvironment(): Promise<QualificationEnvironment> {
        const dirPath = mkdtempSync(join(tmpdir(), "sqladapter-qual-"));
        const filePath = join(dirPath, "durable.sqlite");
        // Provision the EXACT adopted schema into a clean durable file. The
        // one-shot provisioning connection runs with synchronous=OFF: schema
        // DDL is ~84 autocommitted statements, and SQLite's default
        // synchronous=FULL would fsync each one — a needless fsync storm for
        // fixture setup on slow/loaded disks. synchronous is connection-local,
        // so every connection that the qualification TESTS use still runs with
        // the SQLite default (real transaction/rollback/isolation semantics).
        const provision = new DatabaseSync(filePath);
        try {
            provision.exec("PRAGMA synchronous = OFF;");
            provision.exec(SCHEMA_SQL);
        } finally {
            provision.close();
        }
        environmentSeq += 1;
        return new FileBackedNodeEnvironment(`node-host-env-${environmentSeq}`, dirPath, filePath);
    },
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printHeader(summary: { candidateLabel: string }): void {
    console.log("SqlAdapter Qualification Harness v1 (HNT-001)");
    console.log("Candidate under test : " + summary.candidateLabel);
    console.log("Scope                : HOST qualification only");
    console.log("Non-claims           : proves nothing about Android app-private storage, Capacitor/WebView");
    console.log("                       lifecycle, physical process kill, device reboot, camera/filesystem,");
    console.log("                       Android-plugin-specific transactions, or physical-device");
    console.log("                       currentVisitState restart reconstruction (Gate-6B / device work).");
}

function printFooter(totalPassed: number, totalFailed: number): void {
    console.log(`\nTOTAL: ${totalPassed} passed, ${totalFailed} failed`);
    if (totalFailed > 0) {
        console.log("RESULT: FAILURE");
        process.exitCode = 1;
    } else {
        console.log("RESULT: SUCCESS (0 failures) — HOST QUALIFICATION PASSED");
        process.exitCode = 0;
    }
}

const artifact = parseArtifact(ARTIFACT_TEXT);
const summary = await runHostQualification(seam, artifact);

printHeader(summary);
for (const outcome of summary.outcomes) {
    const status = outcome.failed.length === 0 ? "PASS" : "FAIL";
    console.log(
        `[${status}] ${outcome.id} ${outcome.title} — ${outcome.passed} passed` +
            (outcome.failed.length > 0 ? `, ${outcome.failed.length} failed` : ""),
    );
    for (const failure of outcome.failed) {
        console.log(`      FAIL ${outcome.id}: ${failure}`);
    }
}
printFooter(summary.totalPassed, summary.totalFailed);
