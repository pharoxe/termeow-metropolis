import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";
import App from "./App";
import { WalletProviders } from "./auth/WalletProviders";
import { WorkspaceFeatures } from "./features/WorkspaceFeatures";
import { NotificationProvider } from "./components/NotificationSystem";
import { TermeowAgentProvider } from "./features/voice-agent";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { Buffer } from "buffer/";

// Privy's embedded-wallet bridge still references the Node Buffer global in a few browser paths.
if (typeof Reflect.get(globalThis, "Buffer") !== "function") {
  Reflect.set(globalThis, "Buffer", Buffer);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AppErrorBoundary><NotificationProvider><WalletProviders><WorkspaceFeatures><TermeowAgentProvider><App /></TermeowAgentProvider></WorkspaceFeatures></WalletProviders></NotificationProvider></AppErrorBoundary>
    </BrowserRouter>
  </StrictMode>
);
