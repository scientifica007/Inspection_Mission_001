// Gate 5B — focused regression for the Node development/test SqlAdapter.
//
// This suite exists separately from the large bootstrap/reference-data suite
// because it tests the Gate-5B adapter seam itself, not bootstrap artifact
// generation/content.  It uses the real NodeSqliteAdapter implementation.
//
// Run from repository root (Node.js 22):
//   node --experimental-strip-types tests/gate5b_adapter_regression.ts

import { openFreshDb } from "../dev/node-sqlite-adapter.ts";

const failures: string[] = [];
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function ok(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed += 1;
        console.log(`[PASS] ${name}`);
    } catch (error) {
        failures.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`[FAIL] ${name}`);
    }
}

function freshProbe() {
    return openFreshDb(`
        CREATE TABLE __g5b_rowid_probe (
            id INTEGER PRIMARY KEY,
            value TEXT NOT NULL UNIQUE
        );
    `);
}

await ok("G5B-ROWID-1 INSERT returns numeric identity", async () => {
    const db = freshProbe();
    const result = await db.run("\n  INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["first"]);
    assert(result.changes === 1, `INSERT changes expected 1, got ${result.changes}`);
    assert(typeof result.lastInsertRowid === "number", `INSERT rowid expected number, got ${String(result.lastInsertRowid)}`);
    const rows = await db.query("SELECT id FROM __g5b_rowid_probe WHERE id = ?", [result.lastInsertRowid]);
    assert(rows.length === 1, "returned INSERT rowid does not identify the inserted row");
});

await ok("G5B-ROWID-2 UPDATE never leaks prior insert rowid", async () => {
    const db = freshProbe();
    const inserted = await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["first"]);
    const result = await db.run("UPDATE __g5b_rowid_probe SET value = ? WHERE id = ?", ["updated", inserted.lastInsertRowid]);
    assert(result.changes === 1, `UPDATE changes expected 1, got ${result.changes}`);
    assert(result.lastInsertRowid === null, `UPDATE rowid expected null, got ${String(result.lastInsertRowid)}`);
});

await ok("G5B-ROWID-3 zero-match UPDATE returns 0 changes and null rowid", async () => {
    const db = freshProbe();
    await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["first"]);
    const result = await db.run("UPDATE __g5b_rowid_probe SET value = ? WHERE id = ?", ["missing", 999999]);
    assert(result.changes === 0, `zero-match UPDATE changes expected 0, got ${result.changes}`);
    assert(result.lastInsertRowid === null, `zero-match UPDATE rowid expected null, got ${String(result.lastInsertRowid)}`);
});

await ok("G5B-ROWID-4 DELETE returns null rowid", async () => {
    const db = freshProbe();
    const inserted = await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["first"]);
    const result = await db.run("DELETE FROM __g5b_rowid_probe WHERE id = ?", [inserted.lastInsertRowid]);
    assert(result.changes === 1, `DELETE changes expected 1, got ${result.changes}`);
    assert(result.lastInsertRowid === null, `DELETE rowid expected null, got ${String(result.lastInsertRowid)}`);
});

await ok("G5B-ROWID-5 later INSERT still returns its own identity", async () => {
    const db = freshProbe();
    const first = await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["first"]);
    await db.run("UPDATE __g5b_rowid_probe SET value = ? WHERE id = ?", ["updated", first.lastInsertRowid]);
    await db.run("DELETE FROM __g5b_rowid_probe WHERE id = ?", [first.lastInsertRowid]);
    const later = await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["later"]);
    assert(later.changes === 1, `later INSERT changes expected 1, got ${later.changes}`);
    assert(typeof later.lastInsertRowid === "number", `later INSERT rowid expected number, got ${String(later.lastInsertRowid)}`);
    const rows = await db.query("SELECT value FROM __g5b_rowid_probe WHERE id = ?", [later.lastInsertRowid]);
    assert(rows.length === 1 && rows[0].value === "later", "later INSERT rowid does not identify the later row");
});

await ok("G5B-ROWID-6 ignored INSERT cannot expose stale identity", async () => {
    const db = freshProbe();
    await db.run("INSERT INTO __g5b_rowid_probe(value) VALUES (?)", ["unique"]);
    const ignored = await db.run("INSERT OR IGNORE INTO __g5b_rowid_probe(value) VALUES (?)", ["unique"]);
    assert(ignored.changes === 0, `ignored INSERT changes expected 0, got ${ignored.changes}`);
    assert(ignored.lastInsertRowid === null, `ignored INSERT rowid expected null, got ${String(ignored.lastInsertRowid)}`);
});

console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) {
    console.log("RESULT: FAILURE");
    process.exitCode = 1;
} else {
    console.log("RESULT: SUCCESS (0 failures)");
}
