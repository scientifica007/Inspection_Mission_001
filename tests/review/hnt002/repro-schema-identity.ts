// HNT-002 review-only reproducer (NOT part of the target candidate).
//
// Hypothesis tested: the qualification case "exact adopted schema is present"
// proves materially stronger identity than "15 physical tables exist".
//
// Simulation: a candidate adapter whose DDL provisioning silently ignores
// every CREATE TRIGGER / CREATE VIEW / CREATE INDEX statement (a materially
// broken adapter: it drops 44 enforcement triggers, the derived-outcome view
// and all 24 explicit indexes). The qualification suite should FAIL such a
// candidate under HNT-001 item 1 ("exact adopted schema ... is present").
//
// Result observed: the suite passes 10/10 (see run output), so the case
// verifies only table cardinality, not exact adopted-schema identity.

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

/** Simulated broken DDL executor: keeps CREATE TABLE, drops triggers/views/indexes. */
function stripNonTableDdl(sql: string): string {
    const lines = sql.split("\n");
    const out: string[] = [];
    let skipTriggerUntilEnd = false;
    let skipUntilSemicolon = false;
    for (const line of lines) {
        const t = line.trim();
        if (skipTriggerUntilEnd) {
            if (t === "END;") skipTriggerUntilEnd = false;
            continue;
        }
        if (skipUntilSemicolon) {
            if (t.endsWith(";")) skipUntilSemicolon = false;
            continue;
        }
        if (/^CREATE\s+TRIGGER\b/i.test(t)) {
            if (!t.endsWith("END;")) skipTriggerUntilEnd = true;
            continue;
        }
        if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(t) || /^CREATE\s+VIEW\b/i.test(t)) {
            if (!t.endsWith(";")) skipUntilSemicolon = true;
            continue;
        }
        out.push(line);
    }
    return out.join("\n");
}

interface ManagedConnection extends QualificationConnection {
    readonly raw: DatabaseSync;
}

function openManaged(path: string): ManagedConnection {
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
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

const strippedSchema = stripNonTableDdl(SCHEMA_SQL);

const factory: SqlAdapterQualificationFactory = {
    candidateName: "BrokenDdlAdapter (drops triggers/views/indexes)",
    async createFresh(schemaSql: string): Promise<QualificationDatabase> {
        // Deliberately provision the STRIPPED schema, ignoring the supplied one:
        // this simulates the broken DDL executor of the candidate adapter.
        const dir = mkdtempSync(join(tmpdir(), "hnt002-repro-schema-"));
        const path = join(dir, "qualification.sqlite");
        const primary = openManaged(path);
        try {
            primary.raw.exec(strippedSchema);
        } catch (error) {
            primary.close();
            rmSync(dir, { recursive: true, force: true });
            throw error;
        }
        const opened = new Set<ManagedConnection>([primary]);
        const openAnother = (): ManagedConnection => {
            const connection = openManaged(path);
            opened.add(connection);
            return connection;
        };
        return {
            primary,
            async openPeer(): Promise<QualificationConnection> {
                return openAnother();
            },
            async reopen(): Promise<QualificationConnection> {
                return openAnother();
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

console.log(`\n[repro-schema-identity] suite result: ${report.passed} passed, ${report.failed} failed`);

// Show what the provisioned schema actually contained while the suite ran.
const dir = mkdtempSync(join(tmpdir(), "hnt002-repro-inspect-"));
const path = join(dir, "inspect.sqlite");
const db = new DatabaseSync(path);
db.exec(strippedSchema);
const tables = Number((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c);
const triggers = Number((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='trigger'").get() as { c: number }).c);
const views = Number((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='view'").get() as { c: number }).c);
const indexes = Number((db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c);
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`[repro-schema-identity] provisioned schema actually contained: ${tables} tables, ${triggers} triggers, ${views} views, ${indexes} explicit indexes`);
console.log("[repro-schema-identity] adopted schema requires: 15 tables, 44 triggers, 1 view, 24 explicit indexes");
console.log(report.passed === 10 && report.failed === 0
    ? "[repro-schema-identity] DEMONSTRATED: materially broken schema (0/44 triggers, 0/1 views, 0/24 indexes) still passes 10/10"
    : "[repro-schema-identity] unexpected: suite did not pass as hypothesized");
