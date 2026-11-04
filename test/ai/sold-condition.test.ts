import "../fixtures/isolated-data.ts";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { acceptedSoldCondition, corroboratedSoldCondition, createSoldConditionAcquirer, type SoldConditionReading } from "../../server/ai/sold-condition.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { listingCacheKey, type ListingDetails } from "../../server/ebay/listings.ts";
import { CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
import { VISION_MODEL, BOUNDED_VISION_MODEL } from "../../server/ai/policy.ts";
import { normalizedPhoto } from "../../shared/listing-evidence.ts";
import { AiSpendingError } from "../../server/ai/spending.ts";
import { StorageUnavailableError } from "../../server/storage/index.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import type { Comp } from "../../server/pricing/types.ts";
import { EbayError } from "../../server/ebay/api.ts";
beforeEach(t => { t.mock.method(globalThis, "fetch", () => assert.fail("Sold-copy regressions use only injected saved data and assessments")); });
const identity = cardEvaluation().identity!;
function reading(): SoldConditionReading {
    return { card: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Visible name, collector number and Base Set artwork agree"] }, printing: "UNLIMITED", condition: "LIGHTLY_PLAYED", confidence: "HIGH", oneRawCard: true, frontVisible: true, backVisible: true, closeUps: true, structuralDamage: false, evidence: ["Minor corner whitening on both sides"], limitations: [] };
}
test("sold-copy classification requires actual identity, printing and visible condition; structural damage outranks a mint guess", () => {
    const input = reading(); assert.equal(acceptedSoldCondition(input, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(acceptedSoldCondition({ ...input, backVisible: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, oneRawCard: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, printing: "FIRST_EDITION" }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", closeUps: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", structuralDamage: true, backVisible: false }, identity, 4)?.condition, "DAMAGED");
});
test("two medium readings may settle wear but cannot vote away missing views, damage or a Mint evidence gap", () => {
    const a = { ...reading(), confidence: "MEDIUM" };
    assert.equal(corroboratedSoldCondition(a, a, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(corroboratedSoldCondition(a, { ...a, condition: "NEAR_MINT" }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, backVisible: false }, a, identity, 4), null);
    assert.equal(corroboratedSoldCondition(a, { ...a, structuralDamage: true }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, condition: "MINT" }, { ...a, condition: "MINT" }, identity, 4), null);
});

const photo = (id: string, index: number, size = 1600) => `https://i.ebayimg.com/images/g/${id}-${index}/s-l${size}.jpg`;
function soldListing(id = "123456789012", count = 4): ListingDetails {
    return { id: `v1|${id}|0`, title: "Venusaur Base Set 15/102 Unlimited Holo English", url: `https://www.ebay.com/itm/${id}`,
        images: Array.from({ length: count }, (_, index) => photo(id, index)), price: 100, shipping: 0, buyingOption: "FIXED_PRICE", bestOffer: false,
        bids: 0, endTime: "2026-01-01T00:00:00Z", availability: "UNAVAILABLE", retrievedAt: new Date().toISOString(), seller: null,
        condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [],
        aspects: { Set: "Base Set", "Card Name": "Venusaur", "Card Number": "15/102", Language: "English", Finish: "Holo" } };
}
const soldSale = (listing: ListingDetails): Comp => ({ id: listing.id, title: listing.title, listing_url: listing.url,
    price: 100, sold_at: new Date(Date.now() - 86_400_000).toISOString(), grader: null, grade: null, currency: "USD", sale_type: "fixed_price", attribution: "exact", grade_qualifier: null, variant: "Holofoil" });
const target = JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish]);
const legacyKey = (listing: ListingDetails) => `sold-condition:v${CONDITION_RULES_VERSION}:${VISION_MODEL}:${target}:${JSON.stringify([...new Set(listing.images)].filter(Boolean).slice(0, 24))}`;
function acquisitionHarness(listings = [soldListing()], overrides: Partial<Parameters<typeof createSoldConditionAcquirer>[0]> = {}) {
    const cache = new Map<string, any>(), loaded: { id: string; options: unknown }[] = [], assessed: { input: { photos: { number: number; url: string }[] }; signal?: AbortSignal }[] = [];
    const deps = { condition: "LIGHTLY_PLAYED" as const,
        cached: async <T,>(key: string) => cache.has(key) ? structuredClone(cache.get(key)) as T : null,
        save: async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); },
        loadDetails: async (id: string, options: unknown) => { loaded.push({ id, options }); const listing = listings.find(value => value.id === id); assert.ok(listing); cache.set(listingCacheKey(id), structuredClone(listing)); return structuredClone(listing); },
        assess: async (input: { photos: { number: number; url: string }[] }, signal?: AbortSignal) => { assessed.push({ input: structuredClone(input), signal }); return { result: reading(), usage: { inputTokens: 120, outputTokens: 80 } }; }, ...overrides };
    return { cache, loaded, assessed, deps, worker: createSoldConditionAcquirer(deps) };
}

