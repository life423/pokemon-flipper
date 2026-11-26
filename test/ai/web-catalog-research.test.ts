import test from "node:test";
import assert from "node:assert/strict";
import { createWebCatalogSearch } from "../../server/ai/web-catalog-research.ts";
import { isBoundedPriceSearch, priceSearchTools, PRICE_SEARCH_MODEL, PRICE_SEARCH_OUTPUT_TOKENS } from "../../server/ai/web-search-policy.ts";
import { withSavedProviderEvidence } from "../../server/lib/saved-provider-evidence.ts";

test("catalog discovery accepts a consulted allowlisted card page and reuses the finding", async () => {
    const card = { name: "Ampharos", set: "Aquapolis", number: "H1/H32", url: "https://www.pokemon.com/us/pokemon-tcg/pokemon-cards/aquapolis/H1/" };
    const wrongHost = { ...card, url: "https://pokemon.com.other.example/card/H1" };
    const cache = new Map<string, typeof card[]>();
    let calls = 0;
    const lookup = createWebCatalogSearch(async () => {
        calls++;
        return { result: { cards: [card, wrongHost, { ...card, url: card.url + "unvisited" }] },
            sourceUrls: [card.url + "?utm_source=openai", wrongHost.url] };
    }, async key => cache.get(key) ?? null, async (key, value) => { cache.set(key, value as typeof card[]); });
    const run = () => lookup("Ampharos", ["Aquapolis"], new AbortController().signal);
    assert.deepEqual(await run(), [card]);
    assert.deepEqual(await withSavedProviderEvidence(() => assert.fail("unexpected provider"), run), [card]);
    assert.equal(calls, 1);
});

test("catalog and sale searches each authorize their own provider tool configuration", () => {
    const body = { model: PRICE_SEARCH_MODEL, max_output_tokens: PRICE_SEARCH_OUTPUT_TOKENS,
        metadata: { app_step: "Web catalog research" }, text: { format: { name: "web_catalog_research" } }, ...priceSearchTools(true) };
    assert.equal(isBoundedPriceSearch(body), true);
    assert.equal(isBoundedPriceSearch({ ...body, ...priceSearchTools(false) }), false);
    assert.equal(isBoundedPriceSearch({ ...body, max_tool_calls: 2 }), false);
});
