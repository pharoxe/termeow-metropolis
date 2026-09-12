import "dotenv/config";
import { fetchBoard, FomoscanError } from "../server/terminal/fomoscanBoards.js";
import { boardBudget, fomoscanKey, reconcileAccount } from "../server/terminal/fomoscanAccount.js";
import { identityRegistry } from "../server/terminal/identityStore.js";

if (!fomoscanKey) throw new Error("FOMOSCAN_API_KEY is required");
await reconcileAccount();
const windows = ["24h", "7d", "30d", "all"] as const;
const result: Array<{ window: string; rows: number; identities: number; status: string }> = [];
for (const window of windows) {
  const now = Date.now();
  if (!boardBudget.allows(now, "board")) { result.push({ window, rows: 0, identities: 0, status: "budget-paced" }); continue; }
  try {
    const snapshot = await fetchBoard({ board: "fomoscan-traders", window }, fomoscanKey, now);
    boardBudget.record(now, "board");
    identityRegistry.record(snapshot, now);
    result.push({ window, rows: snapshot.rankings.length, identities: snapshot.identities.length, status: "stored" });
  } catch (error) {
    if (error instanceof FomoscanError && error.billed) boardBudget.record(now, "board");
    result.push({ window, rows: 0, identities: 0, status: error instanceof Error ? error.message : "failed" });
  }
}
console.log(JSON.stringify({ source: "FomoScan→Termeow SQLite gateway", result, coverage: identityRegistry.coverage().identities }, null, 2));
identityRegistry.close();
boardBudget.close();