test("saved-only sold-copy reads preserve raw and wrapped legacy answers without detail or model requests", async () => {
    for (const value of [reading(), { primary: reading() }, { primary: { ...reading(), confidence: "MEDIUM" }, corroboration: { ...reading(), confidence: "MEDIUM" } }]) {
        const listing = soldListing(), h = acquisitionHarness([listing]);
        h.cache.set(listingCacheKey(listing.id), listing); h.cache.set(legacyKey(listing), value);
        const before = structuredClone(value), result = await h.worker.read(soldSale(listing), identity);
        assert.equal(result?.condition, "LIGHTLY_PLAYED"); assert.equal(result?.usage, undefined);
        assert.equal(await h.worker.status(soldSale(listing), identity), "REVIEWED");
        assert.equal((await h.worker.acquire(soldSale(listing), identity))?.condition, "LIGHTLY_PLAYED");
        assert.deepEqual(h.cache.get(legacyKey(listing)), before); assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0); assert.deepEqual(h.worker.usage, []);
    }
    const listing = soldListing("123456789013"), h = acquisitionHarness([listing]);
    assert.equal(await h.worker.read(soldSale(listing), identity), null); assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0);
});

test("a saved negative sold reading is terminal and never purchases a compact replacement or corroboration", async () => {
    for (const value of [{ ...reading(), oneRawCard: false }, { primary: { ...reading(), confidence: "MEDIUM" } }]) {
        const listing = soldListing("123456789014"), h = acquisitionHarness([listing]);
        h.cache.set(listingCacheKey(listing.id), listing); h.cache.set(legacyKey(listing), value);
        assert.equal(await h.worker.read(soldSale(listing), identity), null);
        assert.equal(await h.worker.status(soldSale(listing), identity), "REVIEWED");
        assert.equal(await h.worker.acquire(soldSale(listing), identity), null);
        assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0);
        assert.equal([...h.cache.keys()].some(key => key.includes(":bounded-1:")), false);
    }
});

test("explicit wrong sold-title identities stop cold acquisition before historical details or photo review", async () => {
    for (const title of ["Charizard Base Set 15/102 Unlimited Holo LP", "Venusaur Base Set 16/102 Unlimited Holo LP",
        "Venusaur Jungle 15/102 Unlimited Holo LP", "Dark Venusaur Base Set 15/102 Unlimited Holo LP",
        "Venusaur ex Base Set 15/102 Unlimited Holo LP", "Blaine's Venusaur Base Set 15/102 Unlimited Holo LP"]) {
        const listing = soldListing("123456789026"), h = acquisitionHarness([listing]);
        assert.equal(await h.worker.acquire({ ...soldSale(listing), title }, identity), null, title);
        assert.equal(h.loaded.length, 0, title); assert.equal(h.assessed.length, 0, title); assert.deepEqual(h.worker.usage, []);
    }
});

test("accepted saved physical sold evidence takes precedence over a conflicting seller title", async () => {
    for (const title of ["Charizard Base Set 4/102 Unlimited Holo LP", "Venusaur Base Set 20/102 Unlimited Holo LP", "Venusaur Jungle 15/102 Unlimited Holo LP"]) {
        const listing = { ...soldListing("123456789027"), title }, h = acquisitionHarness([listing]), saved = { primary: reading() };
        h.cache.set(listingCacheKey(listing.id), listing); h.cache.set(legacyKey(listing), saved);
        const result = await h.worker.acquire(soldSale(listing), identity);
        assert.equal(result?.condition, "LIGHTLY_PLAYED", title); assert.equal(result?.usage, undefined);
        assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0); assert.deepEqual(h.worker.usage, []);
        assert.deepEqual(h.cache.get(legacyKey(listing)), saved, "original accepted evidence remains unchanged");
    }
});

