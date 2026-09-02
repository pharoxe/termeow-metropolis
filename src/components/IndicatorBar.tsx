import type { IndicatorSet } from "./MarketChart";

export function IndicatorBar({ value, onChange }: { value: IndicatorSet; onChange: (next: IndicatorSet) => void }) {
  const groups: Array<[string, Array<keyof IndicatorSet>]> = [
    ["ON PRICE", ["ema", "bollinger", "vwap", "sr", "volume"]],
    ["SUB-PANE", ["cvd", "rsi", "macd", "obv"]]
  ];
  return (
    <div className="indicator-bar">
      {groups.map(([label, keys]) => <span className="indicator-group" key={label}><small>{label}</small>{keys.map((key) => (
          <button key={key} className={value[key] ? "active" : ""} onClick={() => onChange({ ...value, [key]: !value[key] })}>
            {key === "bollinger" ? "BOLL" : key.toUpperCase()}
          </button>
        ))}</span>)}
      <span className="deferred">PRICE · VOLUME · MOMENTUM</span>
    </div>
  );
}
