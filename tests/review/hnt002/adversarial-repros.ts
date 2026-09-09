// HNT-002 review-only adversarial reproducers.
//
// This file does NOT change or wrap any target HNT-001 source. It imports the
// frozen candidate exactly as delivered and demonstrates qualification false
// positives/edge behaviour from a separate review branch.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeSqliteAdapter } from "../../../dev/node-sqlite-adapter.ts";
import { parseArtifact } from "../../../src/bootstrap/artifact.ts";
import type {
    HostQualificationSeam,
    QualificationEnvironment,
    QualifiedConnection,
} from "../../sqladapter-qualification/qualification-contract.ts";
import { runHostQualification } from "../../sqladapter-qualification/qualification-contract.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CANONICAL_SCHEMA = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const CANONICAL_ARTIFACT = parseArtifact(
    readFileSync(join(ROOT, "bootstrap", "v1", "checklist-v1.json"), "utf8"),
);

type CloseMode = "real" | "noop";

interface EnvironmentStats {
    logicalCloseCalls: number;
    physicalCloseCalls: number;
}

class ReviewFileEnvironment implements QualificationEnvironment {
    readonly label: string;
    private readonly dirPath: string;
    private readonly filePath: string;
    private readonly closeMode: CloseMode;
    private readonly stats: EnvironmentStats;
    private readonly connections = new Set<DatabaseSync>();
    private disposed = false;

    constructor(
        label: string,
        dirPath: string,
        filePath: string,
        closeMode: CloseMode,
        stats: EnvironmentStats,
    ) {
        this.label = label;
        this.dirPath = dirPath;
        this.filePath = filePath;
        this.closeMode = closeMode;
        this.stats = stats;
    }

    async openConnection(): Promise<QualifiedConnection> {
        if (this.disposed) throw new Error(`${this.label}: disposed`);
        const db = new DatabaseSync(this.filePath);
        db.exec("PRAGMA foreign_keys = ON;");
        this.connections.add(db);
        const adapter = new NodeSqliteAdapter(db);
        return {
            adapter,
            close: async () => {
                this.stats.logicalCloseCalls += 1;
                if (this.closeMode === "noop") {
                    // Deliberately broken lifecycle seam: close() reports success
                    // while leaving the original authoritative connection alive.
                    return;
                }
                if (!this.connections.delete(db)) return;
                db.close();
                this.stats.physicalCloseCalls += 1;
            },
        };
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        for (const db of [...this.connections]) {
            try {
                db.close();
                this.stats.physicalCloseCalls += 1;
            } catch {
                // review cleanup only
            }
        }
        this.connections.clear();
        rmSync(this.dirPath, { recursive: true, force: true });
    }
}

function seamForSchema(
    schemaSql: string,
    label: string,
    closeMode: CloseMode = "real",
    stats: EnvironmentStats = { logicalCloseCalls: 0, physicalCloseCalls: 0 },
): HostQualificationSeam {
    let seq = 0;
    return {
        candidateLabel: label,
        async createFreshEnvironment(): Promise<QualificationEnvironment> {
            const dirPath = mkdtempSync(join(tmpdir(), "hnt002-"));
            const filePath = join(dirPath, "durable.sqlite");
            const provision = new DatabaseSync(filePath);
            try {
                provision.exec("PRAGMA synchronous = OFF;");
                provision.exec(schemaSql);
            } finally {
                provision.close();
            }
            seq += 1;
            return new ReviewFileEnvironment(`${label}-${seq}`, dirPath, filePath, closeMode, stats);
        },
    };
}

function mutateCorrectiveActionInsertTrigger(schemaSql: string): string {
    const marker = "CREATE TRIGGER trg_ca_bi BEFORE INSERT ON corrective_action";
    const start = schemaSql.indexOf(marker);
    assert.notEqual(start, -1, "review mutation marker trg_ca_bi must exist in canonical schema");
    const endMarker = "\nEND;";
    const end = schemaSql.indexOf(endMarker, start);
    assert.notEqual(end, -1, "review mutation must find end of trg_ca_bi");

    const replacement = `${marker}\nBEGIN\n    SELECT 1;\nEND;`;
    const mutated = schemaSql.slice(0, start) + replacement + schemaSql.slice(end + endMarker.length);
    assert.notEqual(mutated, schemaSql, "mutated schema must differ from canonical schema");
    return mutated;
}

