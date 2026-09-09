export interface CanonicalSchemaStatement {
  index: number;
  sql: string;
  kind: "PRAGMA" | "TABLE" | "INDEX" | "TRIGGER" | "VIEW" | "OTHER";
  objectName: string | null;
}

export interface CanonicalSchemaExecuteConnection {
  execute(statements: string, transaction?: boolean): Promise<unknown>;
}

type LexState = "NORMAL" | "SINGLE" | "DOUBLE" | "BACKTICK" | "BRACKET" | "LINE_COMMENT" | "BLOCK_COMMENT";

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

function statementMetadata(sql: string): Pick<CanonicalSchemaStatement, "kind" | "objectName"> {
  const code = stripSqlComments(sql).trim();

  let match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
  if (match) return { kind: "TABLE", objectName: match[1] };

  match = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
  if (match) return { kind: "INDEX", objectName: match[1] };

  match = /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
  if (match) return { kind: "TRIGGER", objectName: match[1] };

  match = /^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(code);
  if (match) return { kind: "VIEW", objectName: match[1] };

  if (/^PRAGMA\b/i.test(code)) return { kind: "PRAGMA", objectName: null };
  return { kind: "OTHER", objectName: null };
}

function hasExecutableSql(fragment: string): boolean {
  return stripSqlComments(fragment).trim().length > 0;
}

/**
 * Narrow lexical segmenter for docs/schema/schema.sql.
 *
 * Ordinary SQLite statements terminate at the first semicolon outside quoted
 * strings/comments. CREATE TRIGGER statements remain whole until their outer
 * BEGIN ... END; terminator. CASE ... END expressions inside trigger bodies
 * are depth-tracked so they cannot be mistaken for the trigger's outer END.
 */
export function segmentCanonicalSchema(sql: string): CanonicalSchemaStatement[] {
  const statements: CanonicalSchemaStatement[] = [];
  let start = 0;
  let state: LexState = "NORMAL";
  let token = "";
  let leadingTokens: string[] = [];
  let isTrigger = false;
  let triggerBodyStarted = false;
  let triggerOuterEndSeen = false;
  let caseDepth = 0;

  const resetStatementState = () => {
    token = "";
    leadingTokens = [];
    isTrigger = false;
    triggerBodyStarted = false;
    triggerOuterEndSeen = false;
    caseDepth = 0;
  };

  const finishToken = () => {
    if (!token) return;
    const upper = token.toUpperCase();
    if (leadingTokens.length < 4) leadingTokens.push(upper);

    if (!isTrigger && leadingTokens.length >= 2 && leadingTokens[0] === "CREATE" && leadingTokens[1] === "TRIGGER") {
      isTrigger = true;
    }

    if (isTrigger) {
      if (!triggerBodyStarted && upper === "BEGIN") {
        triggerBodyStarted = true;
      } else if (triggerBodyStarted) {
        if (upper === "CASE") {
          caseDepth += 1;
        } else if (upper === "END") {
          if (caseDepth > 0) caseDepth -= 1;
          else triggerOuterEndSeen = true;
        }
      }
    }
    token = "";
  };

  const emit = (endExclusive: number) => {
    const raw = sql.slice(start, endExclusive).trim();
    if (hasExecutableSql(raw)) {
      const metadata = statementMetadata(raw);
      statements.push({ index: statements.length, sql: raw, ...metadata });
    }
    start = endExclusive;
    resetStatementState();
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (state === "LINE_COMMENT") {
      if (ch === "\n") state = "NORMAL";
      continue;
    }
    if (state === "BLOCK_COMMENT") {
      if (ch === "*" && next === "/") {
        state = "NORMAL";
        i += 1;
      }
      continue;
    }
    if (state === "SINGLE") {
      if (ch === "'" && next === "'") i += 1;
      else if (ch === "'") state = "NORMAL";
      continue;
    }
    if (state === "DOUBLE") {
      if (ch === '"' && next === '"') i += 1;
      else if (ch === '"') state = "NORMAL";
      continue;
    }
    if (state === "BACKTICK") {
      if (ch === "`" && next === "`") i += 1;
      else if (ch === "`") state = "NORMAL";
      continue;
    }
    if (state === "BRACKET") {
      if (ch === "]") state = "NORMAL";
      continue;
    }

    if (ch === "-" && next === "-") {
      finishToken();
      state = "LINE_COMMENT";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      finishToken();
      state = "BLOCK_COMMENT";
      i += 1;
      continue;
    }
    if (ch === "'") {
      finishToken();
      state = "SINGLE";
      continue;
    }
    if (ch === '"') {
      finishToken();
      state = "DOUBLE";
      continue;
    }
    if (ch === "`") {
      finishToken();
      state = "BACKTICK";
      continue;
    }
    if (ch === "[") {
      finishToken();
      state = "BRACKET";
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      token += ch;
      continue;
    }

    finishToken();
    if (ch === ";" && (!isTrigger || (triggerBodyStarted && triggerOuterEndSeen))) {
      emit(i + 1);
    }
  }

  finishToken();
  const tail = sql.slice(start);
  if (hasExecutableSql(tail)) {
    throw new Error("Canonical schema segmentation failed: unterminated final SQL statement");
  }

  return statements;
}

