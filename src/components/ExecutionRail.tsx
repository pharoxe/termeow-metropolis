import { useEffect, useState } from "react";
import type { MarketResponse } from "../../shared/wire";
import type { OnchainMarket, PublicConfig } from "../types";
import type { InstrumentRef } from "../lib/address";
import { money, shortAddress } from "../lib/format";
import { instrumentLabel } from "../lib/instrument";
import { mcapScale } from "../lib/mcap";
import { FeatureSection } from "../features/WorkspaceFeatures";
import { AuditChips, ResearchPanel } from "./DeskPanels";
import { SpotTradeTicket } from "./SpotTradeTicket";
import { RobinhoodTradeTicket } from "./RobinhoodTradeTicket";

function TokenIcon({ symbol, src }: { symbol: string; src: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`asset-icon${src && !failed ? " has-image" : ""}`}>{src && !failed ? <img src={src} alt="" onError={() => setFailed(true)} /> : (symbol || "T").slice(0, 1)}</span>;
}

type Props = {
  instrument: InstrumentRef;
  feed: MarketResponse | null;
  legacy: OnchainMarket | null;
  iconUrl: string | null;
  config: PublicConfig;
};

/** Instrument slab + execution + project information; the ticket follows the token's chain, not the wallet toggle. */
export function ExecutionRail({ instrument, feed, legacy, iconUrl, config }: Props) {
  const solana = instrument.chain === "solana";
  const label = instrumentLabel(instrument.chain);
  const execution = solana
    ? <SpotTradeTicket key={instrument.address} config={config} mint={instrument.address} symbol={feed?.instrument.symbol || "TOKEN"} />
    : <RobinhoodTradeTicket key={instrument.address} config={config} token={instrument.address} symbol={(feed?.instrument.symbol || "TOKEN").toUpperCase()} />;
  if (!feed) {
    return (
      <>
        <div className="instrument-slab">
          <div><span className="asset-icon">…</span><span><b>LOADING {shortAddress(instrument.address)}</b><small>{instrument.address} · {label}</small></span></div>
        </div>
        <FeatureSection id="execution" className="trade-execution-section">{execution}</FeatureSection>
        <FeatureSection id="research"><section className="panel project-info-panel"><div className="ph"><span className="pt">PROJECT INFORMATION</span><span className="pm">LOADING</span></div><p className="empty-copy">Fetching project information for this contract.</p></section></FeatureSection>
      </>
    );
  }
  const scale = mcapScale(feed);
  const { symbol, name } = feed.instrument;
  return (
    <>
      <div className="instrument-slab">
        <div>
          <TokenIcon symbol={symbol} src={iconUrl} />
          <span>
            <b className={scale.source ? "mcap-value" : ""}>{scale.source ? money(scale.mcap, true) : money(feed.priceUsd)}</b>
            <small>{symbol}/USD {scale.source ? money(feed.priceUsd) : ""} · {name} · {label}</small>
            {solana && legacy ? <AuditChips market={legacy} /> : null}
          </span>
        </div>
      </div>
      <FeatureSection id="execution" className="trade-execution-section">{execution}</FeatureSection>
      <FeatureSection id="research"><ResearchPanel market={feed} /></FeatureSection>
    </>
  );
}
