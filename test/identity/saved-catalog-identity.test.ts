import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Evaluation, ListingSummary } from "../../shared/types.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import { createBuyerListingReviewer } from "../../server/analysis/wait-skip-review.ts";
import { createBoundedEvaluator } from "../../server/analysis/bounded-evaluate.ts";
import { boundedAssessmentPlan } from "../../server/analysis/bounded-plan.ts";
import { createPrivateEvaluationStore, evaluationContextKey } from "../../server/analysis/private-evaluation.ts";
import { recheckSavedCatalogIdentity } from "../../server/identity/saved-catalog-identity.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { readSearchLocally } from "../../server/search/intent.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { compProblem, matchesSoldTarget } from "../../server/pricing/sold-comps.ts";

const searchId = "2b6a297f-dcdd-4e4c-ab12-1c1339d30311";
const targets = { minProfit: 0, minRoi: 0 };
const now = Date.now(), stamp = new Date(now).toISOString();
const unexpected = async () => assert.fail("No live provider should be called while replaying saved identity.");

function rejected({ title, sellerName, name, number, finish = "NON_HOLO", sellerSet = "Aquapolis", listedNumber = number,
    listedFinish = finish === "NON_HOLO" ? "Regular" : finish, reason, notes = [] }: { title: string; sellerName?: string; name: string; number: string;
        finish?: "HOLO" | "NON_HOLO" | "REVERSE_HOLO"; sellerSet?: string; listedNumber?: string; listedFinish?: string;
        reason?: string; notes?: string[] }) {
    const e = cardEvaluation();
    const photos = ["a", "b", "c", "d"].map(key => `https://i.ebayimg.com/images/g/saved-identity-${key}/s-l1600.jpg`);
    const aspects = { ...(sellerName && { "Card Name": sellerName }), Set: sellerSet, "Card Number": listedNumber,
        Language: "English", ...(listedFinish && { Finish: listedFinish }) };
    Object.assign(e, { answeredAt: stamp, assessmentVersion: "gpt-5.6-luna/bounded-prompts-4", pricesCheckedAt: stamp });
    Object.assign(e.listing, { id: "v1|saved-aquapolis|0", title, price: 15, availability: "ACTIVE", termsCheckedAt: stamp,
        shipping: 0, buyingOption: "FIXED_PRICE", bestOffer: false, endTime: null, photos, aspects });
    Object.assign(e.identity!, { status: "NEEDS_REVIEW", name: null, cardNumber: null, set: sellerSet, printing: "UNKNOWN",
        notThisCard: reason ?? `the photos show ${name} #${number} from Aquapolis` });
    Object.assign(e.photoCheck!, { printedName: name, printedNumber: number, cardCount: "ONE",
        cardMatch: reason ? { verdict: "MISMATCH", problems: [reason] } : { verdict: "MATCH", problems: [] },
        cardIdentity: { name, set: "Aquapolis", cardNumber: number, finish, language: "English", confidence: "HIGH", evidence: ["The readable front shows the name, number and release."] },
        printingMarks: { firstEditionStamp: "NOT_PRESENT", reprintMark: "NONE_SEEN", artBoxShadow: "CANT_TELL", evidence: [] }, problems: notes });
    return e;
}

function record(name: string, cardNumber: string, finish = "NON_HOLO"): CardRecord {
    return { source: "pkmnprices", id: 123, name, cardNumber, setName: "Aquapolis",
        variants: [{ name: finish === "HOLO" ? "Holofoil" : finish === "REVERSE_HOLO" ? "Reverse Holofoil" : "Normal", printing: "UNLIMITED", finish }] };
}

const nidoran = () => rejected({ title: "2002 Pokémon Nidoran M 096/147 Aquapolis", sellerName: "Nidoranm", name: "Nidoran ♂", number: "096/147" });
const nidoranRecord = record("Nidoran M", "096/147");

