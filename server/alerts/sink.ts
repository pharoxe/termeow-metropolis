import type { LaunchRow } from "../../shared/wire.js";
import type { TraderFill } from "../traders/walletStats.js";

/**
 * The three seams the alert engine listens on, as plain synchronous calls: a launch row first carrying a chain source
 * (LaunchIndex.upsert), a graduation applied to a known row (LaunchIndex.recordGraduation) and a fill the book accepted
 * (TraderService.record / recordTransferFills). No timer, no queue: an event is delivered on the producer's own tick.
 * A listener that throws is counted and logged; it never breaks the producer.
 */
export type LaunchEvent = { kind: "launch"; row: LaunchRow };
export type GraduationEvent = { kind: "graduation"; row: LaunchRow; at: number };
export type FillEvent = { kind: "fill"; fill: TraderFill };
export type AlertEvent = LaunchEvent | GraduationEvent | FillEvent;
export type AlertListener = (event: AlertEvent) => void;

/** What producers call; the launch index subclass and the trader service hold this shape, never the engine. */
export type AlertSinkLike = {
  fill(fill: TraderFill): void;
  launch(row: LaunchRow): void;
  graduation(row: LaunchRow, at: number): void;
};

export class AlertSink implements AlertSinkLike {
  private readonly listeners = new Set<AlertListener>();

  constructor(private readonly log: (msg: string) => void = (msg) => console.warn(msg)) {}

  /** Returns the unsubscribe function. */
  subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  fill(fill: TraderFill): void {
    this.emit({ kind: "fill", fill });
  }

  launch(row: LaunchRow): void {
    this.emit({ kind: "launch", row });
  }

  graduation(row: LaunchRow, at: number): void {
    this.emit({ kind: "graduation", row, at });
  }

  private emit(event: AlertEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(`alert sink: listener failed on ${event.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** The process-wide sink the hooks in traders/service.ts and launch/service.ts write to. */
export const alertSink = new AlertSink();
