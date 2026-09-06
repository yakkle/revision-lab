import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./runtime/test-hook";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Revision Lab root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
