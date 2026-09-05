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

IBM Plex Mono is bundled for consistent rendering across platforms and zoom levels.
After obtaining the appropriate Proto Mono webfont license, place its WOFF2 in
`public/fonts/`, add an `@font-face` declaration in `src/styles.css`, and replace
the IBM Plex Mono family declarations.
