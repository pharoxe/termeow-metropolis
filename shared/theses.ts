import type {Chain} from './wire';
export const THESIS_WINDOWS={'1h':3600000,'6h':21600000,'24h':86400000,'7d':604800000} as const;
export type ThesisWindow=keyof typeof THESIS_WINDOWS;
export type TokenThesis={source:'fomoscan';id:string;chain:Chain;token:string;authorId:string|null;authorHandle:string|null;text:string;createdAt:number;observedAt:number;deletedAt:number|null;url:string|null};
export type ThesisSummary={chain:Chain;token:string;window:ThesisWindow;count:number|null;previousCount:number|null;change:number|null;ratePerHour:number|null;rateChange:number|null;percentChange:number|null;uniqueAuthors:number|null;unknownAuthors:number;observedAt:number|null;coverageFrom:number|null;completeCurrentWindow:boolean;completePreviousWindow:boolean;status:'disconnected'|'warming'|'partial'|'ready'|'stale';error:string|null;source:'fomoscan';deletionCoverage:'unavailable';items:TokenThesis[];nextCursor:string|null};
