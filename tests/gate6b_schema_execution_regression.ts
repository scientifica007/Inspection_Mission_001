// Gate 6B host regression for the Android canonical-schema execution correction.
// This is NOT physical-device evidence. It reproduces the pinned plugin v8.1.1
// splitter defect, then verifies the corrected per-statement transport against
// the exact canonical schema using Python's independent sqlite3 parser/runtime.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executeCanonicalSchemaStatements,
  prepareCanonicalStatementForCapacitorExecute,
  segmentCanonicalSchema,
  type CanonicalSchemaStatement,
} from "../src/gate6b/canonical-schema-execution.ts";

const CANONICAL_SCHEMA_SHA256 = "c9c8682ec721b5c24ef3950c49f5a5c402f053d99aa88c617dfd7fe8a7c19ba7";
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

function pluginV811GetStatementsArray(statements: string): string[] {
  let sqlCmdArray = statements.replaceAll("end;", "END;").split(";\n");
  const list = sqlCmdArray.map((value) => value.trim());

  while (list.includes("END")) {
    const idx = list.indexOf("END");
    assert(idx > 0, "plugin trigger reconstruction found END without predecessor");
    list[idx - 1] = `${list[idx - 1]}; END`;
    list.splice(idx, 1);
  }

  sqlCmdArray = list.map((value) => value
    .split("\n")
    .map((rawLine) => {
      let line = rawLine.trim();
      const idx = line.indexOf("--");
      if (idx > -1) line = line.substring(0, idx);
      return line;
    })
    .filter((line) => line.length > 0)
    .join(" "));

  if (sqlCmdArray.length > 0 && sqlCmdArray[sqlCmdArray.length - 1].trim().length === 0) {
    sqlCmdArray = sqlCmdArray.slice(0, -1);
  }
  return sqlCmdArray;
}

interface PythonResult {
  ok: boolean;
  failedIndex?: number;
  error?: string;
  inventory?: Record<"table" | "trigger" | "view" | "index", string[]>;
  triggerSql?: Record<string, string>;
}

const PYTHON_SQLITE_PROBE = String.raw`
import json
import sqlite3
import sys

payload = json.load(sys.stdin)
conn = sqlite3.connect(":memory:")

try:
    if payload["mode"] == "script":
        conn.executescript(payload["schema"])
    elif payload["mode"] == "statements":
        for index, statement in enumerate(payload["statements"]):
            try:
                conn.execute(statement)
            except Exception as exc:
                print(json.dumps({
                    "ok": False,
                    "failedIndex": index,
                    "error": str(exc),
                }, ensure_ascii=False))
                sys.exit(0)
    else:
        raise RuntimeError("unknown probe mode")

    inventory = {"table": [], "trigger": [], "view": [], "index": []}
    trigger_sql = {}
    for obj_type, name, sql in conn.execute(
        """
        SELECT type, name, sql
          FROM sqlite_master
         WHERE type IN ('table','trigger','view','index')
           AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name
        """
    ):
        inventory[obj_type].append(name)
        if obj_type == "trigger":
            trigger_sql[name] = sql or ""

    print(json.dumps({
        "ok": True,
        "inventory": inventory,
        "triggerSql": trigger_sql,
    }, ensure_ascii=False))
finally:
    conn.close()
`;

