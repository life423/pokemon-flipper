import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { rawMarketContext } from "../../shared/raw-market-context.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { applySoldPriceScreen } from "../../shared/money/sold-screen.ts";
import type { ListingSummary, ScreeningSoldReference } from "../../shared/types.ts";

const targets = { minProfit: 0, minRoi: 0 };
const reference = (): ScreeningSoldReference => ({ recordId: 1, name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED", finish: "HOLO",
    grader: null, grade: null, condition: null, summary: { grader: "RAW", grade: "UNSPECIFIED", count: 12, median: 69.815, mean: 70, low: 44.14, high: 100,
        newestSale: new Date(Date.now() - 86_400_000).toISOString(), confidence: "MEDIUM", windowDays: 90, sales: [], dropped: {} } });
function candidate(id: string, price: number, shipping: number | null = 0, photos = 4): ListingSummary {
    return { id, title: "Venusaur Base Set 15/102 Unlimited Holo English", currentPrice: price, shipping, buyingOption: "FIXED_PRICE", isGraded: false,
        endTime: null, bids: 0, url: "https://example.invalid/item", seller: null, images: Array.from({ length: photos }, (_, n) => `https://example.invalid/photo-${n}`),
        screen: { status: "UNSCREENED", reason: "Awaiting photos", card: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", printing: "UNLIMITED", printingLabel: null },
            bestCase: null, assumed: null, needsAnalysis: "IDENTITY", soldEvidence: { status: "AVAILABLE", exactScope: true, references: [reference()], note: "Unspecified raw condition" } } };
}

test("delivered asking and sold context put affordable ordinary raw leads ahead of expensive photo-rich rows", t => {
    t.mock.method(globalThis, "fetch", () => { throw new Error("Ranking must not buy research"); });
    const expensive = candidate("a", 164.99, 0, 14), affordable = candidate("z", 64.99, 0, 2);
    const before = JSON.stringify([expensive, affordable]);
    assert.ok(compareAnalysisPriority(affordable, expensive, targets) < 0);
    const priority = analysisPriority(affordable, targets);
    assert.equal(priority.band, 0); assert.equal(priority.expectedProfit, null); assert.equal(priority.conservativeProfit, null); assert.equal(priority.investment, null);
    assert.equal(priority.rawMarketContext?.deliveredAsking, 64.99); assert.equal(priority.rawMarketContext?.median, 69.815);
    assert.equal(affordable.screen?.money, undefined); assert.equal(affordable.screen?.bestCase, null);
    assert.equal(JSON.stringify([expensive, affordable]), before);
});

test("shipping is part of research cost; unknown shipping gets no new context boost", () => {
    const ordinary = candidate("ordinary", 65), highShipping = candidate("high-shipping", 10, 100), unknown = candidate("unknown", 10, null);
    assert.equal(rawMarketContext(highShipping)?.deliveredAsking, 110);
    assert.ok(compareAnalysisPriority(ordinary, highShipping, targets) < 0);
    assert.equal(rawMarketContext(unknown), null); assert.ok(compareAnalysisPriority(ordinary, unknown, targets) < 0);
});

test("tiny asks and seller damage remain researchable without outranking ordinary raw prospects", () => {
    const ordinary = candidate("ordinary", 65), tiny = candidate("tiny", 1), damaged = candidate("damaged", 30), hp = candidate("hp", 40);
    damaged.title += " Damaged"; hp.title += " HP";
    for (const value of [tiny, damaged, hp]) {
        assert.equal(analysisPriority(value, targets).contextPriority, false);
        assert.ok(compareAnalysisPriority(ordinary, value, targets) < 0);
        assert.equal(canAutoAnalyze(value), true, "priority must not turn a possible exception into a rejection");
    }
    assert.equal(rawMarketContext(tiny)?.caution, "UNUSUALLY_LOW");
    assert.equal(rawMarketContext(hp)?.caution, "SELLER_DAMAGE");
    const stats = candidate("stats", 60); stats.title += " 100 HP";
    assert.equal(rawMarketContext(stats)?.caution, null, "hit points are not seller damage");
    tiny.screen!.focusedReview = "CHEAP_FIRST_EDITION_BASE_SET";
    assert.equal(canAutoAnalyze(tiny), true);
});

