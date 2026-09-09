import { describe, expect, it } from "vitest";
import { fromAtomic, toAtomic } from "./SpotTradeTicket";

describe("spot trade atomic amounts", () => {
  it("converts user-entered values without floating point rounding", () => {
    expect(toAtomic("25.123456", 6)).toBe("25123456");
    expect(toAtomic("0.000000001", 9)).toBe("1");
    expect(toAtomic("1.999", 2)).toBe("199");
    expect(toAtomic("nope", 6)).toBe("0");
  });

  it("formats atomic quote outputs compactly", () => {
    expect(fromAtomic("25123456", 6)).toBe("25.123456");
    expect(fromAtomic("1000000", 6)).toBe("1");
    expect(fromAtomic("42", 0)).toBe("42");
    expect(fromAtomic(null, 6)).toBe("—");
  });
});
