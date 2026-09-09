// Reusable host-side qualification contract for SqlAdapter candidates.
//
// This file deliberately contains no node:* or plugin-specific imports. A
// candidate-specific runner supplies the database lifecycle factory while the
// assertions below exercise the semantics adopted in DEVICE-ADAPTER-CONTRACT-v1.

import type { SqlAdapter, SqlValue } from "../../src/bootstrap/adapter.ts";
import type { BootstrapArtifact } from "../../src/bootstrap/artifact.ts";
import { BootstrapLoader } from "../../src/bootstrap/loader.ts";

export interface QualificationConnection {
    adapter: SqlAdapter;
    close(): Promise<void> | void;
}

export interface QualificationDatabase {
    /** Fresh primary connection. The exact adopted schema must already exist. */
    primary: QualificationConnection;
    /** Open another connection to the SAME durable database. */
    openPeer(): Promise<QualificationConnection>;
    /** Reopen the SAME durable database after the original primary is closed. */
    reopen(): Promise<QualificationConnection>;
    /** Remove all candidate-specific temporary resources. */
    cleanup(): Promise<void> | void;
}

export interface SqlAdapterQualificationFactory {
    readonly candidateName: string;
    createFresh(schemaSql: string): Promise<QualificationDatabase>;
}

export interface QualificationAssets {
    schemaSql: string;
    bootstrapArtifact: BootstrapArtifact;
}

export interface QualificationCaseResult {
    name: string;
    passed: boolean;
    detail?: string;
}

export interface QualificationReport {
    candidate: string;
    passed: number;
    failed: number;
    cases: QualificationCaseResult[];
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function scalar(db: SqlAdapter, sql: string, params: readonly SqlValue[] = []): Promise<unknown> {
    const rows = await db.query(sql, params);
    assert(rows.length === 1, `expected exactly one row for scalar query, got ${rows.length}`);
    const values = Object.values(rows[0]);
    assert(values.length === 1, `expected exactly one scalar column, got ${values.length}`);
    return values[0];
}

async function expectReject(fn: () => Promise<unknown>, label: string): Promise<void> {
    try {
        await fn();
    } catch {
        return;
    }
    throw new Error(`${label}: expected rejection, operation succeeded`);
}

async function closeQuietly(connection: QualificationConnection | null | undefined): Promise<void> {
    if (!connection) return;
    try {
        await connection.close();
    } catch {
        // Test cleanup must not mask the primary assertion failure.
    }
}

async function withFresh(
    factory: SqlAdapterQualificationFactory,
    schemaSql: string,
    fn: (db: QualificationDatabase) => Promise<void>,
): Promise<void> {
    const db = await factory.createFresh(schemaSql);
    try {
        await fn(db);
    } finally {
        await closeQuietly(db.primary);
        await db.cleanup();
    }
}

/**
 * Run the repository-hosted subset of the Gate-6B adapter qualification matrix.
 *
 * This is intentionally NOT a substitute for Android/device qualification.
 * App-private storage, WebView lifecycle, physical process kill/restart and
 * plugin-specific behavior remain Gate-6B device proofs.
 */
export async function qualifySqlAdapter(
    factory: SqlAdapterQualificationFactory,
    assets: QualificationAssets,
): Promise<QualificationReport> {
    const cases: QualificationCaseResult[] = [];

    const run = async (name: string, fn: () => Promise<void>): Promise<void> => {
        try {
            await fn();
            cases.push({ name, passed: true });
        } catch (error) {
            cases.push({
                name,
                passed: false,
                detail: error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error),
            });
        }
    };

