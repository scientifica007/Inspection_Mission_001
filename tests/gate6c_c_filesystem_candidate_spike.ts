import fs from "node:fs";

type Lockfile = {
  packages?: Record<string, { dependencies?: Record<string, string> }>;
};

type Manifest = {
  dependencies?: Record<string, string>;
};

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

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as Manifest;
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8")) as Lockfile;
const rootLockDependencies = lock.packages?.[""]?.dependencies ?? {};
const lockPackages = lock.packages ?? {};

check(
  "G6C-C-FS01 rejected Filesystem dependency absent from manifest",
  manifest.dependencies?.["@capacitor/filesystem"] === undefined,
  "@capacitor/filesystem is not a production dependency",
);
check(
  "G6C-C-FS02 rejected Filesystem dependency absent from lock root",
  rootLockDependencies["@capacitor/filesystem"] === undefined,
  "package-lock root dependency set excludes @capacitor/filesystem",
);
check(
  "G6C-C-FS03 rejected Filesystem package absent from lock graph",
  lockPackages["node_modules/@capacitor/filesystem"] === undefined,
  "package-lock contains no @capacitor/filesystem package node",
);
check(
  "G6C-C-FS04 Filesystem-only synapse transitive remnant absent",
  lockPackages["node_modules/@capacitor/synapse"] === undefined,
  "package-lock contains no @capacitor/synapse remnant",
);

console.log("DISPOSITION: FILESYSTEM_PLUGIN_REJECTED_FOR_EVIDENCE_STORAGE");
console.log("RATIONALE: the official Filesystem candidate was not adopted because its exposed API did not provide sufficient executable evidence for the full Gate-6C EvidenceStorage publication contract required by the project, while the qualified narrow Android adapter proved the complete supported contract on API24/API35.");
console.log("SCOPE: this is a project selection result, not a claim that the Filesystem plugin is intrinsically unsafe and not a claim that Gate 6C-A requires a primitive-level RENAME_NOREPLACE operation.");
console.log(`Gate 6C-C Filesystem rejection guard: ${passed} passed, ${failed} failed`);
if (failed !== 0) process.exitCode = 1;