function runPython(payload: unknown): PythonResult {
  const result = spawnSync("python3", ["-c", PYTHON_SQLITE_PROBE], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert(result.status === 0, `python sqlite probe exited ${result.status}: ${result.stderr}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  assert(line, `python sqlite probe produced no JSON: ${result.stderr}`);
  return JSON.parse(line) as PythonResult;
}

function statementOf(statements: CanonicalSchemaStatement[], objectName: string): CanonicalSchemaStatement {
  const found = statements.find((statement) => statement.objectName === objectName);
  assert(found, `statement ${objectName} not found`);
  return found;
}

const schema = readFileSync(resolve("docs/schema/schema.sql"), "utf8");
const statements = segmentCanonicalSchema(schema);

await ok("G6B-SCHEMA-01 pinned v8.1.1 Android source confirms splitter defect and execSQL DDL path", () => {
  const utils = readFileSync(
    resolve("node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/UtilsSQLite.java"),
    "utf8",
  );
  const capacitor = readFileSync(
    resolve("node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/CapacitorSQLite.java"),
    "utf8",
  );
  const database = readFileSync(
    resolve("node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite/SQLite/Database.java"),
    "utf8",
  );

  assert(utils.includes('stmts.split(";\\n")'), "v8.1.1 getStatementsArray delimiter changed");
  assert(utils.includes("concatRemoveEnd"), "v8.1.1 limited trigger reconstruction path absent");
  assert(capacitor.includes("uSqlite.getStatementsArray(statements)"), "execute no longer delegates to getStatementsArray");
  assert(database.includes("_db.execSQL(nCmd)"), "execute no longer reaches native execSQL");
  assert(database.includes("JSObject response = prepareSQL(statement, values, false, returnMode)"), "runSQL path changed");
  assert(database.includes("stmt.executeUpdateDelete()"), "run/prepareSQL non-INSERT path changed; reassess DDL transport");
});

await ok("G6B-SCHEMA-02 exact canonical schema SHA-256 is unchanged", () => {
  const digest = createHash("sha256").update(schema).digest("hex");
  assert(digest === CANONICAL_SCHEMA_SHA256, `schema hash drifted: ${digest}`);
});

await ok("G6B-SCHEMA-03 v8.1.1 batch splitter deterministically truncates canonical multi-statement triggers", () => {
  const pluginCommands = pluginV811GetStatementsArray(schema);
  const missionChunk = pluginCommands.find((command) => command.includes("CREATE TRIGGER trg_mission_bu"));
  assert(missionChunk, "plugin-split mission trigger chunk not found");
  assert(!/\bEND\b/.test(missionChunk), "plugin unexpectedly retained outer END with trg_mission_bu");
  assert(pluginCommands.some((command) => command.startsWith("SELECT RAISE") && command.includes("mission: name may not change")), "mission trigger second body arm was not split into a standalone command");

  const executed = runPython({ mode: "statements", statements: pluginCommands });
  assert(!executed.ok, "plugin-split canonical sequence unexpectedly executed as complete SQLite statements");
});

await ok("G6B-SCHEMA-04 canonical segmenter retains every trigger as one complete statement", () => {
  const triggers = statements.filter((statement) => statement.kind === "TRIGGER");
  assert(triggers.length === 44, `trigger segments=${triggers.length}`);
  for (const trigger of triggers) {
    assert(/\bBEGIN\b[\s\S]*\bEND;\s*$/i.test(trigger.sql), `${trigger.objectName} is truncated`);
  }

  const mission = statementOf(statements, "trg_mission_bu");
  const subject = statementOf(statements, "trg_subject_bu");
  const visit = statementOf(statements, "trg_visit_bu");
  const definitionInsert = statementOf(statements, "trg_def_bi");

  assert((mission.sql.match(/SELECT\s+RAISE/gi) ?? []).length === 3, "trg_mission_bu lost a body statement");
  assert((subject.sql.match(/SELECT\s+RAISE/gi) ?? []).length === 2, "trg_subject_bu lost a body statement");
  assert((visit.sql.match(/SELECT\s+RAISE/gi) ?? []).length >= 9, "trg_visit_bu body truncated");
  assert((definitionInsert.sql.match(/SELECT\s+RAISE/gi) ?? []).length >= 7, "trg_def_bi body truncated");
});

await ok("G6B-SCHEMA-05 corrected transport makes pinned plugin splitter an identity operation", () => {
  for (const statement of statements) {
    const transported = prepareCanonicalStatementForCapacitorExecute(statement.sql);
    const pluginCommands = pluginV811GetStatementsArray(transported);
    assert(pluginCommands.length === 1, `statement ${statement.index}/${statement.objectName ?? statement.kind} still split into ${pluginCommands.length}`);
  }

  const mission = prepareCanonicalStatementForCapacitorExecute(statementOf(statements, "trg_mission_bu").sql);
  const command = pluginV811GetStatementsArray(mission)[0];
  assert((command.match(/SELECT\s+RAISE/gi) ?? []).length === 3 && /\bEND;?$/.test(command), "transported trg_mission_bu was altered/truncated by plugin splitter");
});

await ok("G6B-SCHEMA-06 transported statements execute to exact canonical object-name sets", () => {
  const control = runPython({ mode: "script", schema });
  assert(control.ok && control.inventory, `control canonical executescript failed: ${control.error}`);

  const transported = statements.map((statement) => prepareCanonicalStatementForCapacitorExecute(statement.sql));
  const corrected = runPython({ mode: "statements", statements: transported });
  assert(corrected.ok && corrected.inventory, `segmented execution failed at ${corrected.failedIndex}: ${corrected.error}`);

  assert(JSON.stringify(corrected.inventory) === JSON.stringify(control.inventory), "segmented inventory differs from independent full-script inventory");
  assert(control.triggerSql && corrected.triggerSql, "trigger SQL inventory missing");
  const normalizeStored = (sql: string) => sql.replace(/\s+/g, " ").trim();
  for (const name of control.inventory.trigger) {
    assert(
      normalizeStored(corrected.triggerSql[name] ?? "") === normalizeStored(control.triggerSql[name] ?? ""),
      `stored trigger body differs from canonical control: ${name}`,
    );
  }
  assert(corrected.inventory.table.length === 15, `tables=${corrected.inventory.table.length}`);
  assert(corrected.inventory.trigger.length === 44, `triggers=${corrected.inventory.trigger.length}`);
  assert(corrected.inventory.view.length === 1, `views=${corrected.inventory.view.length}`);
  assert(corrected.inventory.index.length === 24, `indexes=${corrected.inventory.index.length}`);
});

await ok("G6B-SCHEMA-07 independent SQLite stores complete bodies for representative multi-statement triggers", () => {
  const transported = statements.map((statement) => prepareCanonicalStatementForCapacitorExecute(statement.sql));
  const corrected = runPython({ mode: "statements", statements: transported });
  assert(corrected.ok && corrected.triggerSql, `segmented execution failed: ${corrected.error}`);

  const mission = corrected.triggerSql.trg_mission_bu ?? "";
  const subject = corrected.triggerSql.trg_subject_bu ?? "";
  const visit = corrected.triggerSql.trg_visit_bu ?? "";
  const definitionInsert = corrected.triggerSql.trg_def_bi ?? "";

  assert((mission.match(/RAISE\s*\(/gi) ?? []).length === 3, "stored trg_mission_bu is incomplete");
  assert((subject.match(/RAISE\s*\(/gi) ?? []).length === 2, "stored trg_subject_bu is incomplete");
  assert((visit.match(/RAISE\s*\(/gi) ?? []).length >= 9, "stored trg_visit_bu is incomplete");
  assert((definitionInsert.match(/RAISE\s*\(/gi) ?? []).length >= 7, "stored trg_def_bi is incomplete");
});

await ok("G6B-SCHEMA-08 execution diagnostics identify stage/index/object/plugin error", async () => {
  const mission = statementOf(statements, "trg_mission_bu");
  let message = "";
  try {
    await executeCanonicalSchemaStatements({
      async execute(sql: string) {
        if (sql.includes("CREATE TRIGGER trg_mission_bu")) throw new Error("synthetic native execute failure");
        return { changes: { changes: 0 } };
      },
    }, schema);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  assert(message.includes("stage=execute_statement"), `stage absent: ${message}`);
  assert(message.includes(`statement_index=${mission.index}`), `statement index absent: ${message}`);
  assert(message.includes("object=trg_mission_bu"), `object name absent: ${message}`);
  assert(message.includes("plugin_error=synthetic native execute failure"), `plugin error absent: ${message}`);
});

console.log(`\nTOTAL: ${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
if (failures.length > 0) {
  console.log("RESULT: FAILURE");
  process.exitCode = 1;
} else {
  console.log("RESULT: SUCCESS (0 failures)");
}
