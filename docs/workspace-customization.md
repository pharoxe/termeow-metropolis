# Workspace customization

`src/features/WorkspaceFeatures.tsx` owns the feature registry, onboarding dialog,
and browser-local preferences. First successful Solana wallet or Privy sign-in
opens onboarding if preferences have not been saved. Customize opens the same
picker without requiring a wallet.

To add a feature, add an ID, title, and description to `FEATURES`, then wrap its
panel in `<FeatureSection id="your-id">`. It appears automatically in onboarding.
New features begin collapsed for existing users until selected. Choices change
initial panel visibility only; they do not authorize transactions or remove access.
Preferences currently belong to this browser, not a server-side user account.

Home Video is bundled locally under CC0 and is the primary data font. Silkscreen
remains the display face for headings, navigation, and buttons. Home Video Bold
is reserved for live-feed tickers, Symbol/Signal tickers, and market-cap/FDV
figures. The OpenType files live in `public/fonts/`; matching `@font-face`
declarations and fallbacks are defined in `src/styles.css`.
