import test from "node:test";
import assert from "node:assert/strict";
import { cheapestComparableFirst, sampleRawAsks } from "../../shared/bin-market-comparison.ts";
import { selectFlipPreviews } from "../../server/deals/flip-preview-selection.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";
import type { ListingSummary } from "../../shared/types.ts";

const now = Date.now(), stamp = new Date(now).toISOString();
function copy(id: string, price: number, overrides: Partial<ListingSummary> = {}): ListingSummary {
    return { id, title: "Ampharos 1/111 Neo Genesis Unlimited Holo English LP", currentPrice: price, shipping: 2,
        shippingDestination: "76133", termsCheckedAt: stamp, availability: "ACTIVE", buyingOption: "FIXED_PRICE",
        images: ["https://i.ebayimg.com/images/g/" + id + "/s-l1600.jpg"], isGraded: false, bids: 0, seller: null, url: "#",
        endTime: null, screen: { card: { name: "Ampharos", set: "Neo Genesis", cardNumber: "1/111", printing: "UNLIMITED" } } as ListingSummary["screen"],
        ...overrides };
}
test("active asks compare distinct copies within claimed scope before sold prices arrive", () => {
    const rows = [copy("a", 50), copy("b", 30), copy("c", 10, { shipping: null }), copy("d", 12, { shippingDestination: "98101" }),
        copy("e", 11, { cardCondition: "Damaged" }), copy("f", 8, { termsCheckedAt: "2000-01-01" })];
    const { samples, groups } = sampleRawAsks([...rows, rows[0]], now);
    assert.deepEqual(samples.get("a"), { observed: 3, missingShipping: 1, lowestOtherDelivered: 32, condition: "LIGHTLY_PLAYED",
        checkedAt: stamp, destination: "76133" });
    assert.equal(samples.get("b")!.lowestOtherDelivered, 52);
    assert.equal(samples.get("e")!.lowestOtherDelivered, null);
    assert.equal(samples.get("f"), undefined);
    assert.deepEqual(cheapestComparableFirst(rows, groups).map(row => row.id), ["b","a","c","d","e","f"]);
});
test("visual ranking ties observations to seen previews, reuses accepted pixels and keeps skipped copies", async () => {
    const rows = [copy("a",50),copy("b",30),copy("c",10)], cache = new Map<string, unknown>();
    let calls = 0, changed = false;
    const run = createModelExperimentRunner({ cached: async key => cache.get(key) ?? null, save: async (key,v) => { cache.set(key,v); },
        run: async request => {
            calls++;
            assert.equal(request.photos.length, 3);
            return { usage: { inputTokens: 1, outputTokens: 1 }, result: { leads: [{
                id: changed ? "not-a-seen-copy" : "b", observation: "Legible number on front", question: "Is the back edge worn?" }] } };
        } });
    const select = () => selectFlipPreviews(rows, { minProfit: 0, minRoi: 0 }, new AbortController().signal, now,
        async url => "data:image/jpeg;base64," + Buffer.from(url + changed).toString("base64"), run);
    await withAiUsageContext({ searchId: "64d3f1e4-e655-422e-8755-fb933bf9b618" }, async () => {
        const first = await select();
        assert.deepEqual(first.cheapest, ["c","b","a"]);
        assert.deepEqual(first.leads.map(lead => lead.id), ["b"]);
        assert.equal((await select()).reused, true);
        assert.equal(calls, 1);
        changed = true;
        assert.deepEqual((await select()).leads, []);
        assert.equal(calls, 2);
    });
});
