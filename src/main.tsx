import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gate6BProofApp } from "./ui/Gate6BProofApp.tsx";
import "./ui/gate6b.css";

const root = document.getElementById("root");
if (root === null) throw new Error("root element missing");

createRoot(root).render(
  <StrictMode>
    <Gate6BProofApp />
  </StrictMode>,
);
