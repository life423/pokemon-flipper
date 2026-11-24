import "../fixtures/isolated-data.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ListingSummary } from "../../shared/types.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { chooseReviewSelection, ruleSelection } from "../../server/deals/search-review-selection.ts";

const rows: ListingSummary[] = Array.from({ length: 50 }, (_, i) => ({
    id: String(i + 1), title: `Dark Alakazam copy ${i + 1}`, currentPrice: 25 + i, shipping: 5, bids: 0,
    isGraded: false, buyingOption: "FIXED_PRICE", endTime: null, images: ["front", "back"], url: "#", seller: null,
}));
const lastFifteen = Array.from({ length: 15 }, (_, i) => 50 - i);

test("one bounded, text-only selection ranks all 50 server rows and concurrent callers and replays reuse its answer", async () => {
    let dispatched = 0;
    const cache = new Map<string, unknown>();
    const run = createModelExperimentRunner({ cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            dispatched++;
            assert.equal(request.photos.length, 0);
            assert.equal(request.maxRetries, 0);
            assert.match(request.prompt, /Dark Alakazam copy 50/);
            assert.equal(request.maxOutputTokens, 180);
            return { result: { rows: lastFifteen }, usage: { inputTokens: 100, outputTokens: 48 } };
        } });
    const review = () => chooseReviewSelection(rows, undefined, undefined, 100, run);
    const expected = { source: "ai", listingIds: lastFifteen.map(String) };
    await withAiUsageContext({ searchId: randomUUID() }, async () => {
        assert.deepEqual(await Promise.all([review(), review()]), [expected, expected]);
        assert.deepEqual(await review(), expected);
    });
    assert.equal(dispatched, 1);
    assert.deepEqual(await chooseReviewSelection(rows.slice(0, 15), undefined, undefined, 100, run), ruleSelection(rows));
    assert.equal(dispatched, 1, "all fifteen are selected without a ranking charge");
});

test("malformed, padded, duplicate, foreign or missing picks and a paused provider retain the original rules order", async () => {
    for (const result of [{ rows: [...lastFifteen, 1] }, { rows: lastFifteen.slice(1) }, { rows: [...lastFifteen.slice(1), 36] },
        { rows: [...lastFifteen.slice(1), 51] }, { rows: [...lastFifteen.slice(1), "35"] }, {}]) {
        const selection = await chooseReviewSelection(rows, undefined, undefined, 100, async ({ validate }) => ({
            result: validate(result), key: "answer", reused: false, answeredAt: "", usage: { inputTokens: 100, outputTokens: 32 },
        }));
        assert.deepEqual(selection, ruleSelection(rows));
    }
    assert.deepEqual(await chooseReviewSelection(rows, undefined, undefined, 100, async () => { throw Error("AI_PAUSED"); }), ruleSelection(rows));
    const abort = new AbortController();
    await assert.rejects(chooseReviewSelection(rows, undefined, abort.signal, 100, async () => {
        abort.abort(new Error("buyer stopped")); throw Error("canceled");
    }), /buyer stopped/);
});

test("fallback prioritizes fresh grade leads by eBay time and distinct photos, including copies without a condition label", () => {
    const now = Date.now();
    const date = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const fresh = { ...rows[49], listedAt: date(10), cardCondition: "Near Mint",
        screen: { gradingLead: { grader: "PSA" as const, grade: 8 } } } as ListingSummary;
    const newest = { ...fresh, id: "underdescribed", listedAt: date(1), cardCondition: null };
    const singlePhoto = { ...fresh, id: "thumbnail-pair", listedAt: date(0),
        images: ["https://i.ebayimg.com/images/g/example/s-l500.jpg", "https://i.ebayimg.com/images/g/example/s-l1600.jpg"] };
    const old = { ...fresh, id: "old", listedAt: date(25 * 60), createdAt: date(1) };
    const undated = { ...fresh, id: "undated", listedAt: undefined };
    const damaged = { ...fresh, id: "disclosure", listedAt: date(0), conditionNotes: ["Seller description: The card has a crease."] };
    const pool = [...rows.slice(0, 42), singlePhoto, old, undated, damaged, fresh, newest];
    const picks = ruleSelection(pool, now).listingIds;
    assert.deepEqual(picks.slice(0, 2), [newest.id, fresh.id]);
    assert.ok([singlePhoto, old, undated, damaged].every(row => !picks.includes(row.id)));
});
