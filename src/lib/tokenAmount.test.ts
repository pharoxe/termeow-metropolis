import { expect, it } from "vitest";
import { tokenAmount } from "./tokenAmount";
it("converts arbitrary mint decimals exactly", () => {
  expect(tokenAmount("25", 9)).toBe("25000000000");
  expect(tokenAmount("25", 2)).toBe("2500");
  expect(tokenAmount("1.123456", 6)).toBe("1123456");
  expect(tokenAmount("9007199254.740993", 6)).toBe("9007199254740993");
  expect(tokenAmount("1.000", 0)).toBe("1");
});
it("rejects rounding, invalid quantities and overflow", () => {
  for (const value of ["0", "-1", "1e3", "NaN", "1.0000001", "18446744073709551616"]) expect(() => tokenAmount(value, 6)).toThrow();
});
