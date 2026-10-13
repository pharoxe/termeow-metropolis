import { describe, expect, it } from "vitest";
import { SmartWalletClassifier } from "./identity.js";

const TRACKED = "0x06de9c48b1e639ed5c13ec8fbd4080a38e39f2d1";
const UNTRACKED = "0x0a6ebed0155edb4b21d92ad02897a626cd90119e";

function lookup(tracked: string[] = [TRACKED]) {
  const set = new Set(tracked);
  return { set, isTracked: (address: string) => set.has(address.trim().toLowerCase()) };
}

describe("SmartWalletClassifier", () => {
  it("answers smart for a tracked wallet and other otherwise, case-insensitively and without any RPC", async () => {
    const classifier = new SmartWalletClassifier(lookup());
    await expect(classifier.classify(TRACKED.toUpperCase().replace("0X", "0x"))).resolves.toBe("smart");
    await expect(classifier.classify(UNTRACKED)).resolves.toBe("other");
    expect(classifier.stats()).toEqual({ smart: 1, other: 1, failures: 0, lastError: null });
  });

  it("re-checks an untracked wallet once the book learns it", async () => {
    const book = lookup([]);
    const classifier = new SmartWalletClassifier(book);
    await expect(classifier.classify(UNTRACKED)).resolves.toBe("other");
    expect(classifier.peek(UNTRACKED)).toBeUndefined();
    book.set.add(UNTRACKED);
    await expect(classifier.classify(UNTRACKED)).resolves.toBe("smart");
    expect(classifier.peek(UNTRACKED)).toBe("smart");
  });

  it("returns null and counts a failure for a non-address", async () => {
    const classifier = new SmartWalletClassifier(lookup());
    await expect(classifier.classify("not-a-wallet")).resolves.toBeNull();
    expect(classifier.stats()).toMatchObject({ failures: 1, lastError: "invalid address not-a-wallet" });
  });

  it("classifyMany dedupes case variants", async () => {
    const classifier = new SmartWalletClassifier(lookup());
    const result = await classifier.classifyMany([TRACKED, TRACKED.toUpperCase().replace("0X", "0x"), UNTRACKED]);
    expect([...result]).toEqual([[TRACKED, "smart"], [UNTRACKED, "other"]]);
    expect(classifier.stats()).toMatchObject({ smart: 1, other: 1 });
  });
});