test("captured Aquapolis identity shapes preserve accepted evidence and require the exact catalog", async () => {
    const grass = rejected({ title: "Grass Cube 124/147 Uncommon Aquapolis Pokemon 2003 MP Tagawa", sellerName: "Grass Cube",
        name: "Grass Cube 01", number: "124/147", listedFinish: "" });
    Object.assign(grass.listing.aspects, { Rarity: "Uncommon", Illustrator: '"Big Mama" Tagawa' });
    const cases: [Evaluation, CardRecord, string | null][] = [
        [nidoran(), nidoranRecord, "Nidoran M"],
        [grass, record("Grass Cube 01", "124/127"), null],
        [rejected({ title: "Exeggcute (76) AQ - 76/147 LP Pokemon TCG", sellerName: "Exeggcute (76)", name: "Exeggcute", number: "76/147" }), record("Exeggcute", "076/147"), "Exeggcute"],
        [rejected({ title: "GOLDUCK - 50a/147 - POKEMON AQUAPOLIS REVERSE HOLO RARE CARD MP", name: "Golduck",
            number: "50a/147", sellerSet: "Pokémon GO", finish: "REVERSE_HOLO",
            notes: ["The back is now supplied, but the front remains only in partial close-ups and the holder limits complete edge/corner inspection."] }), record("Golduck", "050a/147", "REVERSE_HOLO"), "Golduck"],
        [rejected({ title: "Donphan 7/147 Aquapolis Non-Holo Rare 2003 WOTC E-Reader Pokemon Card LP", sellerName: "Donphan",
            sellerSet: "Expedition Base Set", number: "7/147", name: "Donphan",
            reason: "Visible/provided evidence identifies the card as Aquapolis 7/147, while the seller aspect claims Expedition Base Set." }), record("Donphan", "007/147"), "Donphan"],
        [rejected({ title: "Metal Cube 01 Uncommon Aquapolis 129/147 MP", sellerName: "Metal Cube 01", name: "Metal Cube 01",
            number: "129/147" }), { ...record("Metal Cube 01", "129/147"), variants: [] }, "Metal Cube 01"],
        [rejected({ title: "Metal Cube 129/147 Uncommon Aquapolis Pokemon Lightly Played", sellerName: "Metal Cube", name: "Metal Cube 01",
            number: "129/147" }), record("Metal Cube 01", "129/147"), "Metal Cube 01"],
        [rejected({ title: "Blissey Aquapolis H06/H32 Holo Rare English 2002 PSA 8", sellerName: "Blissey",
            name: "Blissey", number: "H06/H32", finish: "HOLO" }), record("Blissey (H6)", "H06/H32", "HOLO"), "Blissey (H6)"],
    ];
    Object.assign(cases.find(([e]) => e.listing.title.startsWith("Metal Cube 129"))![0].listing.aspects, { Rarity: "Uncommon" });
    for (const [e, card, expected] of cases) {
        const unchanged = structuredClone(e);
        const fixed = await recheckSavedCatalogIdentity(e, async () => [card]);
        assert.notEqual(fixed, e, e.listing.title);
        assert.equal(fixed.identity?.name, expected, e.listing.title);
        assert.equal(fixed.identity?.notThisCard, undefined);
        assert.equal(fixed.identity?.status, expected === null ? "NEEDS_REVIEW" : "IDENTIFIED");
        assert.equal(fixed.rawPricing, null);
        assert.equal(fixed.photoCheck, e.photoCheck);
        assert.equal(fixed.condition, e.condition);
        assert.deepEqual(e, unchanged);
    }
});

test("unproven or conflicting copies stay rejected with no catalog calls", async () => {
    for (const mutate of [
        (e: Evaluation) => { e.listing.title = "Nidoran F 096/147 Aquapolis"; },
        (e: Evaluation) => { e.listing.title = "Nidoran M 096/150 Aquapolis"; },
        (e: Evaluation) => { e.listing.title = "Nidoran M 096/147 Aquapolis unknown suffix"; },
        (e: Evaluation) => { e.listing.aspects!["Card Name"] = "Nidoran 2"; },
        (e: Evaluation) => { e.photoCheck!.cardIdentity!.confidence = "MEDIUM"; },
        (e: Evaluation) => { e.photoCheck!.printingMarks!.reprintMark = "WORLD_CHAMPIONSHIPS"; },
        (e: Evaluation) => { e.condition!.authenticity.concern = "LIKELY_FAKE"; },
    ]) {
        const e = nidoran();
        mutate(e);
        assert.equal(await recheckSavedCatalogIdentity(e, unexpected), e);
    }
    for (const extra of [" proxy", " replICA", " gold foil", " 25th anniversary reprint", " extra metal"] as const) {
        const e = rejected({ title: `Metal Cube 01 Aquapolis 129/147${extra}`, sellerName: "Metal Cube 01", name: "Metal Cube 01", number: "129/147" });
        assert.equal(await recheckSavedCatalogIdentity(e, unexpected), e, extra);
    }
});

