import "dotenv/config";
import { importDailyDiscovery } from "../server/pricing/pokeprice-movers.ts";
import { closeDatabase } from "../server/storage/index.ts";

try {
    const { snapshot: result, silph } = await importDailyDiscovery();
    if (result) console.log(JSON.stringify({ observedAt: result.observedAt, publishedDay: result.publishedDay,
        movers: result.rows.length, silphSetCandidates: silph?.length ?? null, detailPages: result.rows.filter(row => row.detail).length,
        withEbayAsks: result.rows.filter(row => row.detail?.ebayAsks.length).length,
        withSoldPrices: result.rows.filter(row => row.detail?.ebaySales.length).length }, null, 2));
    else console.log("Today's PokéPrice run has already been claimed.");
} finally { await closeDatabase(); }
