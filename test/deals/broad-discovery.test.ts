import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { findDeals } from "../../server/deals/find-deals.ts";
import { freshResaleCandidates, orderBroadDiscovery, resaleReviewBand, resaleReviewPriority } from "../../server/deals/discovery-order.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { buyerReviewBlock } from "../../shared/wait-skip-review.ts";
import { createScreeningPriceSource } from "../../server/pricing/pkmnprices.ts";
import { offlineSearchSteps } from "../fixtures/search-steps.ts";
import type { ListingSummary } from "../../shared/types.ts";

const listing = (id: string, title: string, isGraded = false): ListingSummary => ({
    id, title, currentPrice: 35, shipping: 5, bids: 0, isGraded, buyingOption: "FIXED_PRICE", endTime: null,
    images: ["offline-front", "offline-back"], url: "#", seller: null,
});

test("within a broad research kind, a later copy with quoted shipping leads its market", () => {
    const row = (id: string, name: string, number: string, shipping: number | null) => ({
        ...listing(id, name), shipping, screen: { status: "UNSCREENED" as const, reason: null, bestCase: null, assumed: null,
            card: { name, set: "Aquapolis", cardNumber: number, printing: "UNKNOWN" as const, printingLabel: null } },
    });
    const rows = [row("unknown-copy", "Slowpoke", "108/147", null), row("quoted-copy", "Slowpoke", "108/147", 2),
        row("unquoted-market", "Nidoking", "24/147", null), row("quoted-market", "Espeon", "11/147", 5)];
    assert.deepEqual(orderBroadDiscovery(rows, undefined, Date.now()).map(listing => listing.id),
        ["quoted-copy", "quoted-market", "unquoted-market", "unknown-copy"]);
});