/**
 * @capacitor-community/sqlite v8.1.1 Android splits execute() input on the
 * literal delimiter `;\n`. For one already-complete statement, insert a single
 * space between a statement semicolon and a following newline (outside quoted
 * strings/comments). SQLite semantics are unchanged, line comments retain
 * their newline boundary, and the plugin's batch splitter becomes an identity
 * operation before its Database.execute() reaches native execSQL().
 */
export function prepareCanonicalStatementForCapacitorExecute(statement: string): string {
  let out = "";
  let state: LexState = "NORMAL";

  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    const next = statement[i + 1];

    if (state === "LINE_COMMENT") {
      out += ch;
      if (ch === "\n") state = "NORMAL";
      continue;
    }
    if (state === "BLOCK_COMMENT") {
      out += ch;
      if (ch === "*" && next === "/") {
        out += next;
        state = "NORMAL";
        i += 1;
      }
      continue;
    }
    if (state === "SINGLE") {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 1;
      } else if (ch === "'") state = "NORMAL";
      continue;
    }
    if (state === "DOUBLE") {
      out += ch;
      if (ch === '"' && next === '"') {
        out += next;
        i += 1;
      } else if (ch === '"') state = "NORMAL";
      continue;
    }
    if (state === "BACKTICK") {
      out += ch;
      if (ch === "`" && next === "`") {
        out += next;
        i += 1;
      } else if (ch === "`") state = "NORMAL";
      continue;
    }
    if (state === "BRACKET") {
      out += ch;
      if (ch === "]") state = "NORMAL";
      continue;
    }

    if (ch === "-" && next === "-") {
      out += ch + next;
      state = "LINE_COMMENT";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      out += ch + next;
      state = "BLOCK_COMMENT";
      i += 1;
      continue;
    }
    if (ch === "'") state = "SINGLE";
    else if (ch === '"') state = "DOUBLE";
    else if (ch === "`") state = "BACKTICK";
    else if (ch === "[") state = "BRACKET";

    out += ch;
    if (state === "NORMAL" && ch === ";" && next === "\n") out += " ";
    if (state === "NORMAL" && ch === ";" && next === "\r" && statement[i + 2] === "\n") out += " ";
  }

  return out;
}

export class CanonicalSchemaExecutionError extends Error {
  readonly stage = "execute_statement";
  readonly statementIndex: number;
  readonly objectName: string | null;
  readonly statementKind: CanonicalSchemaStatement["kind"];
  readonly pluginErrorText: string;

  constructor(statement: CanonicalSchemaStatement, cause: unknown) {
    const pluginErrorText = cause instanceof Error ? cause.message : String(cause);
    const objectLabel = statement.objectName ?? statement.kind;
    super(`stage=execute_statement; statement_index=${statement.index}; object=${objectLabel}; plugin_error=${pluginErrorText}`);
    this.name = "CanonicalSchemaExecutionError";
    this.statementIndex = statement.index;
    this.objectName = statement.objectName;
    this.statementKind = statement.kind;
    this.pluginErrorText = pluginErrorText;
  }
}

export async function executeCanonicalSchemaStatements(
  connection: CanonicalSchemaExecuteConnection,
  canonicalSql: string,
): Promise<unknown> {
  const statements = segmentCanonicalSchema(canonicalSql);
  let lastResult: unknown;

  for (const statement of statements) {
    const transportSql = prepareCanonicalStatementForCapacitorExecute(statement.sql);
    if (/;\r?\n/.test(transportSql)) {
      throw new Error(`Canonical schema transport invariant failed at statement ${statement.index}`);
    }
    try {
      lastResult = await connection.execute(transportSql, false);
    } catch (error) {
      throw new CanonicalSchemaExecutionError(statement, error);
    }
  }

  return lastResult;
}

/**
 * Returns the same native connection behind a narrow Proxy. Only execute()
 * invoked with the byte-for-byte canonical schema asset is intercepted. All
 * other methods/calls are bound directly to the underlying SQLiteDBConnection,
 * preserving the existing Gate-6B adapter and transaction behavior.
 */
export function withCanonicalSchemaExecution<T extends object>(connection: T, canonicalSql: string): T {
  const executable = connection as T & CanonicalSchemaExecuteConnection;
  const nativeExecute = executable.execute.bind(connection);

  return new Proxy(connection, {
    get(target, property) {
      if (property === "execute") {
        return async (statements: string, transaction?: boolean): Promise<unknown> => {
          if (statements === canonicalSql) {
            if (transaction !== false) {
              throw new Error("Canonical schema execution requires transaction=false to preserve Gate 6B bootstrap semantics");
            }
            return executeCanonicalSchemaStatements({ execute: nativeExecute }, canonicalSql);
          }
          return nativeExecute(statements, transaction);
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
