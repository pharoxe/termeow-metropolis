import type { FlowPrint, TraderKind } from '../../shared/wire.js';
export type AttributionLookup = {
  peekKind(wallet:string):TraderKind|null;
  handles:{get(wallet:string):{handle:string;followers:number|null}|null|undefined};
};
/** Attach previously established wallet labels (Nansen / watchlist) before archive normalization. */
export function mapKnownAttribution(print:FlowPrint, lookup:AttributionLookup):FlowPrint {
  if(print.chain!=='monad'||!print.trader?.address)return print;
  const wallet=print.trader.address.toLowerCase();
  const kind=lookup.peekKind(wallet);
  const social=lookup.handles.get(wallet);
  return {...print,trader:{...print.trader,address:wallet,kind:kind??print.trader.kind,handle:social?.handle??print.trader.handle,followers:social?.followers??print.trader.followers}};
}