async function reproduceNonInsertRowidContractGap(): Promise<void> {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
        const adapter = new NodeSqliteAdapter(db);
        const inserted = await adapter.run("INSERT INTO t(value) VALUES (?)", ["a"]);
        assert.equal(inserted.changes, 1);
        assert.equal(inserted.lastInsertRowid, 1);

        const updated = await adapter.run("UPDATE t SET value = ? WHERE id = ?", ["b", 1]);
        const noMatch = await adapter.run("UPDATE t SET value = ? WHERE id = ?", ["c", 999]);

        assert.equal(updated.changes, 1);
        assert.equal(noMatch.changes, 0);
        assert.equal(
            updated.lastInsertRowid,
            1,
            "reproducer expects NodeSqliteAdapter to leak the previous insert rowid on UPDATE",
        );
        assert.equal(
            noMatch.lastInsertRowid,
            1,
            "reproducer expects NodeSqliteAdapter to leak the previous insert rowid on zero-match UPDATE",
        );

        console.log(
            `[REPRO PASS] non-insert rowid gap: UPDATE changes=${updated.changes}, rowid=${updated.lastInsertRowid}; ` +
                `zero-match changes=${noMatch.changes}, rowid=${noMatch.lastInsertRowid}`,
        );
    } finally {
        db.close();
    }
}

async function reproduceMutatedSchemaFalsePositive(): Promise<void> {
    const mutatedSchema = mutateCorrectiveActionInsertTrigger(CANONICAL_SCHEMA);

    const probe = new DatabaseSync(":memory:");
    try {
        probe.exec(mutatedSchema);
        const row = probe
            .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='trg_ca_bi'")
            .get() as { sql?: string } | undefined;
        assert.ok(row?.sql?.includes("SELECT 1"), "mutant trg_ca_bi must be installed");
        assert.ok(
            !row?.sql?.includes("no corrective action may be created under a RESOLVED or VOIDED finding"),
            "mutant trg_ca_bi must have lost the canonical guard",
        );
    } finally {
        probe.close();
    }

    const summary = await runHostQualification(
        seamForSchema(mutatedSchema, "review-mutated-schema"),
        CANONICAL_ARTIFACT,
    );
    assert.equal(
        summary.totalFailed,
        0,
        `expected the current harness to false-pass the non-exact schema, got ${summary.totalFailed} failures`,
    );
    console.log(
        `[REPRO PASS] exact-schema false positive: deliberately mutated trg_ca_bi still qualified ` +
            `(${summary.totalPassed} passed, ${summary.totalFailed} failed)`,
    );
}

async function reproduceNoopCloseFalsePositive(): Promise<void> {
    const stats: EnvironmentStats = { logicalCloseCalls: 0, physicalCloseCalls: 0 };
    const summary = await runHostQualification(
        seamForSchema(CANONICAL_SCHEMA, "review-noop-close", "noop", stats),
        CANONICAL_ARTIFACT,
    );

    assert.ok(stats.logicalCloseCalls > 0, "qualification must have invoked review close() calls");
    assert.equal(
        summary.totalFailed,
        0,
        `expected the current harness to accept no-op close lifecycle, got ${summary.totalFailed} failures`,
    );
    console.log(
        `[REPRO PASS] close/reopen verification gap: ${stats.logicalCloseCalls} logical close() calls were no-ops, ` +
            `yet qualification reported ${summary.totalPassed} passed, ${summary.totalFailed} failed`,
    );
}

function disproveSynchronousOffPersistenceHypothesis(): void {
    const dirPath = mkdtempSync(join(tmpdir(), "hnt002-sync-"));
    const filePath = join(dirPath, "sync.sqlite");
    try {
        const provision = new DatabaseSync(filePath);
        provision.exec("PRAGMA synchronous = OFF;");
        provision.exec("CREATE TABLE t(id INTEGER PRIMARY KEY);");
        const during = provision.prepare("PRAGMA synchronous").get() as Record<string, unknown>;
        const duringValue = Number(Object.values(during)[0]);
        assert.equal(duringValue, 0, "provisioning connection must actually be synchronous=OFF");
        provision.close();

        const reopened = new DatabaseSync(filePath);
        const after = reopened.prepare("PRAGMA synchronous").get() as Record<string, unknown>;
        const reopenedValue = Number(Object.values(after)[0]);
        reopened.close();
        assert.notEqual(
            reopenedValue,
            0,
            "synchronous=OFF must not persist into a fresh qualification connection",
        );
        console.log(
            `[DISPROVED] provisioning PRAGMA synchronous=OFF is connection-local: reopened value=${reopenedValue}`,
        );
    } finally {
        rmSync(dirPath, { recursive: true, force: true });
    }
}

await reproduceNonInsertRowidContractGap();
await reproduceMutatedSchemaFalsePositive();
await reproduceNoopCloseFalsePositive();
disproveSynchronousOffPersistenceHypothesis();

console.log("HNT-002 adversarial reproducers completed successfully.");
