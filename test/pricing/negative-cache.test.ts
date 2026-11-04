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
    const refreshed = { id: 999999, name: "Espeon", number: "1", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [] };
    const positive = { ...refreshed, id: 999996, name: "Smeargle", number: "11" };
    await put("/cards/999999?currency=usd", refreshed);
    await put("/cards/999996?currency=usd", positive);
    for (const [name, data, age] of [["espeon", [], 60], ["umbreon", [], 2], ["smeargle", [positive], 20 * 60]] as const) {
        await put("/cards?" + new URLSearchParams({ set_id: "99999", name, per_page: "20" }), { data }, age);
    }
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        requests.push(String(url));
        const parsed = new URL(String(url));
        if (parsed.pathname === "/v1/cards") {
            assert.equal(parsed.searchParams.get("name"), "espeon");
            assert.equal(parsed.searchParams.get("number"), "1");
            return Response.json({ data: [refreshed] });
        }
        return Response.json({ data: [] });
    });
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "Espeon", cardNumber: "1/75" })).length, 1);
    assert.equal(requests.length, 1, "a stale empty answer is refreshed automatically on lookup");
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "Espeon", cardNumber: "1/75" })).length, 1);
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "Umbreon", cardNumber: "13/75" })).length, 0);
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "Smeargle", cardNumber: "11/75" })).length, 1);
    assert.equal(requests.length, 1, "recent empty answers and positive metadata do not waste another request");
    const params = new URLSearchParams({ graded: "true", grader: "PSA", grade: "7", limit: "20", sort: "date_desc", period: "180d" });
    await put(`/cards/999997/listings/ebay?${params}`, { data: [] }, 60);
    await put(`/cards/999998/listings/ebay?${params}`, { data: [] }, 2);
    await fetchComps(999997, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "an empty sold lookup expires in five minutes, not six hours");
    await fetchComps(999998, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "a recent empty sold lookup is shared without repeatedly hitting the API");
});
