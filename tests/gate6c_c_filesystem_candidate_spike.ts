import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}: ${detail}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}: ${detail}`);
  }
}

function findFile(root: string, basename: string): string | null {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === basename) return full;
    }
  }
  return null;
}

function interfaceBlock(text: string, name: string): string {
  const marker = `export interface ${name}`;
  const start = text.indexOf(marker);
  if (start < 0) return "";
  const next = text.indexOf("\nexport interface ", start + marker.length);
  return text.slice(start, next < 0 ? text.length : next);
}

const root = path.resolve("node_modules/@capacitor/filesystem");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
const pluginPath = findFile(root, "FilesystemPlugin.kt");
const definitionsPath = findFile(root, "definitions.d.ts");

check("G6C-C-FS01 exact candidate version", packageJson.version === "8.1.3", `version=${String(packageJson.version)}`);
check("G6C-C-FS02 Android implementation source present", pluginPath !== null, String(pluginPath));
check("G6C-C-FS03 public TypeScript definitions present", definitionsPath !== null, String(definitionsPath));

if (pluginPath !== null && definitionsPath !== null) {
  const android = fs.readFileSync(pluginPath, "utf8");
  const definitions = fs.readFileSync(definitionsPath, "utf8");
  const copy = interfaceBlock(definitions, "CopyOptions");
  const rename = interfaceBlock(definitions, "RenameOptions");

  check(
    "G6C-C-FS04 candidate copy delegates to opaque controller operation",
    android.includes("controller.copy(source, destination)"),
    "FilesystemPlugin.copy delegates source/destination to controller.copy",
  );
  check(
    "G6C-C-FS05 candidate rename delegates to opaque controller operation",
    android.includes("controller.move(source, destination)"),
    "FilesystemPlugin.rename delegates source/destination to controller.move",
  );
  check("G6C-C-FS06 CopyOptions found", copy.length > 0, "public CopyOptions extracted");
  check("G6C-C-FS07 RenameOptions found", rename.length > 0, "public RenameOptions extracted");

  const noReplaceVocabulary = /noReplace|failIfExists|replaceExisting|atomicMove|createNew/i;
  const copyCanExpressNoReplace = noReplaceVocabulary.test(copy);
  const renameCanExpressNoReplace = noReplaceVocabulary.test(rename);
  check(
    "G6C-C-FS08 copy cannot express primitive-level no-replace policy",
    !copyCanExpressNoReplace,
    copy.replace(/\s+/g, " ").slice(0, 400),
  );
  check(
    "G6C-C-FS09 rename cannot express primitive-level no-replace policy",
    !renameCanExpressNoReplace,
    rename.replace(/\s+/g, " ").slice(0, 400),
  );

  const fullContractProvable = copyCanExpressNoReplace || renameCanExpressNoReplace;
  check(
    "G6C-C-FS10 full EvidenceStorage publication contract is not provable through candidate API",
    !fullContractProvable,
    "no public no-replace primitive is exposed; API names alone cannot prove required publication semantics",
  );

  if (!fullContractProvable) {
    console.log("DISPOSITION: FILESYSTEM_PLUGIN_REJECTED_FOR_EVIDENCE_STORAGE");
    console.log("RATIONALE: Gate 6C-C requires proven content-source bounded-memory persistence AND primitive-level complete no-replace publication. The installed Filesystem 8.1.3 API cannot express the latter, so the conjunction cannot be proved and the candidate must not be adopted for EvidenceStorage.");
  }
}

console.log(`Gate 6C-C Filesystem candidate spike: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
