import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import App from "./App";
import { WalletProviders } from "./auth/WalletProviders";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WalletProviders><App /></WalletProviders>
    </BrowserRouter>
  </StrictMode>
);
