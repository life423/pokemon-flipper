import { test } from "node:test";
import assert from "node:assert/strict";
import { prescreen } from "../../server/deals/prescreen.ts";
import { sellerCondition } from "../../shared/conditions.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";

const NOW = Date.parse("2026-09-30T00:00:00Z");

const LUGIA = toCardRecord({
    id: 28158,
    name: "Lugia",
    number: "009",
    total_set_number: "111",
    set: { id: 607, name: "Neo Genesis" },
    prices: [{ variant: "1st Edition Holofoil" }, { variant: "Unlimited Holofoil" }],
});

const sale = (price, soldAt, title) => ({
    price,
    sold_at: soldAt,
    sale_type: "fixed_price", // This controlled fixture models a confirmed transaction.
    variant: "Unlimited Holofoil",
    title,
    grader: "PSA",
    grade: "9",
    grade_qualifier: null,
    attribution: "exact",
    listing_url: null,
});

// Historical price examples with simulated confirmed transaction metadata; median $2,600.
const PSA9 = [
    sale(2325, "2026-07-26", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    sale(2600, "2026-07-17", "Pokemon 2000 Lugia 9/111 Holo Neo Genesis PSA 9 9/111 [eBay]"),
    sale(3350, "2026-07-12", "2000 Pokemon LUGIA #9/111 Neo Genesis Unlimited Cosmos Holo Rare English PSA 9 9/111 [eBay]"),
    sale(3200, "2026-06-21", "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO PSA 9 #9 [eBay]"),
    sale(2499.99, "2026-06-03", "Pokemon TCG Lugia Neo Genesis Holo Rare Card 9/111 PSA 9 Mint 9/111 [eBay]"),
];

const deps = {
    lookupCards: async () => [LUGIA],
    fetchComps: async (recordId, { grader, grade }) => (grader === "PSA" && String(grade) === "9" ? PSA9 : []),
    fetchRawComps: async (_recordId, variant) => {
        const first = variant === "1st Edition Holofoil";
        const quotes = first ? [["MP", 1134.84]] : [["NM", 531.39], ["LP", 446.25], ["MP", 315]];
        return quotes.flatMap(([condition, price]) => PSA9.slice(0, 3).map((item, index) => ({
            ...item, id: `${condition}-${index}`, price, variant, sold_at: "2026-09-25",
            title: `Lugia Neo Genesis ${first ? "1st Edition" : "Unlimited"} 9/111 Holo ${condition}`,
            grader: null, grade: null, currency: "USD",
        })));
    },
    config: { ...MONEY_CONFIG, targets: { minProfit: 50, minRoi: 0.25 } },
    now: NOW,
};

const rawLugia = (overrides = {}) => ({
    title: "Lugia 9/111 Neo Genesis Holo Rare Unlimited WOTC",
    aspects: { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English" },
    price: 300,
    shipping: 5,
    isGraded: false,
    cardCondition: "Near mint or better",
    ...overrides,
});

test("BGS and TAG slabs reach exact-grade pricing and automatic photo analysis even without sold data", async () => {
    for (const grader of ["BGS", "TAG"]) {
        const requests = [];
        const input = rawLugia({ title: `Lugia Neo Genesis Unlimited Holo 9/111 ${grader} 6.5`, isGraded: true,
            aspects: { ...rawLugia().aspects, "Professional Grader": grader, Grade: "6.5" }, price: 100 });
        const screen = await prescreen(input, { ...deps, fetchComps: async (_id, target) => {
            requests.push(target);
            return PSA9.slice(0, 3).map(sale => ({ ...sale, title: input.title, grader, grade: "6.5", price: 1000 }));
        } });
        assert.ok(requests.length > 0);
        assert.ok(requests.every(target => target.grader === grader && target.grade === "6.5"));
        assert.equal(screen.status, "CANDIDATE");
        assert.equal(screen.bestCase.label, `Resell as ${grader} 6.5`);
        const row = { id: grader, title: input.title, currentPrice: input.price, images: ["front"], screen };
        assert.equal(canAutoAnalyze(row), true);
        assert.equal(resultGroup(row, null), "candidates");
        const absent = await prescreen(input, { ...deps, fetchComps: async () => [] });
        assert.equal(absent.needsAnalysis, "PRICE_EVIDENCE");
        assert.equal(canAutoAnalyze({ ...row, screen: absent }), true);
        assert.equal(resultGroup({ ...row, screen: absent }, null), "candidates");
        const unavailable = await prescreen(input, { ...deps, fetchComps: async () => { throw new Error("No provider coverage for this grader"); } });
        assert.equal(canAutoAnalyze({ ...row, screen: unavailable }), true, "provider coverage cannot block AI and current comparisons");
    }
});

test("eBay's card conditions map to price conditions, and none means assume the best", () => {
    assert.equal(sellerCondition("Near mint or better"), "NEAR_MINT");
    assert.equal(sellerCondition("Lightly played (Excellent)"), "LIGHTLY_PLAYED");
    assert.equal(sellerCondition("Moderately played (Very good)"), "MODERATELY_PLAYED");
    assert.equal(sellerCondition("Heavily played (Poor)"), "HEAVILY_PLAYED");
    assert.equal(sellerCondition(null), "NEAR_MINT");
});

test("a raw card priced well under its best case is a candidate", async () => {
    const result = await prescreen(rawLugia(), deps);

    assert.equal(result.status, "CANDIDATE");
    assert.equal(result.card.printingLabel, "Unlimited");
    assert.equal(result.assumed, "Near Mint, grading 9 at best");
    assert.ok(result.bestCase.maxBid > 300);
});

test("negative raw sold context retains its math without rejecting missing grading upside", async () => {
    const result = await prescreen(rawLugia({ price: 2000 }), deps);

    assert.equal(result.status, "UNSCREENED");
    assert.equal(result.needsAnalysis, "PRICE_EVIDENCE");
    assert.equal(result.money.priceEvidenceIncomplete, true);
    assert.ok(result.bestCase.maxBid < 2000);
});

test("fully priced preliminary raw and grading routes can still reject a price that fails every target", async () => {
    const result = await prescreen(rawLugia({ price: 2000 }), { ...deps,
        fetchRawComps: async () => PSA9.slice(0, 3).map((item, index) => ({ ...item, id: index, price: 531.39,
            sold_at: "2026-09-25", title: "Lugia Neo Genesis Unlimited 9/111 Holo NM", grader: null, grade: null, currency: "USD" })),
        fetchComps: async (_recordId, { grader, grade }) => String(grade) === "9" ? PSA9.map(item => ({ ...item, grader,
            title: item.title.replace(/PSA/g, grader) })) : [],
    });
    assert.equal(result.status, "DROPPED");
    assert.equal(result.money.priceEvidenceIncomplete, undefined);
    assert.ok(result.bestCase.maxBid < 2000);
    assert.ok(result.money.paths.every(path => typeof path.downsideNet === "number"));
});

test("missing raw and graded sales do not establish a preliminary price", async () => {
    const listing = rawLugia({ title: "Lugia 9/111 Neo Genesis 1st Edition Holo", price: 500 });
    const result = await prescreen(listing, { ...deps, fetchComps: async () => [], fetchRawComps: async () => [] });
    assert.equal(result.status, "UNSCREENED");
    assert.equal(result.needsAnalysis, "PRICE_EVIDENCE");
    assert.equal(result.bestCase, null);
});

test("the seller's condition selects the preliminary sold cohort without substituting a better condition", async () => {
    // Lightly played: best grade 6, which has no sales, so only the raw
    // Lightly Played price counts.
    const result = await prescreen(rawLugia({ cardCondition: "Lightly played (Excellent)" }), deps);

    assert.equal(result.status, "UNSCREENED");
    assert.equal(result.bestCase.label, "Sell raw");
    assert.equal(result.bestCase.maxBid, 271.62);
    assert.equal(result.money.paths.find(path => path.path === "RAW").compCount, 3);
});

test("a card number in the title stands in when the item details skip it", async () => {
    const aspects = { Set: "Neo Genesis", "Card Name": "Lugia", Language: "English" };
    const result = await prescreen(rawLugia({ aspects }), deps);

    assert.equal(result.status, "CANDIDATE");
});

test("a listing with no card number anywhere can't be screened", async () => {
    const aspects = { Set: "Neo Genesis", "Card Name": "Lugia", Language: "English" };
    const result = await prescreen(rawLugia({ title: "Lugia Neo Genesis Holo WOTC", aspects }), deps);

    assert.equal(result.status, "UNSCREENED");
});

test("a slab is screened at its listed grader and grade", async () => {
    const slab = rawLugia({
        title: "Lugia Neo Genesis Unlimited Holo #9 PSA 9",
        isGraded: true,
        cardCondition: null,
        aspects: {
            Set: "Neo Genesis",
            "Card Number": "9/111",
            "Card Name": "Lugia",
            Language: "English",
            "Professional Grader": "Professional Sports Authenticator (PSA)",
            Grade: "9",
        },
    });

    const cheap = await prescreen({ ...slab, price: 1500 }, deps);
    const dear = await prescreen({ ...slab, price: 2000 }, deps);

    assert.equal(cheap.status, "CANDIDATE");
    assert.equal(cheap.assumed, "PSA 9, as listed");
    assert.equal(dear.status, "DROPPED");
});

test("a 1st Edition claim is screened at 1st Edition prices", async () => {
    // The only 1st Edition price is Moderately Played, so a Near Mint
    // claim has nothing at or below it until Moderately Played.
    const result = await prescreen(rawLugia({ title: "Lugia 9/111 Neo Genesis 1st Edition Holo", price: 500 }), deps);

    assert.equal(result.card.printingLabel, "1st Edition");
    assert.equal(result.status, "CANDIDATE");
});

test("a cheap 1st Edition Base Set lead requests focused verification without claiming a deal", async () => {
    const machop = toCardRecord({ id: 1, name: "Machop", set: { name: "Base Set" }, number: "52", total_set_number: "102",
        prices: [{ variant: "Unlimited" }, { variant: "1st Edition" }] });
    const listing = rawLugia({ title: "Machop Base Set 52/102 1st Edition Non-Holo",
        aspects: { "Card Name": "Machop", Set: "Base Set", "Card Number": "52/102", Language: "English" }, buyingOption: "FIXED_PRICE" });
    const noSales = { lookupCards: async () => [machop], fetchRawComps: async () => [], fetchComps: async () => [] };

    for (const price of [3, 10]) {
        const result = await prescreen({ ...listing, price }, noSales);
        assert.equal(result.status, "UNSCREENED");
        assert.equal(result.needsAnalysis, "IDENTITY");
        assert.equal(result.card?.printing, "FIRST_EDITION");
        assert.equal(result.bestCase, null);
        assert.equal(result.focusedReview, "CHEAP_FIRST_EDITION_BASE_SET");
    }

    const aboveLimit = await prescreen({ ...listing, price: 10.01 }, noSales);
    const disproven = await prescreen({ ...listing, price: 5, photoMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" } }, noSales);
    for (const result of [aboveLimit, disproven]) {
        assert.equal(result.status, "UNSCREENED");
        assert.equal(result.needsAnalysis, "PRICE_EVIDENCE");
        assert.equal(result.focusedReview, undefined);
    }
});

test("a very cheap Buy It Now waits for photos without being labeled junk; auctions are exempt", async () => {
    // Lugia's cheapest raw price here is $315 (Moderately Played).
    let compCalls = 0;
    const pending = await prescreen(rawLugia({ price: 5, buyingOption: "FIXED_PRICE" }), { ...deps, fetchComps: async () => { compCalls += 1; return []; } });
    const auction = await prescreen(rawLugia({ price: 5, buyingOption: "AUCTION" }), deps);
    const cheapButReal = await prescreen(rawLugia({ price: 100, buyingOption: "FIXED_PRICE" }), deps);

    assert.equal(pending.junk, undefined);
    assert.equal(pending.status, "UNSCREENED");
    assert.deepEqual(pending.priceAnomaly, { referencePrice: 315, photoChecked: false });
    assert.match(pending.reason, /Photos are needed to verify the card/);
    assert.equal(compCalls, 0, "pending photos do not spend graded comp lookups");
    assert.equal(auction.priceAnomaly, undefined);
    assert.equal(cheapButReal.priceAnomaly, undefined);
    assert.equal(auction.junk, undefined);
    assert.equal(cheapButReal.junk, undefined);
});

test("a very cheap card resumes normal screening after photo verification", async () => {
    const verified = await prescreen(rawLugia({ price: 5, buyingOption: "FIXED_PRICE", photoVerified: true }), deps);
    assert.equal(verified.status, "CANDIDATE");
    assert.deepEqual(verified.priceAnomaly, { referencePrice: 315, photoChecked: true });
    assert.equal(verified.junk, undefined);
    assert.ok(verified.money.rawFloorNet > 0);
    assert.ok(verified.money.paths.some((path) => path.path === "RAW"));
    assert.ok(verified.money.paths.some((path) => path.path === "GRADE" && path.compCount >= 3));
});

test("a 1st Edition claim in the item details only is priced as what the main photo shows", async () => {
    // A real listing: "Features: 1st Edition" on an Unlimited Lugia.
    const aspects = { Set: "Neo Genesis", "Card Number": "9/111", "Card Name": "Lugia", Language: "English", Features: "1st Edition" };
    const claimed = await prescreen(rawLugia({ title: "Pokemon TCG Lugia 9/111 Neo Genesis Holo Rare English 2000 90HP", aspects, price: 250 }), deps);
    const seen = await prescreen(
        rawLugia({
            title: "Pokemon TCG Lugia 9/111 Neo Genesis Holo Rare English 2000 90HP",
            aspects,
            price: 250,
            photoMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" },
        }),
        deps
    );

    assert.equal(claimed.card.printingLabel, "1st Edition");
    assert.equal(seen.card.printingLabel, "Unlimited");
});