test("missing or matching partial sold-title numbers remain eligible for physical verification", async () => {
    for (const title of ["Pokemon card", "Venusaur Base Set Unlimited Holo LP", "Venusaur Base Set #15 Unlimited Holo LP"]) {
        const listing = soldListing("123456789028"), h = acquisitionHarness([listing]);
        const result = await h.worker.acquire({ ...soldSale(listing), title }, identity);
        assert.equal(result?.condition, "LIGHTLY_PLAYED", title); assert.equal(h.loaded.length, 1, title); assert.equal(h.assessed.length, 1, title);
    }
});

test("one helper claims at most one cold historical copy even when acquisition calls overlap", async () => {
    const listings = [soldListing("123456789015"), soldListing("123456789016")], release = Promise.withResolvers<void>();
    let assessments = 0;
    const h = acquisitionHarness(listings, { assess: async () => { assessments++; await release.promise; return { result: reading(), usage: { inputTokens: 120, outputTokens: 80 } }; } });
    const first = h.worker.acquire(soldSale(listings[0]), identity), second = h.worker.acquire(soldSale(listings[1]), identity);
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results.filter(Boolean).length, 1); assert.equal(assessments, 1); assert.equal(h.loaded.length, 1);
    assert.equal(await h.worker.acquire(soldSale(listings[1]), identity), null); assert.equal(h.loaded.length, 1);
});

test("invalid IDs, variations, slabs, foreign cards, junk and one normalized photo never purchase sold-photo work", async () => {
    const one = soldListing("123456789017", 1), alias = { ...one, images: [photo("alias", 0, 225), photo("alias", 0, 1600)] };
    for (const listing of [one, alias, { ...soldListing(), condition: "Graded", aspects: { "Professional Grader": "PSA", Grade: "8" } },
        { ...soldListing(), title: "Japanese Venusaur Base Set 15/102", aspects: { Language: "Japanese" } },
        { ...soldListing(), title: "Venusaur Base Set 15/102 lot of 2 cards" }]) {
        const h = acquisitionHarness([listing]);
        assert.equal(await h.worker.acquire(soldSale(listing), identity), null); assert.equal(h.assessed.length, 0);
        if (new Set(listing.images.map(normalizedPhoto)).size < 2) assert.equal(await h.worker.status(soldSale(listing), identity), "UNUSABLE");
    }
    for (const listing_url of ["https://example.invalid/itm/123456789012", "https://www.ebay.com/itm/123456789012?var=123456789013", "not-a-listing"]) {
        const h = acquisitionHarness();
        assert.equal(await h.worker.acquire({ ...soldSale(soldListing()), listing_url }, identity), null);
        assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0);
    }
});

test("compact sold evidence records only its selected source photos and replays without usage", async () => {
    const listing = soldListing("123456789018", 24), h = acquisitionHarness([listing]);
    const result = await h.worker.acquire(soldSale(listing), identity);
    assert.equal(result?.condition, "LIGHTLY_PLAYED"); assert.deepEqual(result?.usage, { inputTokens: 120, outputTokens: 80 });
    assert.equal(h.assessed.length, 1); const photos = h.assessed[0].input.photos;
    assert.ok(photos.length >= 2 && photos.length <= 6); assert.equal(new Set(photos.map(value => normalizedPhoto(value.url))).size, photos.length);
    assert.equal(result?.photoCount, photos.length, "unsupplied listing images must not count as reviewed");
    assert.ok(photos.every(value => listing.images[value.number - 1] === value.url));
    assert.deepEqual(result?.photoNumbers, photos.map(value => value.number));
    const key = `sold-condition:v${CONDITION_RULES_VERSION}:${BOUNDED_VISION_MODEL}:bounded-1:${target}:${JSON.stringify(photos.map(value => [value.number, normalizedPhoto(value.url)]))}`;
    assert.ok(h.cache.has(key)); assert.equal(h.cache.has(legacyKey(listing)), false, "compact evidence cannot overwrite the original full-photo namespace");
    const replay = createSoldConditionAcquirer(h.deps);
    assert.equal((await replay.read(soldSale(listing), identity))?.condition, "LIGHTLY_PLAYED");
    assert.equal((await replay.acquire(soldSale(listing), identity))?.usage, undefined); assert.equal(h.assessed.length, 1);
    assert.deepEqual(h.loaded[0].options, { maxAgeHours: 24 * 30, keepReserve: true, allowEndedCache: true });
});

