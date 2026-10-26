import { test } from "node:test";
import assert from "node:assert/strict";
import { analysisPriority, compareAnalysisPriority } from "../../shared/analysis-priority.ts";
import { retargetScreen } from "../../shared/money/targets.ts";

const any = { minProfit: 0, minRoi: 0 };
const candidate = (id, { path = "GRADE", price = 100, net = 500, fixed = path === "GRADE" ? 100 : 0, photos = 4, count = 10, confidence = "HIGH", main = "MATCH", floorNet, downsideNet, shipping = 5, extra = {} } = {}) => ({
    id, currentPrice: price, shipping, images: Array.from({ length: photos }, (_, i) => `photo-${i}`), buyingOption: "FIXED_PRICE", isGraded: path === "GRADED_RESALE",
    screen: { status: "CANDIDATE", bestCase: { maxBid: 99999, profit: 50000, roi: 999 }, evidence: { photos, mainPhoto: main },
        money: { shipping: shipping ?? 7, rawFloorNet: floorNet, paths: [{ path, label: path, expectedNet: net, fixedCosts: fixed, compCount: count, compConfidence: confidence, downsideNet }] } }, ...extra,
});

test("lower-condition raw resale meeting targets comes before an enormous speculative grading margin", () => {
    const raw = candidate("raw", { path: "RAW", net: 200, floorNet: 140 });
    const grade = candidate("grade", { net: 100000 });
    assert.equal(analysisPriority(raw, any).band, 3);
    assert.equal(analysisPriority(grade, any).band, 1);
    assert.deepEqual([grade, raw].sort((a, b) => compareAnalysisPriority(a, b, any)).map((value) => value.id), ["raw", "grade"]);
    assert.equal(grade.screen.bestCase.profit, 50000, "priority never rewrites money or verdicts");
});

test("actual targets change the queue priority; profitable below-target raw resale does not outrank a qualifying path", () => {
    const raw = candidate("raw", { path: "RAW", net: 130, floorNet: 120 });
    const grade = candidate("grade", { net: 500 });
    const targets = { minProfit: 100, minRoi: 0.25 };
    assert.equal(analysisPriority(raw, any).band, 3);
    assert.equal(analysisPriority(raw, targets).band, 0);
    assert.ok(compareAnalysisPriority(grade, raw, targets) < 0);
});

test("clearer photo evidence and supported comps outrank an equally speculative jackpot", () => {
    const credible = candidate("credible");
    const speculative = candidate("speculative", { net: 100000, photos: 1, main: "CANT_TELL", count: 1, confidence: "LOW", shipping: null });
    assert.ok(compareAnalysisPriority(credible, speculative, any) < 0);
    assert.equal(analysisPriority(candidate("unknown", { count: 100, confidence: "NONE" }), any).evidence,
        analysisPriority(candidate("no-sales", { count: 0 }), any).evidence);
});

test("sparse slab comps do not provide a conservative-sale priority, and raw quotes never stand in for slab comps", () => {
    const sparse = candidate("slab", { path: "GRADED_RESALE", count: 1, net: 300, downsideNet: 200, floorNet: 10000 });
    assert.equal(analysisPriority(sparse, any).band, 2);
    assert.equal(analysisPriority(sparse, any).conservativeProfit, null);
    assert.equal(analysisPriority(candidate("supported", { path: "GRADED_RESALE", count: 10, downsideNet: 200 }), any).band, 3);
});

test("lower capital breaks otherwise comparable profit and evidence ties", () => {
    const smaller = candidate("small", { path: "RAW", price: 100, net: 134.17 });
    const larger = candidate("large", { path: "RAW", price: 300, net: 350.67 });
    assert.equal(analysisPriority(smaller, any).expectedProfit, analysisPriority(larger, any).expectedProfit);
    assert.ok(compareAnalysisPriority(smaller, larger, any) < 0);
});

test("pending unusual prices stay unranked for auto analysis and tie ordering is deterministic with missing metadata", () => {
    const pending = candidate("pending", { floorNet: 10000 });
    pending.screen.priceAnomaly = { referencePrice: 1000, photoChecked: false };
    assert.equal(analysisPriority(pending, any).band, 0);
    const a = { id: "a", currentPrice: 5, shipping: null, images: [], screen: { status: "UNSCREENED" } };
    const b = { ...a, id: "b" };
    assert.ok(Number.isFinite(compareAnalysisPriority(a, b, any)));
    assert.deepEqual([b, a].sort((x, y) => compareAnalysisPriority(x, y, any)).map((value) => value.id), ["a", "b"]);
});

test("target repricing preserves queue evidence and sorting performs no provider calls", (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", () => { requests += 1; throw new Error("must not fetch"); });
    const listing = candidate("raw", { path: "RAW", floorNet: 150 });
    const screen = retargetScreen(listing.screen, listing.currentPrice, any);
    assert.equal(screen.money, listing.screen.money);
    assert.equal(screen.evidence, listing.screen.evidence);
    assert.deepEqual(analysisPriority({ ...listing, screen }, any), analysisPriority(listing, any));
    [listing, candidate("grade")].sort((a, b) => compareAnalysisPriority(a, b, any));
    assert.equal(requests, 0);
});

test("duplicate photos and resized copies do not imply stronger photo coverage", async () => {
    const { availablePhotoCount } = await import("../../shared/analysis-priority.ts");
    const a = "https://i.ebayimg.com/images/g/front/s-l225.jpg";
    const b = "https://i.ebayimg.com/images/g/front/s-l1600.jpg";
    assert.equal(availablePhotoCount([a, a, b]), 1);
    assert.equal(availablePhotoCount([a, b, "https://i.ebayimg.com/images/g/back/s-l1600.jpg"]), 2);
    const listing = candidate("duplicate");
    listing.images = [a, a, b];
    delete listing.screen.evidence;
    const single = { ...listing, images: [a] };
    assert.equal(analysisPriority(listing, any).evidence, analysisPriority(single, any).evidence);
});

test("an inconsistent higher played-condition quote cannot manufacture conservative priority", () => {
    const inconsistent = candidate("inverted", { path: "RAW", net: 80, floorNet: 500 });
    assert.equal(analysisPriority(inconsistent, any).band, 0);
    assert.ok(analysisPriority(inconsistent, any).conservativeProfit < 0);
});