test("saved seller condition and explicit card notes receive the same research caution as title damage", t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("Seller-condition priority must not call a provider"); });
    const ordinary = candidate("ordinary", 65);
    const rows = [candidate("condition-field", 30), candidate("condition-code", 30), candidate("card-note", 30), candidate("conflicting-mint", 30)];
    rows[0].cardCondition = "Heavily played (Poor)";
    rows[1].cardCondition = "DAMAGED";
    rows[2].conditionNotes = ["The card is damaged."];
    rows[3].title += " Mint"; rows[3].cardCondition = "HEAVILY_PLAYED";
    for (const row of rows) {
        const original = JSON.stringify(row);
        const priority = analysisPriority(row, targets);
        assert.equal(priority.rawMarketContext?.caution, "SELLER_DAMAGE", row.id);
        assert.equal(priority.contextPriority, false); assert.ok(compareAnalysisPriority(ordinary, row, targets) < 0);
        assert.equal(canAutoAnalyze(row), true, "seller claims change order, not assessment eligibility");
        assert.equal(priority.expectedProfit, null); assert.equal(priority.conservativeProfit, null); assert.equal(priority.band, 0);
        assert.equal(JSON.stringify(row), original, "saved card condition, notes and market facts remain unchanged");
    }
});

test("seller-condition conflicts remain inspectable without claiming a verified grade or condition", () => {
    const row = candidate("claims-disagree", 40); row.title += " NM"; row.cardCondition = "Lightly played (Excellent)";
    const original = JSON.stringify(row), priority = analysisPriority(row, targets);
    assert.equal(priority.rawMarketContext?.caution, "SELLER_CONDITION_CONFLICT");
    assert.equal(priority.contextPriority, false); assert.match(priority.reason, /Seller condition claims disagree/);
    assert.equal(canAutoAnalyze(row), true); assert.equal(priority.expectedProfit, null); assert.equal(row.screen?.money, undefined);
    assert.equal(JSON.stringify(row), original);
    const ambiguous = candidate("ambiguous", 40); ambiguous.cardCondition = "NM/LP";
    assert.equal(rawMarketContext(ambiguous)?.caution, "SELLER_CONDITION_CONFLICT"); assert.equal(canAutoAnalyze(ambiguous), true);
});

test("raw seller cautions order priced research independently of shipping or exact market context", t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("Research ordering must not call providers"); });
    for (const mode of ["ordinary-context", "unknown-shipping", "incomplete-scope"]) {
        for (const warning of ["HP", "DAMAGED", "CONFLICT"]) {
            const shipping = mode === "unknown-shipping" ? null : 0;
            const ordinary = candidate("ordinary", 50, shipping, 2), warned = candidate("warned", 50, shipping, 14);
            for (const row of [ordinary, warned]) {
                row.screen!.soldEvidence!.exactScope = mode !== "incomplete-scope";
                row.screen!.money = { shipping: 0, auction: false, bestOffer: false, usual: null,
                    paths: [{ path: "RAW", label: "Preliminary raw comparison", expectedNet: row === warned ? 400 : 200,
                        fixedCosts: 0, compCount: 10, compConfidence: "HIGH" }] };
            }
            if (warning === "HP") warned.title += " HP";
            else if (warning === "DAMAGED") warned.cardCondition = "DAMAGED";
            else { warned.title += " NM"; warned.cardCondition = "Lightly Played"; }
            const before = JSON.stringify([ordinary, warned]), eligible = canAutoAnalyze(warned);
            const priority = analysisPriority(warned, targets);
            assert.equal(priority.band, mode === "incomplete-scope" ? 0 : 2, `${mode}/${warning}`);
            assert.equal(priority.rawResearchCaution, warning === "CONFLICT" ? "SELLER_CONDITION_CONFLICT" : "SELLER_DAMAGE");
            if (mode !== "ordinary-context") assert.equal(priority.rawMarketContext, null);
            if (mode === "incomplete-scope") {
                assert.equal(priority.expectedProfit, null, "unresolved edition/finish cannot support priced priority");
                assert.equal(analysisPriority(ordinary, targets).expectedProfit, null);
            } else assert.ok(priority.expectedProfit! > analysisPriority(ordinary, targets).expectedProfit!);
            assert.ok(priority.evidence > analysisPriority(ordinary, targets).evidence);
            assert.ok(compareAnalysisPriority(ordinary, warned, targets) < 0, "caution precedes stronger photos and optimistic profit within the same financial band");
            assert.match(priority.reason, warning === "CONFLICT" ? /Seller condition claims disagree/ : /Seller describes heavy play or damage/);
            assert.equal(eligible, true); assert.equal(canAutoAnalyze(warned), eligible);
            assert.equal(JSON.stringify([ordinary, warned]), before, "seller claims, financial paths and eligibility remain unchanged");
        }
    }
});

