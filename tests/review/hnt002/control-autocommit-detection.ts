// HNT-002 review-only POSITIVE CONTROL (NOT part of the target candidate).
//
// Purpose: verify the target qualification suite actually has teeth for the
// most important broken-adapter class — an adapter that silently commits each
// statement independently (contract violation: "never silently commit each
// statement independently inside an open domain transaction", and no real
// explicit BEGIN IMMEDIATE boundary).
//
// Expected: cases "explicit transaction commits atomically and peer sees only
// committed state", "rollback restores pre-transaction durable state" and
// "BEGIN IMMEDIATE serializes competing writers" must FAIL for this adapter;
// the other seven cases may pass. If those three cases do NOT fail, the suite
// would be unable to detect per-statement autocommit.
//
// This control DISPROVES the hypothesis "a per-statement-autocommit adapter
// could pass the target qualification suite".

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SqlAdapter, SqlResult, SqlRow, SqlValue } from "../../../src/bootstrap/adapter.ts";
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

/** Adapter that auto-commits every statement and treats begin/commit/rollback as no-ops. */
class AutocommitAdapter implements SqlAdapter {
    private readonly raw: DatabaseSync;

    constructor(raw: DatabaseSync) {
        this.raw = raw;
    }

    async beginImmediate(): Promise<void> {
        // no-op: no explicit transaction boundary
    }

    async commit(): Promise<void> {
        // no-op
    }

    async rollback(): Promise<void> {
        // no-op
    }

    async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
        this.raw.exec("BEGIN IMMEDIATE");
        try {
            const stmt = this.raw.prepare(sql);
            const res = stmt.run(...params);
            this.raw.exec("COMMIT");
            const changes = typeof res.changes === "bigint" ? Number(res.changes) : res.changes;
            const rid = res.lastInsertRowid;
            return {
                changes,
                lastInsertRowid: typeof rid === "bigint" || typeof rid === "number" ? Number(rid) : null,
            };
        } catch (error) {
            try {
                this.raw.exec("ROLLBACK");
            } catch {
                // ignore
            }
            throw error;
        }
    }

    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        const stmt = this.raw.prepare(sql);
        return stmt.all(...params) as SqlRow[];
    }
}

interface ManagedConnection extends QualificationConnection {
    readonly raw: DatabaseSync;
}

function openManaged(path: string): ManagedConnection {
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA busy_timeout = 0");
    const adapter = new AutocommitAdapter(raw);
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
    candidateName: "AutocommitAdapter (per-statement implicit transactions, no real BEGIN IMMEDIATE)",
    async createFresh(schemaSql: string): Promise<QualificationDatabase> {
        const dir = mkdtempSync(join(tmpdir(), "hnt002-control-autocommit-"));
        const path = join(dir, "qualification.sqlite");
        const primary = openManaged(path);
        try {
            primary.raw.exec(schemaSql);
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

const mustFail = new Set([
    "explicit transaction commits atomically and peer sees only committed state",
    "rollback restores pre-transaction durable state",
    "BEGIN IMMEDIATE serializes competing writers",
]);

const failedCases = report.cases.filter((c) => !c.passed).map((c) => c.name);
const mustFailFailed = [...mustFail].filter((n) => failedCases.includes(n));
const mustFailPassed = [...mustFail].filter((n) => !failedCases.includes(n));

console.log(`\n[control-autocommit-detection] suite result: ${report.passed} passed, ${report.failed} failed`);
console.log(`[control-autocommit-detection] failed cases: ${failedCases.length === 0 ? "(none)" : failedCases.join(" | ")}`);

if (mustFailPassed.length === 0 && mustFailFailed.length === mustFail.size) {
    console.log("[control-autocommit-detection] CONTROL CONFIRMED: suite detects per-statement autocommit (all three transaction cases failed)");
} else {
    console.log(`[control-autocommit-detection] CONTROL FAILED: transaction cases that still passed: ${mustFailPassed.join(", ")}`);
    process.exitCode = 1;
}