test("only the exact printed metal card can supply a sold comparison", () => {
    const title = "Metal Cube 01 Uncommon Aquapolis 129/147 LP";
    const target = { name: "Metal Cube 01", setName: "Aquapolis", cardNumber: "129/147", requireTitleIdentity: true };
    const sale = { title, price: 10, sold_at: stamp, attribution: "exact" as const, currency: "USD", sale_type: "fixed_price" as const,
        grader: "RAW", grade: "LIGHTLY_PLAYED", grade_qualifier: null, variant: "Normal", listing_url: null };
    const criteria = { printing: "UNLIMITED" as const, grader: sale.grader, grade: sale.grade, setName: target.setName,
        cardName: target.name, cardNumber: target.cardNumber, now, finish: "NON_HOLO" };
    assert.equal(matchesSoldTarget(sale, target), true);
    assert.equal(compProblem(sale, criteria), null);
    for (const bad of [title + " proxy", title + " extra metal", title + " gold foil", title + " World Championships",
        title.replace("129/147", "129/150"), title.replace("Aquapolis", "Skyridge")]) {
        assert.equal(compProblem({ ...sale, title: bad }, criteria), "metal or novelty card", bad);
    }
});

test("saved buyer review replaces a legacy false Skip without provider research", async () => {
    const e = nidoran(), { id, title, price, shipping, photos, url } = e.listing;
    const listing: ListingSummary = { id, title, currentPrice: price, shipping, images: photos!, buyingOption: "FIXED_PRICE",
        isGraded: false, bids: 0, endTime: null, seller: null, url };
    const review = createBuyerListingReviewer({
        discovery: async () => ({ searchId, savedAt: stamp, discovery: { total: 1, found: 1, skipped: 0, deferred: 0, retainedIds: [id] } }),
        inventory: async () => ({ filters: {}, intent: readSearchLocally("Aquapolis"), rows: [{ listing, assessable: true }] }),
        snapshot: async () => ({ version: 1, searchId, contextKey: "fixture", evidenceKey: listingEvidenceKey(listing), evaluation: e }),
        recheckIdentity: value => recheckSavedCatalogIdentity(value, async () => [nidoranRecord]),
        restorePhotoReview: async value => value, restoreRaw: async () => undefined, restoreSales: async () => {},
        cached: async () => null, save: async () => {}, evaluate: unexpected, deeper: unexpected,
        supplement: async () => ({}), now: () => now,
    });
    const result = await review(searchId, id, targets, false, false, new AbortController().signal);
    assert.equal(result.decision, "WAIT");
    assert.equal(result.evaluation?.identity?.name, "Nidoran M");
    assert.ok(!result.evaluation?.identity?.notThisCard);
    assert.equal(result.evaluation?.photoCheck?.printedName, "Nidoran ♂");
});

test("bounded evaluation reuses its unchanged retained gallery when catalog identity changes", async () => {
    const e = nidoran(), { id, title, price, shipping, photos, url, aspects } = e.listing;
    const details: ListingDetails = { id, title, price, shipping, images: photos!, url, aspects: aspects!, availability: "ACTIVE", retrievedAt: stamp,
        buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null, condition: "Ungraded",
        cardCondition: null, conditionNotes: [] };
    const cache = new Map<string, any>();
    const cached = async (key: string) => cache.get(key) ?? null;
    const save = async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); };
    e.assessmentVersion = boundedAssessmentPlan(details).version;
    await createPrivateEvaluationStore({ cached, save }).save(e, { searchId,
        evidenceKey: listingEvidenceKey(details), contextKey: evaluationContextKey(details) });
    const evaluate = createBoundedEvaluator({ details: async () => details, saved: async () => null, cached, save,
        assess: unexpected, assertPriceAvailable: unexpected, lookupCached: async () => [nidoranRecord], lookup: async () => [nidoranRecord],
        fetchRawComps: async () => [], fetchComps: async () => [], fetchCachedComps: async () => [], compChecks: async () => new Map(), now: () => now });
    const result = await evaluate(id, { automatic: true, targets });
    assert.equal(result.identity?.name, "Nidoran M");
    assert.equal(result.photoCheck?.printedName, "Nidoran ♂");
    assert.equal(result.answeredAt, e.answeredAt);
    assert.ok(result.reusedSteps.includes("photoCheck"));
});

