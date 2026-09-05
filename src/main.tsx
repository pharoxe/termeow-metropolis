import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import App from "./App";
import { WalletProviders } from "./auth/WalletProviders";
import { WorkspaceFeatures } from "./features/WorkspaceFeatures";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProviders><WorkspaceFeatures><App /></WorkspaceFeatures></WalletProviders>
    </BrowserRouter>
  </StrictMode>
);
