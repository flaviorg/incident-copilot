// Entrada da War Room (spec 10.2): monta o App em modo demo, que busca as gravações em ./demo/.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";

const root = document.getElementById("root");
if (!root) throw new Error("elemento #root ausente no index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