test("bounded replay keeps three corroborated Aquapolis metadata cases out of false Skip", async () => {
    const grass = rejected({ title: "Grass Cube 124/147 Uncommon Aquapolis Pokemon 2003 MP Tagawa", sellerName: "Grass Cube",
        name: "Grass Cube 01", number: "124/147", listedFinish: "",
        notes: ["Only the prior front photo and new photo 1 provide card evidence; new photos 2–4 are stock/promotional images."] });
    Object.assign(grass.listing.aspects, { Rarity: "Uncommon", Illustrator: '"Big Mama" Tagawa' });
    Object.assign(grass.photoCheck!.images[3], { view: "OTHER", isStockImage: true, usable: false });
    const fighting = rejected({ title: "Fighting Cube 01 121/147 Aquapolis - Uncommon Pokemon TCG Card - LP",
        sellerName: "Fighting Cube 01", name: "Fighting Cube 01", number: "121/147", listedNumber: "01", listedFinish: "" });
    Object.assign(fighting.listing.aspects, { Features: "1st Edition" });
    const juggler = rejected({ title: "Juggler 126 Uncommon Aquapolis Pokemon Moderately Played", sellerName: "Juggler", name: "Juggler",
        number: "126/147", listedNumber: "126", listedFinish: "",
        reason: "The photographed card is Juggler 126/147 from Aquapolis, while the seller claims card number 126; the set and identity otherwise match." });
    Object.assign(juggler.listing.aspects, { Rarity: "Uncommon" });
    for (const [e, card, status, reason] of [
        [grass, record("Grass Cube 01", "124/127"), "NEEDS_REVIEW", /no card.*124\/147/i],
        [fighting, record("Fighting Cube 01", "121/147"), "NEEDS_REVIEW", /first edition|1st edition/i],
        [juggler, record("Juggler", "126/147"), "IDENTIFIED", /corrected card number/i],
    ] as const) {
        const { id, title, price, shipping, photos, url, aspects } = e.listing;
        const details: ListingDetails = { id, title, price, shipping, images: photos!, url, aspects: aspects!, availability: "ACTIVE", retrievedAt: stamp,
            buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null, condition: "Ungraded", cardCondition: null, conditionNotes: [] };
        const cache = new Map<string, any>();
        const cached = async (key: string) => cache.get(key) ?? null;
        const save = async (key: string, value: unknown) => { cache.set(key, structuredClone(value)); };
        e.assessmentVersion = boundedAssessmentPlan(details).version;
        await createPrivateEvaluationStore({ cached, save }).save(e, { searchId,
            evidenceKey: listingEvidenceKey(details), contextKey: evaluationContextKey(details) });
        const evaluate = createBoundedEvaluator({ details: async () => details, saved: async () => null, cached, save,
            assess: unexpected, assertPriceAvailable: unexpected, lookupCached: async () => [card], lookup: async () => [card],
            fetchRawComps: async () => [], fetchComps: async () => [], fetchCachedComps: async () => [], compChecks: async () => new Map(), now: () => now });
        const result = await evaluate(id, { automatic: true, targets });
        assert.equal(result.identity?.status, status, title);
        assert.equal(result.identity?.notThisCard, undefined, title);
        assert.match(result.identity?.reasons.join(" ") ?? "", reason, title);
        assert.equal(result.answeredAt, e.answeredAt);
        assert.ok(result.reusedSteps.includes("photoCheck"));
        assert.ok(!result.underwriting?.verdict.startsWith("BUY"));
    }
    for (const change of [
        (e: Evaluation) => { e.listing.aspects!["Card Number"] = "126/150"; },
        (e: Evaluation) => { e.listing.title = "Juggler 126 Aquapolis 126/150"; },
        (e: Evaluation) => { e.photoCheck!.cardMatch!.problems.push("Another visible card was supplied."); },
    ]) {
        const e = structuredClone(juggler);
        change(e);
        assert.equal(await recheckSavedCatalogIdentity(e, unexpected), e);
    }
});
