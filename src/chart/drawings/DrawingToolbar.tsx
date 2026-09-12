import { TOOLS, type Tool } from "./state";
import "./drawings.css";

export type DrawingToolbarProps = {
  tool: Tool | null;
  onTool: (tool: Tool | null) => void;
  onClear: () => void;
  /** Number of drawings on the current instrument (from the attachDrawings snapshot). */
  count: number;
};

const LABELS: Record<Tool, string> = { hline: "H-LINE", trendline: "TREND", fib: "FIB", marker_up: "▲", marker_down: "▼", measure: "MEASURE" };
const HINTS: Record<Tool, string> = {
  hline: "Horizontal price level — click to place",
  trendline: "Trendline — drag or click two points",
  fib: "Fibonacci retracement — drag from swing low to high",
  marker_up: "Bullish symbol — click to place",
  marker_down: "Bearish symbol — click to place",
  measure: "Measure — drag or click two points"
};

export function DrawingToolbar({ tool, onTool, onClear, count }: DrawingToolbarProps) {
  return (
    <div className="drawing-toolbar" role="toolbar" aria-label="Chart drawings">
      {TOOLS.map((t) => (
        <button key={t} type="button" className={tool === t ? "on" : undefined} aria-pressed={tool === t} title={`${HINTS[t]} (Esc cancels, Del removes selected)`} onClick={() => onTool(tool === t ? null : t)}>
          {LABELS[t]}
        </button>
      ))}
      <button type="button" className="drawing-clear" disabled={count === 0} title="Remove every drawing on this instrument" onClick={onClear}>
        CLEAR{count > 0 ? <b>{count}</b> : null}
      </button>
    </div>
  );
}
