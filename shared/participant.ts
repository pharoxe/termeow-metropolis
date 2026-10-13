import type {Chain} from './wire';
export type ParticipantSnapshot={chain:Chain;wallet:string;checkedAt:number|null;attemptedAt:number|null;nextCheckAt:number;status:'queued'|'checking'|'fresh'|'partial'|'unavailable'|'error';balanceUsd:number|null;balanceComplete:boolean;handle:string|null;followers:number|null;protocol:'smart'|'other'|'unknown';socialOwnership:'unverified';error:string|null};