test("broad discovery advances distinct raw and slab markets without exhausting the fetched page", async () => {
    const rows = [
        ...Array.from({ length: 100 }, (_, i) => listing(`raw-${i}`, "Forest Guardian 123/147 Aquapolis Uncommon")),
        ...Array.from({ length: 30 }, (_, i) => listing(`slab-${i}`, "Espeon 11/147 Aquapolis PSA 8", true)),
        ...Array.from({ length: 70 }, (_, i) => listing(`other-${i}`, "Nidoking 24/147 Aquapolis Holo")),
    ];
    const checked: string[] = [];
    let token = "";
    let continuationId = "";
    const first = await withAiUsageContext({ searchId: randomUUID() }, () => findDeals("Aquapolis", {
        automaticPhotos: true,
        onStart: summary => { if (summary.continuation) { token = summary.continuation.token; continuationId = summary.continuation.searchId; } },
    }, offlineSearchSteps(rows, {
        soldScreening: () => async row => { checked.push(row.id); return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sales." }; },
    })));
    assert.equal(first.length, 50);
    assert.equal(checked.length, 50, "one complete review batch releases discovery instead of screening 200 missing markets");
    assert.ok(first.slice(0, 3).some(row => row.isGraded), "slabs with missing prices remain equally reviewable");
    assert.equal(new Set(first.slice(0, 3).map(row => row.screen?.card?.name)).size, 3, "compare distinct provisional markets before repeat copies");
    assert.ok(first.every(row => buyerReviewBlock(row) === null));
    assert.ok(token);
    // Real continuation storage retains every unreached copy and its original
    // allowance, rather than turning the faster first batch into a smaller hunt.
    const allIds = new Set(first.map(row => row.id));
    while (token) {
        let next = "";
        let nextId = "";
        const batch = await withAiUsageContext({ searchId: continuationId }, () => findDeals("Aquapolis", {
            automaticPhotos: true, continuation: token,
            onStart: summary => { next = summary.continuation?.token ?? ""; nextId = summary.continuation?.searchId ?? ""; },
        }, offlineSearchSteps([], {
            soldScreening: () => async row => { checked.push(row.id); return { status: "UNAVAILABLE", exactScope: false, references: [], note: "No saved sales." }; },
        })));
        assert.equal(batch.length, 50);
        for (const row of batch) { assert.ok(!allIds.has(row.id)); allIds.add(row.id); }
        token = next;
        continuationId = nextId;
    }
    assert.equal(allIds.size, 200);
    assert.equal(checked.length, 200, "later batches complete all deferred research without a silent candidate cap");
});

test("broad and named discovery both pass their cancellation signal into shared pricing", async () => {
    const optionsPassed: string[][] = [];
    const source = (options: Parameters<typeof createScreeningPriceSource>[0]) => {
        assert.ok(options?.signal instanceof AbortSignal);
        optionsPassed.push(Object.keys(options));
        return { ...createScreeningPriceSource(options), lookupQueryCards: async () => ({ cards: [], complete: true }) };
    };
    // These injected screens use saved evidence and do not call the provider.
    await findDeals("Aquapolis", { automaticPhotos: true }, offlineSearchSteps([], { priceSource: source }));
    await findDeals("Espeon Aquapolis", { automaticPhotos: true }, offlineSearchSteps([], { priceSource: source }));
    assert.deepEqual(optionsPassed, [["signal"], ["signal"]]);
});

test("fresh resale prioritizes rough titles without dropping another physical copy", () => {
    const unclear = (id: string, name: string, number: string) => ({ ...listing(id, number + " shiny card"),
        screen: { status: "UNSCREENED" as const, incomplete: true, reason: null, assumed: null, bestCase: null,
            card: { name, set: "Aquapolis", cardNumber: number, printing: "UNKNOWN" as const, printingLabel: null } } });
    const rows = [unclear("one", "Nidoking", "24/147"), unclear("same", "Nidoking", "24/147"),
        unclear("another", "Espeon", "11/147"), listing("other", "Unknown holo"),
        { ...listing("no-photo", "Missing photo"), images: [] }];
    assert.deepEqual(freshResaleCandidates(rows, { minProfit: 0, minRoi: 0 }, Date.now()).map(r => r.id),
        ["one", "another", "other", "same"]);
});

test("photo priority distinguishes comparable upside, possible printings, unknown prices and priced misses", () => {
    const now = Date.parse("2026-11-25T20:00Z"), targets = { minProfit: 0, minRoi: 0 };
    const copy: ListingSummary = { ...listing("single", "Drifloon 51/156 Ultra Prism"), currentPrice: 4, shipping: 0,
        screen: { status: "UNSCREENED", bestCase: null, reason: null, assumed: null,
            card: { name: "Drifloon", set: "Ultra Prism", cardNumber: "51/156", printing: "UNKNOWN", printingLabel: null },
            soldEvidence: { status: "AVAILABLE", exactScope: true, note: "", references: [{ recordId: 1, name: "Drifloon",
                set: "Ultra Prism", cardNumber: "51/156", printing: "UNLIMITED", finish: "REVERSE_HOLO",
                grader: null, grade: null, condition: "NEAR_MINT", summary: { grader: "RAW", grade: "NEAR_MINT",
                    count: 2, low: 20, high: 20, median: 20, newestSale: new Date(now).toISOString(), windowDays: 60,
                    confidence: "LOW", dropped: {}, sales: [] } }] } } };
    const band = (row: ListingSummary) => resaleReviewPriority(row, targets, now);
    assert.equal(band(copy), resaleReviewBand.matchedUpside);
    assert.equal(band({ ...copy, currentPrice: 100 }), resaleReviewBand.belowTarget);
    assert.equal(band({ ...copy, shipping: null }), resaleReviewBand.unresolved);
    assert.equal(band({ ...copy, currentPrice: 100, mistakes: [{ kind: "SET", detail: "Two different release claims" }] }), resaleReviewBand.unresolved);
    assert.equal(band({ ...copy, currentPrice: 100, screen: { ...copy.screen!, gradingLead: { grader: "PSA", grade: 9 } } }), resaleReviewBand.possibleUpside);
    copy.screen!.soldEvidence!.exactScope = false;
    assert.equal(band(copy), resaleReviewBand.possibleUpside);
    copy.screen!.card = { ...copy.screen!.card!, name: null, set: null, cardNumber: "51" };
    assert.equal(band(copy), resaleReviewBand.unresolved, "a query plus a partial number cannot price an unidentified copy");
});

test("hunt inventory drains every retained and deferred copy before advancing its source cursor", async () => {
    const { createHuntInventoryScanner } = await import("../../server/deals/find-deals.ts");
    const rows = Array.from({ length: 240 }, (_, i) => listing(`copy-${i}`, "Nidoking 11/102 Base Set Unlimited Holo English"));
    const offsets: number[] = [], checked: string[] = [], accounts = new Set<string | undefined>();
    const root = randomUUID();
    const { getBudgetContext } = await import("../../server/ai/usage-context.ts");
    const scan = createHuntInventoryScanner(new AbortController().signal, offlineSearchSteps([], {
        search: async (_query, options) => {
            const offset = options?.offset ?? 0;
            offsets.push(offset); accounts.add(getBudgetContext().searchId);
            return { listings: rows.slice(offset, offset + 200), total: rows.length, skipped: 0, rejections: [],
                ...(offset === 0 && { nextOffset: 200 }) };
        },
        soldScreening: () => async row => {
            checked.push(row.id); accounts.add(getBudgetContext().searchId);
            return { status: "UNAVAILABLE", exactScope: false, references: [], note: "Offline missing price remains researchable." };
        },
    }));
    const intent = { cardName: null, sets: [], cardNumber: null, printing: null, graded: null, titleWords: [], source: "rules" as const };
    const all: string[] = [], found: number[] = [];
    let hasMore = true;
    while (hasMore) {
        const batch = await withAiUsageContext({ searchId: root }, () => scan("Pokemon", intent,
            { typeFilter: "FIXED_PRICE" }, { minProfit: 0, minRoi: 0 }, 1_795_560_000_000,
            { excludeIds: new Set(all), freshGrading: false, freshListings: true }));
        all.push(...batch.listings.map(row => row.id)); found.push(batch.summary.found);
        hasMore = batch.hasMore === true;
        if (all.length <= 200) assert.deepEqual(offsets, [0], "pending copies must drain before the next source request");
    }
    assert.equal(all.length, 240);
    assert.equal(new Set(all).size, 240);
    assert.equal(checked.length, 240);
    assert.deepEqual(offsets, [0, 200]);
    assert.deepEqual(found, [200, 0, 0, 0, 40], "pending batches do not inflate observed discovery counts");
    assert.deepEqual([...accounts], [root]);
});