    await run("exact adopted schema is present", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary }) => {
            const tableCount = Number(
                await scalar(
                    primary.adapter,
                    "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                ),
            );
            assert(tableCount === 15, `expected 15 physical tables from adopted schema, got ${tableCount}`);
        });
    });

    await run("parameter binding preserves text/integer/null values", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary }) => {
            const db = primary.adapter;
            await db.run("CREATE TABLE __qa_value_probe (id INTEGER PRIMARY KEY, txt TEXT NOT NULL, n INTEGER NOT NULL, z TEXT NULL)");
            const inserted = await db.run(
                "INSERT INTO __qa_value_probe(txt, n, z) VALUES (?, ?, ?)",
                ["O'Reilly — تبسة", 42, null],
            );
            assert(inserted.changes === 1, `insert changes must be 1, got ${inserted.changes}`);
            assert(typeof inserted.lastInsertRowid === "number", "insert lastInsertRowid must normalize to number");
            const rows = await db.query("SELECT txt, n, z FROM __qa_value_probe WHERE id = ?", [inserted.lastInsertRowid]);
            assert(rows.length === 1, `expected one inserted row, got ${rows.length}`);
            assert(rows[0].txt === "O'Reilly — تبسة", "text parameter/value was reinterpreted");
            assert(Number(rows[0].n) === 42, "integer parameter/value was reinterpreted");
            assert(rows[0].z === null, "NULL parameter/value was reinterpreted");
        });
    });

    await run("affected-row counts are normalized and exact for guarded writes", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary }) => {
            const db = primary.adapter;
            await db.run("CREATE TABLE __qa_changes_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
            const a = await db.run("INSERT INTO __qa_changes_probe(v) VALUES (?)", ["a"]);
            assert(a.changes === 1 && typeof a.changes === "number", `insert changes must be numeric 1, got ${String(a.changes)}`);
            const u = await db.run("UPDATE __qa_changes_probe SET v = ? WHERE id = ?", ["b", a.lastInsertRowid]);
            assert(u.changes === 1 && typeof u.changes === "number", `update changes must be numeric 1, got ${String(u.changes)}`);
            const miss = await db.run("UPDATE __qa_changes_probe SET v = ? WHERE id = ?", ["c", 999999]);
            assert(miss.changes === 0, `missing guarded update must report 0 changes, got ${miss.changes}`);
        });
    });

    await run("explicit transaction commits atomically and peer sees only committed state", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary, openPeer }) => {
            const db = primary.adapter;
            await db.run("CREATE TABLE __qa_commit_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
            const peer = await openPeer();
            try {
                await db.beginImmediate();
                await db.run("INSERT INTO __qa_commit_probe(v) VALUES (?)", ["first"]);
                await db.run("INSERT INTO __qa_commit_probe(v) VALUES (?)", ["second"]);
                assert(Number(await scalar(db, "SELECT count(*) AS c FROM __qa_commit_probe")) === 2, "primary must see its uncommitted writes");
                assert(Number(await scalar(peer.adapter, "SELECT count(*) AS c FROM __qa_commit_probe")) === 0, "peer observed uncommitted writes");
                await db.commit();
                assert(Number(await scalar(peer.adapter, "SELECT count(*) AS c FROM __qa_commit_probe")) === 2, "peer did not observe committed transaction");
            } finally {
                await closeQuietly(peer);
            }
        });
    });

    await run("rollback restores pre-transaction durable state", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary, openPeer }) => {
            const db = primary.adapter;
            await db.run("CREATE TABLE __qa_rollback_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
            await db.run("INSERT INTO __qa_rollback_probe(v) VALUES (?)", ["baseline"]);
            const peer = await openPeer();
            try {
                await db.beginImmediate();
                await db.run("INSERT INTO __qa_rollback_probe(v) VALUES (?)", ["transient"]);
                await db.rollback();
                assert(Number(await scalar(db, "SELECT count(*) AS c FROM __qa_rollback_probe")) === 1, "rollback did not restore primary state");
                assert(Number(await scalar(peer.adapter, "SELECT count(*) AS c FROM __qa_rollback_probe")) === 1, "rollback did not restore durable peer-visible state");
            } finally {
                await closeQuietly(peer);
            }
        });
    });

    await run("BEGIN IMMEDIATE serializes competing writers", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary, openPeer }) => {
            const peer = await openPeer();
            try {
                await primary.adapter.beginImmediate();
                await expectReject(() => peer.adapter.beginImmediate(), "competing BEGIN IMMEDIATE");
                await primary.adapter.rollback();
                // The peer must still be usable after the rejected competing begin.
                await peer.adapter.beginImmediate();
                await peer.adapter.rollback();
            } finally {
                await closeQuietly(peer);
            }
        });
    });

    await run("foreign-key enforcement is active on authoritative connections", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary, openPeer }) => {
            const db = primary.adapter;
            assert(Number(await scalar(db, "PRAGMA foreign_keys")) === 1, "primary PRAGMA foreign_keys is not ON");
            await db.run("CREATE TABLE __qa_parent (id INTEGER PRIMARY KEY)");
            await db.run("CREATE TABLE __qa_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES __qa_parent(id))");
            await expectReject(() => db.run("INSERT INTO __qa_child(id, parent_id) VALUES (?, ?)", [1, 999]), "invalid primary FK write");
            const peer = await openPeer();
            try {
                assert(Number(await scalar(peer.adapter, "PRAGMA foreign_keys")) === 1, "peer PRAGMA foreign_keys is not ON");
                await expectReject(() => peer.adapter.run("INSERT INTO __qa_child(id, parent_id) VALUES (?, ?)", [2, 999]), "invalid peer FK write");
            } finally {
                await closeQuietly(peer);
            }
        });
    });

    await run("canonical bootstrap loads and verifies through SqlAdapter", async () => {
        await withFresh(factory, assets.schemaSql, async ({ primary }) => {
            const report = await new BootstrapLoader(primary.adapter, assets.bootstrapArtifact).load();
            assert(report.loaded.length === 24, `expected 24 loaded definitions, got ${report.loaded.length}`);
            assert(report.alreadyPresent.length === 0, "fresh bootstrap unexpectedly reported existing definitions");
            assert(report.p0ExpectedCount === 20, `expected P0 manifest count 20, got ${report.p0ExpectedCount}`);
            assert(Number(await scalar(primary.adapter, "SELECT count(*) AS c FROM checklist_item_definition")) === 24, "bootstrap definition count mismatch");
            assert(Number(await scalar(primary.adapter, "SELECT count(*) AS c FROM checklist_item_definition WHERE status = 'ACTIVE' AND priority = 'P0'")) === 20, "ACTIVE P0 bootstrap count mismatch");
        });
    });

    await run("committed durable state survives close/reopen of the same database", async () => {
        const holder = await factory.createFresh(assets.schemaSql);
        let reopened: QualificationConnection | null = null;
        try {
            await holder.primary.adapter.run("CREATE TABLE __qa_restart_probe (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
            await holder.primary.adapter.beginImmediate();
            await holder.primary.adapter.run("INSERT INTO __qa_restart_probe(v) VALUES (?)", ["durable"]);
            await holder.primary.adapter.commit();
            await holder.primary.close();
            reopened = await holder.reopen();
            assert(Number(await scalar(reopened.adapter, "SELECT count(*) AS c FROM __qa_restart_probe WHERE v = ?", ["durable"])) === 1, "committed row missing after reopen");
        } finally {
            await closeQuietly(reopened);
            await holder.cleanup();
        }
    });

    await run("bootstrap state also survives close/reopen", async () => {
        const holder = await factory.createFresh(assets.schemaSql);
        let reopened: QualificationConnection | null = null;
        try {
            await new BootstrapLoader(holder.primary.adapter, assets.bootstrapArtifact).load();
            await holder.primary.close();
            reopened = await holder.reopen();
            assert(Number(await scalar(reopened.adapter, "SELECT count(*) AS c FROM checklist_item_definition")) === 24, "bootstrap definitions missing after reopen");
            assert(Number(await scalar(reopened.adapter, "SELECT count(*) AS c FROM checklist_allowed_value")) > 0, "bootstrap allowed values missing after reopen");
        } finally {
            await closeQuietly(reopened);
            await holder.cleanup();
        }
    });

    const passed = cases.filter((c) => c.passed).length;
    const failed = cases.length - passed;
    return { candidate: factory.candidateName, passed, failed, cases };
}
