import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readSearchLocally, readSearchWithoutAi } from "../../server/search/intent.ts";
import { findDeals, type SearchSummary } from "../../server/deals/find-deals.ts";
import { marketplaceQuery, describeSearchCriteria, evaluatedIdentityMismatch } from "../../shared/search-criteria.ts";
import { searchYears } from "../../shared/search-years.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import { readCache, writeCache } from "../../server/lib/cache.ts";
import { MODEL } from "../../server/ai/openai.ts";
import type { Evaluation, ListingSummary } from "../../shared/types.ts";

const releaseYears = { "base set": 1999, jungle: 1999, fossil: 1999, "base set 2": 2000, "gym challenge": 2000,
    "legendary collection": 2002, celebrations: 2021 };
const row = (id: string, title: string): ListingSummary => ({ id, title, currentPrice: 25, shipping: 5,
    buyingOption: "FIXED_PRICE", isGraded: false, bids: 0, seller: null, endTime: null, images: ["offline-photo"], url: "#" });

test("release years remain criteria and never become literal marketplace year or liquidity words", () => {
    for (const query of ["1999-2003 pokemon card holo", "pokemon holo from 1999 to 2003",
        "find me a deal on a pokemon card holo that is liquid from 1999-2003"]) {
        const intent = readSearchLocally(query);
        assert.deepEqual([intent.minYear, intent.maxYear, intent.cardName, intent.cardNumber, intent.titleWords], [1999, 2003, null, null, []], query);
        assert.equal(marketplaceQuery(query, intent), "pokemon holo", query);
        assert.ok(describeSearchCriteria(intent).includes("1999–2003"));
    }
    const named = readSearchLocally("1999 venusaur");
    assert.deepEqual([named.cardName, named.minYear, named.maxYear], ["venusaur", 1999, 1999]);
    assert.equal(marketplaceQuery("1999 venusaur", named), "venusaur");
    assert.equal(readSearchLocally("Venusaur 15/102").cardNumber, "15/102");
    assert.equal(readSearchLocally("Unown A 2001").cardName, "Unown A".toLowerCase());
    assert.equal(searchYears("1999/203"), null);
    assert.equal(searchYears("#1999"), null);
});

test("a curated Neo release typo resolves the request without treating it as a card name", () => {
    const query = "find a deal on a holo card form neo revolution";
    const intent = readSearchLocally(query);
    assert.deepEqual(intent.sets, ["Neo Revelation"]);
    assert.equal(intent.cardName, null);
    assert.equal(intent.finish, "HOLO");
    assert.equal(marketplaceQuery(query, intent), "holo neo revelation");
    assert.equal(marketplaceQuery("Origin Forme Palkia VSTAR", readSearchLocally("Origin Forme Palkia VSTAR")), "origin forme palkia vstar");
});

test("year-bounded discovery filters known wrong releases before price or photo research", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("the release catalog and listing source are already available"));
    const rows = [row("base", "Venusaur Base Set 15/102 Holo"), row("reissue", "Venusaur Base Set 2 18/130 Holo 1999"),
        row("legendary", "Venusaur Legendary Collection 18/110 Holo"), row("celebrations", "Venusaur Celebrations 15/102 Holo"),
        row("unknown", "Venusaur Holo Unspecified"), row("stated", "2021 Venusaur Holo")];
    for (const [query, wanted] of [["1999 venusaur", ["base", "unknown"]],
        ["1999-2003 pokemon card holo", ["base", "reissue", "legendary", "unknown"]]] as const) {
        const priced: string[] = [];
        let summary: SearchSummary | undefined;
        const deps = offlineSearchSteps(rows, { releaseYears: async () => releaseYears,
            search: async phrase => { assert.equal(phrase, query === "1999 venusaur" ? "venusaur" : "pokemon holo"); return { listings: rows, total: rows.length, skipped: 0, rejections: [] }; },
            soldScreening: () => async listing => { priced.push(listing.id); return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sales." }; } });
        const result = await findDeals(query, { onStart: value => { summary = value; } }, deps);
        assert.deepEqual(result.map(listing => listing.id), wanted, query);
        assert.deepEqual(priced, wanted, "wrong-era cards never reach price research");
        assert.deepEqual(summary?.intent.releaseYears, releaseYears);
        const e = { listing: { title: "Venusaur 15/102" }, identity: { status: "IDENTIFIED", set: "Celebrations" } } as Evaluation;
        assert.equal(evaluatedIdentityMismatch(e, summary!.intent), "OTHER_SET", "identified reprints stay out after assessment");
    }
});

test("older accepted intent cannot preserve year keywords or mistaken liquidity card names", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("saved intent corrections cannot request another model"));
    const query = "find me a deal on a pokemon card holo that is liquid from 1999-2003";
    const saved = { ...readSearchLocally(query), minYear: undefined, maxYear: undefined,
        keywords: "pokemon holo that is liquid 1999-2003", cardName: "that is liquid", titleWords: ["that", "is"], source: "ai" };
    const key = `search-intent:v2:${MODEL}:${query}`;
    await writeCache(key, saved);
    const corrected = await readSearchWithoutAi(query);
    assert.deepEqual([corrected.minYear, corrected.maxYear, corrected.cardName, corrected.titleWords], [1999, 2003, null, []]);
    assert.equal(marketplaceQuery(query, corrected), "pokemon holo");
    assert.deepEqual(await readCache(key, 24), JSON.parse(JSON.stringify(saved)), "accepted saved evidence is retained");
});
