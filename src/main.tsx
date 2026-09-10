import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { gate6cRestoredResultCoordinator } from "./device/evidence-restored-result.ts";
import "./gate6c/device-integration-proof.ts";
import { Gate6BProofApp } from "./ui/Gate6BProofApp.tsx";
import "./ui/gate6b.css";

if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") {
  void gate6cRestoredResultCoordinator.start().catch((error) => {
    console.error("Gate 6C restored-result listener registration failed", error instanceof Error ? error.message : String(error));
  });
}

const root = document.getElementById("root");
if (root === null) throw new Error("root element missing");

createRoot(root).render(
  <StrictMode>
    <Gate6BProofApp />
  </StrictMode>,
);
