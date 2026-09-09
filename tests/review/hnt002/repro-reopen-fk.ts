// HNT-002 review-only reproducer (NOT part of the target candidate).
//
// Hypothesis tested: "PRAGMA foreign_keys ON for every authoritative
// qualification connection" (HNT-001 item 7) is verified on the reopened
// connection as well as on primary/peer.
//
// Simulation: a candidate whose reopen() yields a connection with
// foreign_keys OFF. Cases 9 and 10 use only that connection for reads, so if
// the reusable contract never checks the pragma there, the suite still passes.
//
// Result observed: the suite passes 10/10 (see run output), i.e. the
// reopened connection's foreign-key enforcement is not verified by the
// reusable contract. (The reference runner itself is not affected: its
// openManaged() always sets PRAGMA foreign_keys = ON for every connection.)

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeSqliteAdapter } from "../../../dev/node-sqlite-adapter.ts";
import { parseArtifact } from "../../../src/bootstrap/artifact.ts";
import type {
    QualificationConnection,
    QualificationDatabase,
    SqlAdapterQualificationFactory,
} from "../../support/sqladapter-qualification.ts";
import { qualifySqlAdapter } from "../../support/sqladapter-qualification.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const BOOTSTRAP = parseArtifact(readFileSync(join(ROOT, "bootstrap", "v1", "checklist-v1.json"), "utf8"));

interface ManagedConnection extends QualificationConnection {
    readonly raw: DatabaseSync;
}

function openManaged(path: string, enableForeignKeys: boolean): ManagedConnection {
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA foreign_keys = ${enableForeignKeys ? "ON" : "OFF"}`);
    raw.exec("PRAGMA busy_timeout = 0");
    const adapter = new NodeSqliteAdapter(raw);
    let closed = false;
    return {
        raw,
        adapter,
        close(): void {
            if (closed) return;
            closed = true;
            raw.close();
        },
    };
}

const factory: SqlAdapterQualificationFactory = {
    candidateName: "ReopenWithFkOffAdapter (reopened connection disables foreign_keys)",
    async createFresh(schemaSql: string): Promise<QualificationDatabase> {
        const dir = mkdtempSync(join(tmpdir(), "hnt002-repro-reopen-"));
        const path = join(dir, "qualification.sqlite");
        const primary = openManaged(path, true);
        try {
            primary.raw.exec(schemaSql);
        } catch (error) {
            primary.close();
            rmSync(dir, { recursive: true, force: true });
            throw error;
        }
        const opened = new Set<ManagedConnection>([primary]);
        return {
            primary,
            async openPeer(): Promise<QualificationConnection> {
                const connection = openManaged(path, true);
                opened.add(connection);
                return connection;
            },
            async reopen(): Promise<QualificationConnection> {
                // Broken candidate behavior: reopened connection has FK enforcement off.
                const connection = openManaged(path, false);
                opened.add(connection);
                return connection;
            },
            cleanup(): void {
                for (const connection of opened) {
                    try {
                        connection.close();
                    } catch {
                        // best-effort
                    }
                }
                rmSync(dir, { recursive: true, force: true });
            },
        };
    },
};

const report = await qualifySqlAdapter(factory, { schemaSql: SCHEMA_SQL, bootstrapArtifact: BOOTSTRAP });

console.log(`\n[repro-reopen-fk] suite result: ${report.passed} passed, ${report.failed} failed`);
console.log(report.passed === 10 && report.failed === 0
    ? "[repro-reopen-fk] DEMONSTRATED: reopened connection with foreign_keys OFF still passes 10/10 — the reusable contract never checks PRAGMA foreign_keys on reopen() connections"
    : "[repro-reopen-fk] unexpected: suite did not pass as hypothesized");
