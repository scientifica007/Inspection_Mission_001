// Gate 6B host-side contract regression for the provisional Capacitor adapter.
// This is NOT physical-device evidence. It proves the mapping layer itself:
// literal transaction SQL, transaction=false propagation, SqlResult
// normalization, parameter forwarding, and canonical-schema inventory parsing.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CapacitorSqliteAdapter } from "../src/device/capacitor-sqlite-adapter.ts";
import { canonicalInventoryCountIsAdopted, expectedInventoryFromCanonicalSchema } from "../src/gate6b/schema-inventory.ts";

const failures: string[] = [];
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function ok(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`[FAIL] ${name}`);
  }
}

interface Call { kind: "execute" | "run" | "query"; sql: string; params?: unknown[]; transaction?: boolean; }

class FakeConnection {
  calls: Call[] = [];
  runResult: { changes?: { changes?: number; lastId?: number } } = { changes: { changes: 1, lastId: 17 } };
  queryResult: { values?: Record<string, unknown>[] } = { values: [] };

  async execute(sql: string, transaction?: boolean) {
    this.calls.push({ kind: "execute", sql, transaction });
    return { changes: { changes: 0 } };
  }
  async run(sql: string, values: unknown[] = [], transaction?: boolean) {
    this.calls.push({ kind: "run", sql, params: values, transaction });
    return this.runResult;
  }
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ kind: "query", sql, params: values });
    return this.queryResult;
  }
}

function world() {
  const fake = new FakeConnection();
  const adapter = new CapacitorSqliteAdapter(fake as unknown as SQLiteDBConnection);
  return { fake, adapter };
}

await ok("G6B-HOST-01 beginImmediate emits literal BEGIN IMMEDIATE", async () => {
  const { fake, adapter } = world();
  await adapter.beginImmediate();
  assert(fake.calls.length === 1 && fake.calls[0].sql === "BEGIN IMMEDIATE;", "literal BEGIN IMMEDIATE expected");
});

await ok("G6B-HOST-02 beginImmediate disables plugin transaction wrapper", async () => {
  const { fake, adapter } = world();
  await adapter.beginImmediate();
  assert(fake.calls[0].transaction === false, "execute transaction=false expected");
});

await ok("G6B-HOST-03 commit emits literal COMMIT with wrapper disabled", async () => {
  const { fake, adapter } = world();
  await adapter.commit();
  assert(fake.calls[0].sql === "COMMIT;" && fake.calls[0].transaction === false, "literal COMMIT/false expected");
});

await ok("G6B-HOST-04 rollback emits literal ROLLBACK with wrapper disabled", async () => {
  const { fake, adapter } = world();
  await adapter.rollback();
  assert(fake.calls[0].sql === "ROLLBACK;" && fake.calls[0].transaction === false, "literal ROLLBACK/false expected");
});

await ok("G6B-HOST-05 run forwards bound params and transaction=false", async () => {
  const { fake, adapter } = world();
  await adapter.run("UPDATE x SET a=? WHERE id=?", ["العربية O'Reilly", 3]);
  const call = fake.calls[0];
  assert(call.kind === "run" && call.transaction === false, "run transaction=false expected");
  assert(JSON.stringify(call.params) === JSON.stringify(["العربية O'Reilly", 3]), "bound params changed");
});

await ok("G6B-HOST-06 query forwards bound params", async () => {
  const { fake, adapter } = world();
  fake.queryResult = { values: [{ a: "نص", n: 7, z: null }] };
  const rows = await adapter.query("SELECT ? AS a, ? AS n, ? AS z", ["نص", 7, null]);
  assert(fake.calls[0].kind === "query", "query call expected");
  assert(rows[0].a === "نص" && rows[0].n === 7 && rows[0].z === null, "query row normalization changed scalar values");
});

await ok("G6B-HOST-07 real INSERT shape returns numeric identity", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 1, lastId: 21 } };
  const result = await adapter.run("\n INSERT INTO x(a) VALUES (?)", [1]);
  assert(result.changes === 1 && result.lastInsertRowid === 21, "INSERT identity expected");
});

await ok("G6B-HOST-08 UPDATE never exposes stale lastId", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 1, lastId: 21 } };
  const result = await adapter.run("UPDATE x SET a=2 WHERE id=1");
  assert(result.changes === 1 && result.lastInsertRowid === null, "UPDATE rowid must be null");
});

await ok("G6B-HOST-09 zero-match UPDATE returns 0 + null rowid", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 0, lastId: 21 } };
  const result = await adapter.run("UPDATE x SET a=2 WHERE id=999");
  assert(result.changes === 0 && result.lastInsertRowid === null, "zero UPDATE normalization failed");
});

await ok("G6B-HOST-10 DELETE never exposes stale lastId", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 1, lastId: 21 } };
  const result = await adapter.run("DELETE FROM x WHERE id=1");
  assert(result.changes === 1 && result.lastInsertRowid === null, "DELETE rowid must be null");
});

await ok("G6B-HOST-11 no-op INSERT cannot expose stale lastId", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 0, lastId: 21 } };
  const result = await adapter.run("INSERT OR IGNORE INTO x(a) VALUES (?)", [1]);
  assert(result.changes === 0 && result.lastInsertRowid === null, "no-op INSERT rowid must be null");
});

await ok("G6B-HOST-12 affected-row count is normalized", async () => {
  const { fake, adapter } = world();
  fake.runResult = { changes: { changes: 3, lastId: 4 } };
  const result = await adapter.run("UPDATE x SET a=1");
  assert(result.changes === 3, "changes not preserved");
});

await ok("G6B-HOST-13 safe bigint parameter is normalized to number", async () => {
  const { fake, adapter } = world();
  await adapter.run("UPDATE x SET a=?", [42n]);
  assert(fake.calls[0].params?.[0] === 42, "safe bigint not normalized to number");
});

await ok("G6B-HOST-14 unsafe bigint parameter is rejected rather than silently rounded", async () => {
  const { adapter } = world();
  let rejected = false;
  try {
    await adapter.run("UPDATE x SET a=?", [9007199254740993n]);
  } catch {
    rejected = true;
  }
  assert(rejected, "unsafe bigint must reject");
});

await ok("G6B-HOST-15 canonical schema parser derives adopted object counts", () => {
  const sql = readFileSync(resolve("docs/schema/schema.sql"), "utf8");
  const inventory = expectedInventoryFromCanonicalSchema(sql);
  assert(canonicalInventoryCountIsAdopted(inventory), JSON.stringify({ tables: inventory.table.length, triggers: inventory.trigger.length, views: inventory.view.length, indexes: inventory.index.length }));
});

await ok("G6B-HOST-16 canonical schema inventory contains exact key object names", () => {
  const sql = readFileSync(resolve("docs/schema/schema.sql"), "utf8");
  const inventory = expectedInventoryFromCanonicalSchema(sql);
  assert(inventory.table.includes("visit") && inventory.table.includes("finding"), "key tables absent");
  assert(inventory.trigger.includes("trg_visit_bu") && inventory.trigger.includes("trg_recon_bd"), "key triggers absent");
  assert(inventory.view.includes("v_response_outcome"), "derived view absent");
  assert(inventory.index.includes("uq_active_def_per_code") && inventory.index.includes("uq_response_ctx"), "key indexes absent");
});

console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) {
  console.log("RESULT: FAILURE");
  process.exitCode = 1;
} else {
  console.log("RESULT: SUCCESS (0 failures)");
}
