import "dotenv/config";
import { importMovers } from "../server/pricing/pricecharting-movers.ts";
import { closeDatabase } from "../server/storage/index.ts";

try {
    const snapshot = await importMovers();
    if (snapshot) console.log(JSON.stringify(snapshot, null, 2));
    else console.log("Today's PriceCharting request has already been claimed. No completed snapshot is available for today.");
} finally { await closeDatabase(); }
