import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { lookupCards, fetchComps } from "../../server/pricing/pkmnprices.ts";
import { setSearchTerm } from "../../server/identity/card-identity.ts";

test("empty card-name results expire after five minutes while positive metadata remains reusable", async t => {
    const previous = process.env.PKMNPRICES_API_KEY; process.env.PKMNPRICES_API_KEY = "offline-test";
    t.after(() => { if (previous === undefined) delete process.env.PKMNPRICES_API_KEY; else process.env.PKMNPRICES_API_KEY = previous; });
    const cached = new Map<string, string>();
    const put = (path: string, data: unknown, ageMinutes = 0) => cached.set(createHash("sha1").update("pkmnprices:" + path).digest("hex") + ".json", JSON.stringify({ savedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(), data }));
    put("/sets?" + new URLSearchParams({ name: setSearchTerm("Neo Discovery"), language: "English", per_page: "50" }), { data: [{ id: 99999, name: "Neo Discovery" }] });
    const item = { id: 999999, name: "Offline card", number: "1", total_set_number: "75", set: { name: "Neo Discovery" }, prices: [] };
    put("/cards/999999?currency=usd", item);
    for (const [name, data, age] of [["cache old empty", [], 60], ["cache recent empty", [], 2], ["cache positive", [item], 20 * 60]] as const) {
        put("/cards?" + new URLSearchParams({ set_id: "99999", name, per_page: "20" }), { data }, age);
    }
    t.mock.method(fs, "readFile", async (path: unknown) => { const key = String(path).split(/[\\/]/).at(-1)!; if (!cached.has(key)) throw Error("cache miss"); return cached.get(key)!; });
    t.mock.method(fs, "writeFile", async () => {}); t.mock.method(fs, "mkdir", async () => undefined);
    t.mock.method(fs, "rename", async () => {}); t.mock.method(fs, "rm", async () => {});
    const requests: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => { requests.push(String(url)); return new Response(JSON.stringify({ data: [item] }), { status: 200 }); });
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache old empty", cardNumber: "1/75" })).length, 1);
    assert.equal(requests.length, 1, "a stale empty answer is refreshed automatically on lookup");
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache recent empty", cardNumber: "1/75" })).length, 0);
    assert.equal((await lookupCards({ set: "Neo Discovery", name: "cache positive", cardNumber: "1/75" })).length, 1);
    assert.equal(requests.length, 1, "recent empty answers and positive metadata do not waste another request");
    const params = new URLSearchParams({ graded: "true", grader: "PSA", grade: "7", limit: "20", sort: "date_desc", period: "180d" });
    put(`/cards/999997/listings/ebay?${params}`, { data: [] }, 60);
    put(`/cards/999998/listings/ebay?${params}`, { data: [] }, 2);
    await fetchComps(999997, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "an empty sold lookup expires in five minutes, not six hours");
    await fetchComps(999998, { grader: "PSA", grade: "7" });
    assert.equal(requests.length, 2, "a recent empty sold lookup is shared without repeatedly hitting the API");
});