test("LP-to-cleaner upside, unverified Mint claims and unknown conditions keep the ordinary raw research path", () => {
    for (const cardCondition of ["Lightly Played", "Near Mint", "Mint", null, "Unknown", "NM?"]) {
        const row = candidate("ordinary-upside", 50); row.cardCondition = cardCondition;
        const original = JSON.stringify(row), priority = analysisPriority(row, targets);
        assert.equal(priority.rawMarketContext?.caution, null, String(cardCondition)); assert.equal(priority.contextPriority, true);
        assert.equal(priority.rawResearchCaution, null);
        assert.equal(canAutoAnalyze(row), true); assert.equal(priority.expectedProfit, null); assert.equal(priority.investment, null);
        assert.equal(row.screen?.bestCase, null); assert.equal(row.screen?.money, undefined);
        assert.equal(JSON.stringify(row), original, "seller Mint never becomes an assessed condition or predicted grade");
    }
    const holder = candidate("holder-only", 50); holder.cardCondition = "Near Mint"; holder.conditionNotes = ["The holder is damaged, but the card is near mint."];
    assert.equal(analysisPriority(holder, targets).contextPriority, true, "holder damage cannot lower raw-card priority");
    assert.equal(analysisPriority(holder, targets).rawResearchCaution, null);
    const hitPoints = candidate("hit-points", 50); hitPoints.title += " 120 HP"; hitPoints.cardCondition = "Near Mint";
    assert.equal(analysisPriority(hitPoints, targets).contextPriority, true, "HP stats do not contradict the saved seller condition");
    assert.equal(analysisPriority(hitPoints, targets).rawResearchCaution, null);
});

test("an explicitly played listing does not borrow a better condition for paid queue priority", () => {
    const played = { ...candidate("played", 30), cardCondition: "Moderately Played" };
    const clean = { ...candidate("clean", 50), cardCondition: "Near Mint" };
    const comps = (condition: "NEAR_MINT" | "MODERATELY_PLAYED", median: number): ScreeningSoldReference => {
        const raw = reference();
        return { ...raw, condition, summary: { ...raw.summary, grade: condition, median, low: median, high: median } };
    };
    const evidence = { status: "AVAILABLE" as const, exactScope: true, note: "Recent sold titles",
        references: [comps("NEAR_MINT", 81), comps("MODERATELY_PLAYED", 23)] };
    const rankedPlayed = applySoldPriceScreen(played, evidence);
    const rankedClean = applySoldPriceScreen(clean, evidence);
    assert.equal(analysisPriority(rankedPlayed).band, 0);
    assert.equal(analysisPriority(rankedClean).band, 2);
    assert.ok(compareAnalysisPriority(rankedClean, rankedPlayed) < 0);
    assert.equal(canAutoAnalyze(rankedPlayed), true);
});

