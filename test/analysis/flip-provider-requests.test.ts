import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import test from "node:test";
import { countFlipRequests, flipRequestCounts } from "../../server/analysis/flip-provider-requests.ts";

test("concurrent flip passes count only their own outbound starts and retain no request details", async () => {
    const http = channel("undici:request:create");
    const send = (origin: string, path: string) => http.publish({ request: { origin, path } });
    const [browse, sold] = await Promise.all([
        countFlipRequests(async () => {
            assert.deepEqual(flipRequestCounts(), {});
            send("https://api.ebay.com", "/identity/v1/oauth2/token");
            await Promise.resolve();
            send("https://api.ebay.com", "/buy/browse/v1/item_summary/search?q=private");
            send("https://example.com", "/irrelevant");
            return flipRequestCounts();
        }),
        countFlipRequests(async () => {
            send("https://api.pkmnprices.com", "/v1/cards/1/listings/ebay?cursor=private");
            await Promise.resolve();
            send("https://www.pokeprice.gg", "/cards/example");
            send("https://www.pokeprice.gg", "/api/card-sales/example");
            send("https://www.pricecharting.com", "/game/pokemon-example/example");
            return flipRequestCounts();
        }),
    ]);
    assert.deepEqual(browse, { "eBay OAuth": 1, "eBay Browse": 1 });
    assert.deepEqual(sold, { "PKMNPrices · eBay sales": 1, "PokéPrice · card page": 1, "PokéPrice · sold feed": 1, "PriceCharting · product history": 1 });
    assert.deepEqual(flipRequestCounts(), {});
});