test("an inconclusive compact answer saves once without a second opinion or a next-copy fallback", async () => {
    const listing = soldListing("123456789019"); let assessments = 0;
    const h = acquisitionHarness([listing], { assess: async () => { assessments++; return { result: { ...reading(), confidence: "MEDIUM" }, usage: { inputTokens: 120, outputTokens: 80 } }; } });
    assert.equal(await h.worker.acquire(soldSale(listing), identity), null); assert.equal(assessments, 1);
    assert.equal(await h.worker.status(soldSale(listing), identity), "REVIEWED");
    assert.deepEqual(h.worker.usage, [{ inputTokens: 120, outputTokens: 80 }], "a paid negative result still contributes to request usage");
    assert.equal(await createSoldConditionAcquirer(h.deps).acquire(soldSale(listing), identity), null); assert.equal(assessments, 1);
    assert.equal([...h.cache.keys()].filter(key => key.includes(":bounded-1:")).length, 1);
});

test("same-search helper instances share a cold sold-copy request", async () => {
    const listing = soldListing("123456789020"), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let assessments = 0;
    const h = acquisitionHarness([listing], { assess: async () => { assessments++; started.resolve(); await release.promise; return { result: reading(), usage: { inputTokens: 120, outputTokens: 80 } }; } });
    const other = createSoldConditionAcquirer(h.deps);
    await withAiUsageContext({ searchId: "941dcff0-3c77-43de-ad79-285c26a2811c" }, async () => {
        const first = h.worker.acquire(soldSale(listing), identity); await started.promise;
        const second = other.acquire(soldSale(listing), identity); release.resolve();
        assert.ok((await Promise.all([first, second])).every(result => result?.condition === "LIGHTLY_PLAYED"));
    });
    assert.equal(assessments, 1);
    assert.equal(h.worker.usage.length + other.usage.length, 1, "one shared request must not count its usage twice");
});

test("Stop blocks queued sold work while an accepted response finishes saving for free replay", async () => {
    const listing = soldListing("123456789021"), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), saved = Promise.withResolvers<void>();
    let assessments = 0; const controller = new AbortController(), cache = new Map<string, any>([[listingCacheKey(listing.id), listing]]);
    const h = acquisitionHarness([listing], { cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, structuredClone(value)); if (key.includes(":bounded-1:")) saved.resolve(); },
        assess: async (_input, signal) => { assessments++; assert.equal(signal?.aborted, false); started.resolve(); await release.promise; return { result: reading(), usage: { inputTokens: 120, outputTokens: 80 } }; } });
    const pending = h.worker.acquire(soldSale(listing), identity, controller.signal);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await started.promise; controller.abort(); await rejected; release.resolve(); await saved.promise;
    assert.equal((await createSoldConditionAcquirer(h.deps).read(soldSale(listing), identity))?.condition, "LIGHTLY_PLAYED"); assert.equal(assessments, 1);
    const alreadyStopped = new AbortController(); alreadyStopped.abort();
    await assert.rejects(createSoldConditionAcquirer(h.deps).acquire(soldSale(listing), identity, alreadyStopped.signal), { name: "AbortError" });
    assert.equal(assessments, 1);
});

