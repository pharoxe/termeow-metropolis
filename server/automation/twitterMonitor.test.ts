import { describe, expect, it } from "vitest";
import { contractAddresses } from "./twitterMonitor.js";

describe("X launch contract extraction", () => {
  it("extracts only exact EVM contracts on Monad", () => {
    expect(contractAddresses("CA 0x1111111111111111111111111111111111111111 now", "monad")).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(contractAddresses("not 0x1234", "monad")).toEqual([]);
  });

  it("ignores Solana base58 contracts", () => {
    expect(contractAddresses("launch 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", "monad")).toEqual([]);
  });
});