test("financial bands still take precedence over raw caution and slab research receives no raw penalty", () => {
    const warned = candidate("warned", 50), grade = candidate("grade", 50), slab = candidate("slab", 50);
    warned.cardCondition = "HEAVILY_PLAYED";
    for (const row of [warned, grade, slab]) row.screen!.money = { shipping: 0, auction: false, bestOffer: false, usual: null,
        paths: [{ path: row === grade ? "GRADE" : row === slab ? "GRADED_RESALE" : "RAW", label: "Existing research path", expectedNet: 250,
            fixedCosts: 0, compCount: 1, compConfidence: "LOW" }] };
    slab.isGraded = true; slab.cardCondition = "HEAVILY_PLAYED"; slab.conditionNotes = ["The holder is damaged."];
    assert.equal(analysisPriority(warned, targets).band, 2); assert.equal(analysisPriority(grade, targets).band, 1);
    assert.ok(compareAnalysisPriority(warned, grade, targets) < 0, "a seller clue cannot override the existing financial-band policy");
    assert.equal(analysisPriority(slab, targets).rawResearchCaution, null);
    assert.doesNotMatch(analysisPriority(slab, targets).reason, /Seller describes|Seller condition claims/);
    assert.equal(analysisPriority(slab, targets).band, 2);
    const staleCategory = { ...slab, isGraded: false };
    assert.equal(analysisPriority(staleCategory, targets).rawResearchCaution, null, "the existing slab resale route also protects a corrected seller category");
    assert.equal(analysisPriority(staleCategory, targets).expectedProfit, analysisPriority(slab, targets).expectedProfit);
    assert.equal(canAutoAnalyze(warned), true); assert.equal(canAutoAnalyze(slab), true);
});

test("raw market context never excludes above-median CGC/PSA grading upside or changes verdicts", () => {
    const row = candidate("grade-upside", 500);
    const source = row.screen!.soldEvidence!;
    const screened = applySoldPriceScreen(row, source, { targets });
    const before = JSON.stringify(screened);
    assert.equal(canAutoAnalyze(screened), true); assert.equal(analysisPriority(screened, targets).band, 0);
    assert.equal(JSON.stringify(screened), before); assert.notEqual(screened.screen.status, "DROPPED");
    for (const grader of ["PSA", "CGC"]) {
        const known = candidate(grader, 50);
        known.screen!.money = { shipping: 0, auction: false, bestOffer: false, usual: null,
            paths: [{ path: "GRADE", label: `Grade with ${grader}`, expectedNet: 250, fixedCosts: 50, compCount: 10, compConfidence: "HIGH" }] };
        assert.equal(analysisPriority(known, targets).band, 1);
        assert.ok(compareAnalysisPriority(known, candidate("unassessed", 40), targets) < 0);
    }
});

test("mixed identities, printings, finishes, slab references and ambiguous matches cannot borrow a raw context", () => {
    for (const change of [{ recordId: 2 }, { name: "Blastoise" }, { set: "Base Set 2" }, { cardNumber: "2/102" },
        { printing: "FIRST_EDITION" }, { finish: "REVERSE_HOLO" }, { grader: "PSA", grade: "8" }]) {
        const row = candidate("mixed", 50);
        row.screen!.soldEvidence!.references.push({ ...reference(), ...change } as ScreeningSoldReference);
        assert.equal(rawMarketContext(row), null, JSON.stringify(change));
    }
    for (const match of ["OTHER_CARD", "UNCONFIRMED_CRITERIA", "OTHER_LANGUAGE"]) {
        const row = candidate("mismatch", 50); row.match = match as ListingSummary["match"];
        assert.equal(rawMarketContext(row), null);
    }
    const partial = candidate("partial", 50); partial.screen!.soldEvidence!.exactScope = false; assert.equal(rawMarketContext(partial), null);
    const foreign = candidate("foreign", 50); foreign.title += " Japanese"; assert.equal(rawMarketContext(foreign), null);
    const auction = candidate("auction", 1); auction.buyingOption = "AUCTION"; assert.equal(rawMarketContext(auction), null);
    for (const change of [{ name: "Blastoise" }, { set: "Base Set 2" }, { cardNumber: "2/102" }, { printing: "FIRST_EDITION" }, { finish: "REVERSE_HOLO" }]) {
        const wrong = candidate("wrong-single-target", 50);
        Object.assign(wrong.screen!.soldEvidence!.references[0], change);
        if (change.finish) wrong.listedAttributes = { grader: null, grade: null, finish: "HOLO" };
        assert.equal(rawMarketContext(wrong), null, JSON.stringify(change));
    }
    const padded = candidate("padded", 50); padded.screen!.card!.cardNumber = "015/102";
    assert.ok(rawMarketContext(padded));
});