test("sold-copy storage and spending failures propagate instead of becoming negative evidence or fresh work", async () => {
    const listing = soldListing("123456789022"), sale = soldSale(listing);
    for (const failure of [new StorageUnavailableError("Saved sold evidence unavailable"), new AiSpendingError("AI_BUDGET", "Search cap reached")]) {
        const h = acquisitionHarness([listing], { assess: async () => { throw failure; } });
        await assert.rejects(h.worker.acquire(sale, identity), error => error === failure);
        assert.equal([...h.cache.keys()].some(key => key.includes(":bounded-1:")), false);
    }
    const failure = new StorageUnavailableError("Corrupt saved reading");
    const unreadable = acquisitionHarness([listing], { cached: async () => { throw failure; } });
    await assert.rejects(unreadable.worker.acquire(sale, identity), error => error === failure);
    assert.equal(unreadable.loaded.length, 0); assert.equal(unreadable.assessed.length, 0);
    const unsaved = acquisitionHarness([listing], { save: async () => { throw failure; } });
    await assert.rejects(unsaved.worker.acquire(sale, identity), error => error === failure);
    assert.equal(unsaved.worker.usage.length, 1, "an accepted response remains accounted for even when saving fails");
});

test("legacy access negatives stay unusable and malformed saved answers fail closed", async () => {
    const listing = soldListing("123456789023"), sale = soldSale(listing), h = acquisitionHarness([listing]);
    h.cache.set(`sold-condition-access:${listing.id}:${target}`, true);
    assert.equal(await h.worker.read(sale, identity), null);
    assert.equal(await h.worker.status(sale, identity), "UNUSABLE");
    assert.equal(await h.worker.acquire(sale, identity), null); assert.equal(h.loaded.length, 0); assert.equal(h.assessed.length, 0);
    const corrupt = acquisitionHarness([listing]); corrupt.cache.set(listingCacheKey(listing.id), listing); corrupt.cache.set(legacyKey(listing), true);
    await assert.rejects(corrupt.worker.read(sale, identity), StorageUnavailableError);
    await assert.rejects(corrupt.worker.acquire(sale, identity), StorageUnavailableError); assert.equal(corrupt.assessed.length, 0);
});

test("definitive sold-copy 404 and 410 responses prevent repeated cold Browse calls without overriding saved photo evidence", async () => {
    for (const status of [404, 410]) {
        const listing = soldListing(`123456789${status}`), sale = soldSale(listing);
        let loads = 0;
        const h = acquisitionHarness([listing], { loadDetails: async () => { loads++; throw new EbayError("Historical listing unavailable", status); } });
        assert.equal(await h.worker.acquire(sale, identity), null);
        assert.equal(h.worker.status(sale, identity), "UNUSABLE");
        assert.equal(h.cache.get(`sold-condition-access:${listing.id}:${target}`), true);
        const another = createSoldConditionAcquirer(h.deps);
        assert.equal(await another.read(sale, identity), null);
        assert.equal(await another.acquire(sale, identity), null);
        assert.equal(loads, 1); assert.equal(h.assessed.length, 0);
        h.cache.set(listingCacheKey(listing.id), listing); h.cache.set(legacyKey(listing), reading());
        assert.equal((await createSoldConditionAcquirer(h.deps).read(sale, identity))?.condition, "LIGHTLY_PLAYED", "accepted saved photos take priority over an access marker");
    }
});

test("temporary, cancelled, budget and untyped sold-copy errors never become cached absence", async () => {
    const listing = soldListing("123456789024"), sale = soldSale(listing);
    for (const failure of [new EbayError("Denied", 403), new EbayError("Throttled", 429), new EbayError("Temporary", 503),
        new DOMException("Stopped", "AbortError"), new AiSpendingError("AI_BUDGET", "Search cap reached"), new Error("404 text is not a typed eBay absence")]) {
        let loads = 0;
        const h = acquisitionHarness([listing], { loadDetails: async () => { loads++; throw failure; } });
        for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createSoldConditionAcquirer(h.deps).acquire(sale, identity), error => error === failure);
        assert.equal(loads, 2); assert.equal(h.cache.size, 0); assert.equal(h.assessed.length, 0);
    }
});

test("a sold-copy access-marker storage failure propagates and never authorizes photo review", async () => {
    const listing = soldListing("123456789025"), failure = new StorageUnavailableError("Cannot save historical access result");
    const h = acquisitionHarness([listing], { loadDetails: async () => { throw new EbayError("Historical listing missing", 404); }, save: async () => { throw failure; } });
    await assert.rejects(h.worker.acquire(soldSale(listing), identity), error => error === failure);
    assert.equal(h.cache.size, 0); assert.equal(h.assessed.length, 0); assert.deepEqual(h.worker.usage, []);
});
