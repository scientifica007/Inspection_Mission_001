import schemaSql from "../../docs/schema/schema.sql?raw";
import bootstrapText from "../../bootstrap/v1/checklist-v1.json?raw";
import packageText from "../../package.json?raw";
import { parseArtifact, type BootstrapArtifact } from "../bootstrap/artifact.ts";

export const CANONICAL_SCHEMA_SQL = schemaSql;
export const CANONICAL_BOOTSTRAP_TEXT = bootstrapText;
export const CANONICAL_BOOTSTRAP: BootstrapArtifact = parseArtifact(bootstrapText);

const pkg = JSON.parse(packageText) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

export const GATE6B_PACKAGE_VERSIONS = {
  capacitorCore: pkg.dependencies["@capacitor/core"],
  capacitorAndroid: pkg.dependencies["@capacitor/android"],
  sqlitePlugin: pkg.dependencies["@capacitor-community/sqlite"],
  react: pkg.dependencies.react,
  vite: pkg.devDependencies.vite,
  typescript: pkg.devDependencies.typescript,
} as const;
