// Gate 5B — development/test SQLite adapter (node:sqlite).
//
// node:sqlite is permitted ONLY in development/test adapter code (Gate-5A D1 /
// correction 1): this module is the single place node:* is imported for the
// Gate-5B loader.  Runtime-neutral domain logic (src/bootstrap/*) never
// depends on node:* APIs — it only sees the SqlAdapter seam.  The adapter
// preserves the explicit BEGIN IMMEDIATE … COMMIT/ROLLBACK boundary and never
// wraps a statement in its own implicit transaction inside a domain
// transaction.

import { DatabaseSync } from "node:sqlite";
import type { SqlAdapter, SqlRow, SqlResult, SqlValue } from "../src/bootstrap/adapter.ts";

/**
 * Gate-5B's audited run() call sites use top-level INSERT/UPDATE/DELETE SQL.
 * node:sqlite exposes sqlite3_last_insert_rowid(), which is connection state,
 * so it can retain a prior INSERT rowid after UPDATE/DELETE.  Only a top-level
 * INSERT that actually changed at least one row may expose that value through
 * the repository's SqlResult contract.
 */
function isTopLevelInsert(sourceSql: string): boolean {
    return /^\s*INSERT\b/i.test(sourceSql);
}

export class NodeSqliteAdapter implements SqlAdapter {
    private readonly db: DatabaseSync;

    constructor(db: DatabaseSync) {
        this.db = db;
    }

    static openFresh(schemaSql: string): NodeSqliteAdapter {
        const db = new DatabaseSync(":memory:");
        db.exec(schemaSql);
        return new NodeSqliteAdapter(db);
    }

    async beginImmediate(): Promise<void> {
        this.db.exec("BEGIN IMMEDIATE");
    }

    async commit(): Promise<void> {
        this.db.exec("COMMIT");
    }

    async rollback(): Promise<void> {
        this.db.exec("ROLLBACK");
    }

    async run(sql: string, params: readonly SqlValue[] = []): Promise<SqlResult> {
        const stmt = this.db.prepare(sql);
        const res = stmt.run(...params);
        const changes = typeof res.changes === "bigint" ? Number(res.changes) : res.changes;
        const rid = res.lastInsertRowid;
        const inserted = isTopLevelInsert(stmt.sourceSQL) && changes > 0;
        return {
            changes,
            lastInsertRowid:
                inserted && (typeof rid === "bigint" || typeof rid === "number") ? Number(rid) : null,
        };
    }

    async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
        const stmt = this.db.prepare(sql);
        return (stmt.all(...params) as SqlRow[]);
    }
}

export function openFreshDb(schemaSql: string): NodeSqliteAdapter {
    return NodeSqliteAdapter.openFresh(schemaSql);
}
