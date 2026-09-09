import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.scientifica.inspection.gate6bproof",
  appName: "Gate 6B Device Proof",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
};

export default config;