test("new raw context cannot reorder supported financial bands ahead of their existing evidence and profit rules", () => {
    const a = candidate("a", 50), b = candidate("b", 100);
    for (const row of [a, b]) row.screen!.money = { shipping: 0, auction: false, bestOffer: false, usual: null,
        paths: [{ path: "RAW", label: "Supported raw estimate", expectedNet: row.id === "a" ? 200 : 400, fixedCosts: 0, compCount: 10, compConfidence: "HIGH" }] };
    assert.equal(analysisPriority(a, targets).band, 2); assert.equal(analysisPriority(b, targets).band, 2);
    assert.equal(analysisPriority(a, targets).contextPriority, false);
    assert.ok(compareAnalysisPriority(b, a, targets) < 0, "supported expected profit keeps its existing priority within the priced band");
});

test("bad, empty, stale or future sold facts stay neutral; a known condition is not an unspecified bucket", () => {
    const changes = [
        { count: 0 }, { median: 0 }, { median: NaN }, { median: Infinity }, { confidence: "NONE" }, { windowDays: 181 }, { windowDays: NaN },
        { newestSale: new Date(Date.now() - 91 * 86_400_000).toISOString() }, { newestSale: new Date(Date.now() + 86_400_000).toISOString() }, { newestSale: null },
        { grade: "NEAR_MINT" }, { low: 1000 },
    ];
    for (const change of changes) {
        const row = candidate("bad", 50); Object.assign(row.screen!.soldEvidence!.references[0].summary, change);
        assert.equal(rawMarketContext(row), null, JSON.stringify(change));
        assert.ok(Number.isFinite(compareAnalysisPriority(row, candidate("normal", 65), targets)));
    }
    for (const price of [0, -1, NaN, Infinity]) assert.equal(rawMarketContext(candidate("bad-price", price)), null);
    const known = candidate("known", 50); const ref = known.screen!.soldEvidence!.references[0]; ref.condition = "NEAR_MINT"; ref.summary.grade = "NEAR_MINT";
    assert.equal(rawMarketContext(known), null);
});

test("single photos do not receive the new boost, and ordering stays deterministic and transitive", () => {
    const one = candidate("one", 40, 0, 1), two = candidate("two", 65, 0, 2);
    assert.equal(analysisPriority(one, targets).contextPriority, false); assert.ok(compareAnalysisPriority(two, one, targets) < 0);
    const rows = [one, two, candidate("cheap", 50), candidate("expensive", 165), candidate("unknown", 10, null), candidate("tiny", 1)];
    const compare = (a, b) => compareAnalysisPriority(a, b, targets);
    for (const a of rows) for (const b of rows) {
        assert.equal(Math.sign(compare(a, b)) + Math.sign(compare(b, a)), 0);
        for (const c of rows) if (compare(a, b) <= 0 && compare(b, c) <= 0) assert.ok(compare(a, c) <= 0);
    }
    assert.deepEqual([...rows].sort(compare).map(row => row.id), [...rows].reverse().sort(compare).map(row => row.id));
});
