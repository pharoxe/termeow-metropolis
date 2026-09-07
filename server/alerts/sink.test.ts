import { describe, expect, it } from "vitest";
import type { LaunchRow } from "../../shared/wire.js";
import { AlertSink, type AlertEvent } from "./sink.js";
import fixture from "./__fixtures__/launches-and-fills.json";

const row = fixture.tokens[0].launch as LaunchRow;

describe("AlertSink", () => {
  it("delivers launch, graduation and fill events synchronously to every listener", () => {
    const sink = new AlertSink(() => undefined);
    const seen: AlertEvent[] = [];
    const off = sink.subscribe((event) => seen.push(event));
    sink.launch(row);
    sink.graduation(row, 123);
    expect(seen.map((event) => event.kind)).toEqual(["launch", "graduation"]);
    off();
    sink.launch(row);
    expect(seen).toHaveLength(2);
  });

  it("a throwing listener is counted and logged and never reaches the producer", () => {
    const logs: string[] = [];
    const sink = new AlertSink((msg) => logs.push(msg));
    sink.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => sink.launch(row)).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("boom");
  });
});
