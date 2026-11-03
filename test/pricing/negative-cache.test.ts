import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "../../server/lib/paths.ts";
import { lookupCards, fetchComps } from "../../server/pricing/pkmnprices.ts";
import { setSearchTerm } from "../../server/identity/card-identity.ts";

test("empty card-name results expire after five minutes while positive metadata remains reusable", async t => {
    const previous = process.env.PKMNPRICES_API_KEY; process.env.PKMNPRICES_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    const folder = path.join(DATA_DIR, "price-cache");
    await fs.mkdir(folder, { recursive: true });
    const put = async (endpoint: string, data: unknown, ageMinutes = 0) => {
        const key = "pkmnprices:" + endpoint;
        await fs.writeFile(path.join(folder, createHash("sha1").update(key).digest("hex") + ".json"),
            JSON.stringify({ key, savedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(), data }));
    };
    await put("/sets?" + new URLSearchParams({ name: setSearchTerm("Neo Discovery"), language: "English", per_page: "50" }), { data: [{ id: 99999, name: "Neo Discovery" }] });
    const item = { id: 999999, name: "Offline card", number: "1", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [] };
    await put("/cards/999999?currency=usd", item);
    for (const [name, data, age] of [["cache old empty", [], 60], ["cache recent empty", [], 2], ["cache positive", [item], 20 * 60]] as const) {
        await put("/cards?" + new URLSearchParams({ set_id: "99999", name, per_page: "20" }), { data }, age);
    }
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => { requests.push(String(url)); return new Response(JSON.stringify({ data: [item] }), { status: 200 }); });
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache old empty", cardNumber: "1/75" })).length, 1);
    assert.equal(requests.length, 1, "a stale empty answer is refreshed automatically on lookup");
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache recent empty", cardNumber: "1/75" })).length, 0);
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache positive", cardNumber: "1/75" })).length, 1);
    assert.equal(requests.length, 1, "recent empty answers and positive metadata do not waste another request");
    const params = new URLSearchParams({ graded: "true", grader: "PSA", grade: "7", limit: "20", sort: "date_desc", period: "180d" });
    await put(`/cards/999997/listings/ebay?${params}`, { data: [] }, 60);
    await put(`/cards/999998/listings/ebay?${params}`, { data: [] }, 2);
    await fetchComps(999997, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "an empty sold lookup expires in five minutes, not six hours");
    await fetchComps(999998, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "a recent empty sold lookup is shared without repeatedly hitting the API");
});
