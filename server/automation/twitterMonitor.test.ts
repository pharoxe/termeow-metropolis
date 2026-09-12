import { describe, expect, it } from "vitest";
import { contractAddresses } from "./twitterMonitor.js";

describe("X launch contract extraction", () => {
  it("extracts only exact EVM contracts on Robinhood", () => {
    expect(contractAddresses("CA 0x1111111111111111111111111111111111111111 now", "robinhood")).toEqual(["0x1111111111111111111111111111111111111111"]);
    expect(contractAddresses("not 0x1234", "robinhood")).toEqual([]);
  });

  it("extracts a Solana base58 contract", () => {
    expect(contractAddresses("launch 9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump", "solana")).toEqual(["9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump"]);
  });
});
