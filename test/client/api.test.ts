import { test } from "node:test";
import assert from "node:assert/strict";
import { streamDeals, streamDig } from "../../client/src/api.ts";

test("Any targets and offer settings reach both search endpoints as explicit zeroes", async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url) => {
        urls.push(String(url));
        return new Response('{"type":"done"}\n', { headers: { "Content-Type": "application/x-ndjson" } });
    });
    const targets = { minProfit: 0, minRoi: 0 };
    await streamDeals("1999 base set holo", { maxResults: 200, minPrice: 0, targets, includeOffers: false }, () => {});
    await streamDig("lugia", 0, () => {}, targets, true);
    assert.equal(new URL(urls[0], "http://local").searchParams.get("offers"), "0");
    assert.equal(new URL(urls[1], "http://local").searchParams.get("offers"), "1");
    for (const url of urls) {
        const params = new URL(url, "http://local").searchParams;
        assert.equal(params.get("profit"), "0");
        assert.equal(params.get("roi"), "0");
    }
});
