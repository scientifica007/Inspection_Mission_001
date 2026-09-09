// Repository-hosted SqlAdapter qualification runner.
//
// Run from repository root:
//   node --experimental-strip-types tests/sqladapter_qualification.ts
//
// This runner qualifies the existing node:sqlite development adapter as the
// reference candidate for the host-testable subset of Gate 6B. The reusable
// contract itself lives in tests/support/sqladapter-qualification.ts and has
// no node:* or plugin-specific imports.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeSqliteAdapter } from "../dev/node-sqlite-adapter.ts";
import { parseArtifact } from "../src/bootstrap/artifact.ts";
import type {
    QualificationConnection,
    QualificationDatabase,
    SqlAdapterQualificationFactory,
} from "./support/sqladapter-qualification.ts";
import { qualifySqlAdapter } from "./support/sqladapter-qualification.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "docs", "schema", "schema.sql"), "utf8");
const BOOTSTRAP = parseArtifact(readFileSync(join(ROOT, "bootstrap", "v1", "checklist-v1.json"), "utf8"));

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

const factory: SqlAdapterQualificationFactory = {
    candidateName: "NodeSqliteAdapter (reference host candidate)",

    async createFresh(schemaSql: string): Promise<QualificationDatabase> {
        const dir = mkdtempSync(join(tmpdir(), "inspection-sqladapter-"));
        const path = join(dir, "qualification.sqlite");
        const primary = openManaged(path);
        try {
            // Candidate-specific database provisioning is outside SqlAdapter's
            // intentionally narrow five-method seam. The qualification suite
            // then verifies the exact adopted schema through that seam.
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
                        // best-effort cleanup after assertions
                    }
                }
                rmSync(dir, { recursive: true, force: true });
            },
        };
    },
};

const report = await qualifySqlAdapter(factory, {
    schemaSql: SCHEMA_SQL,
    bootstrapArtifact: BOOTSTRAP,
});

for (const result of report.cases) {
    if (result.passed) {
        console.log(`PASS  ${result.name}`);
    } else {
        console.error(`FAIL  ${result.name}`);
        console.error(`      ${result.detail ?? "unknown failure"}`);
    }
}

console.log(`\nSqlAdapter qualification — ${report.candidate}: ${report.passed} passed, ${report.failed} failed`);

if (report.failed > 0) {
    process.exitCode = 1;
}
