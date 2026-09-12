import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from "react";

type State = { error?: string };

export class AppErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : "The terminal encountered an unexpected wallet error." };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Terminal UI recovered from an uncaught error", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="terminal-fatal" role="alert">
      <b>TERMINAL RECOVERY</b>
      <p>A wallet window failed without submitting a transaction. Reload the terminal and try again.</p>
      <small>{this.state.error}</small>
      <button type="button" onClick={() => window.location.reload()}>RELOAD TERMINAL</button>
    </main>;
  }
}
