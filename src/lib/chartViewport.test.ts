import { expect, it } from "vitest";
import { rebaseViewport, zoomViewport } from "./chartViewport";
const candles = (times: number[]) => times.map(time => ({time}));
it("keeps historical candles in view when older history arrives", () => {
 expect(rebaseViewport({from:0,to:1},candles([3,4,5,6]),candles([1,2,3,4,5,6]))).toEqual({from:2,to:3});
});
it("keeps the live edge following newly appended candles", () => {
 expect(rebaseViewport({from:1,to:5},candles([1,2,3,4]),candles([1,2,3,4,5]))).toEqual({from:2,to:6});
});
it("retains historical position when a rolling window drops old candles", () => {
 expect(rebaseViewport({from:1,to:2},candles([1,2,3,4,5]),candles([2,3,4,5,6]))).toEqual({from:0,to:1});
});
it("zooms around the center with usable minimum and maximum widths", () => {
 expect(zoomViewport({from:0,to:100},0.5)).toEqual({from:25,to:75});
 expect(zoomViewport({from:0,to:5},0.1).to).toBe(5);
});
