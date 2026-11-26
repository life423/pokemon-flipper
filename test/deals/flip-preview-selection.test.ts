import test from "node:test";
import assert from "node:assert/strict";
import { cheapestComparableFirst, sampleRawAsks } from "../../shared/bin-market-comparison.ts";
import { orderFlipPreviewCopies, selectFlipPreviews } from "../../server/deals/flip-preview-selection.ts";
import { salesSummary } from "../fixtures/card-evaluation.ts";
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

test("a lone possible seller mistake can earn gallery review from a distinct alternate view", async () => {
    const row = copy("mistitled", 42, { researchIdentity: true });
    const first = row.images[0];
    const alternate = first.replace("mistitled", "alternate");
    const smaller = alternate.replace("1600", "500");
    row.images.push(first.replace("1600", "500"), smaller);
    const fetched: string[] = [];
    let calls = 0;
    const run = createModelExperimentRunner({ cached: async () => null, save: async () => {}, run: async request => {
        calls++;
        assert.deepEqual(request.photos.map(photo => photo.label), ["mistitled · photo 3"]);
        assert.ok(request.maxOutputTokens! > 320);
        return { usage: { inputTokens: 1, outputTokens: 1 }, result: { leads: [{
            id: row.id, observation: "Photo 3 shows a different collector number.", question: "Which set mark is visible on the original front?" }] } };
    } });
    const select = (rows: ListingSummary[]) => selectFlipPreviews(rows, { minProfit: 0, minRoi: 0 }, new AbortController().signal, now,
        async (url, _signal, size) => {
            fetched.push(url);
            assert.equal(size, 1024);
            if (url !== smaller) throw new Error("Photo unavailable");
            return "data:image/jpeg;base64,AA==";
        }, run);
    await withAiUsageContext({ searchId: "64d3f1e4-e655-422e-8755-fb933bf9b618" }, async () => {
        assert.equal((await select([copy("ordinary", 42)])).source, "rules");
        const result = await select([row]);
        assert.deepEqual(result.seen, [row.id]);
        assert.deepEqual(result.leads.map(lead => lead.id), [row.id]);
        assert.deepEqual(fetched, [first, alternate, smaller]);
        assert.equal(calls, 1);
    });
});

test("flagged listings beyond the ordinary four get previews and all other copies remain queued", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => copy("copy" + i, 20 + i, i >= 4 ? { researchIdentity: true } : {}));
    const run = createModelExperimentRunner({ cached: async () => null, save: async () => {}, run: async request => {
        assert.equal(request.photos.length, 6);
        return { usage: { inputTokens: 1, outputTokens: 1 }, result: { leads: [] } };
    } });
    await withAiUsageContext({ searchId: "64d3f1e4-e655-422e-8755-fb933bf9b618" }, async () => {
        const result = await selectFlipPreviews(rows, { minProfit: 0, minRoi: 0 }, new AbortController().signal, now,
            async () => "data:image/jpeg;base64,AA==", run);
        assert.ok(["copy4", "copy5", "copy6"].every(id => result.seen.includes(id)));
        assert.deepEqual(result.cheapest, rows.map(row => row.id));
    });
});

test("a cheap, visibly worn copy keeps its place in research but a comparable front gets the first gallery check", () => {
    const cheap = copy("worn", 20), other = copy("ordinary", 35);
    const unrelated = copy("unrelated", 40);
    unrelated.screen = { ...other.screen!, card: { ...other.screen!.card!, name: "Umbreon" } };
    const rows = [cheap, unrelated, other];
    const order = (observation: string) => orderFlipPreviewCopies(rows, {
        seen: rows.map(row => row.id), cheapest: rows.map(row => row.id),
        leads: [{ id: cheap.id, observation, question: "Could a close-up reveal deep creases?" }],
    }, { minProfit: 0, minRoi: 0 }, now);
    for (const observation of ["The front shows substantial edge/corner wear.", "Multiple diagonal creases cross the card."])
        assert.deepEqual(order(observation), ["ordinary", "unrelated", "worn"]);
    for (const observation of ["Visible glare.", "No visible creases.", "The sleeve has heavy wear.", "The back is missing."])
        assert.deepEqual(order(observation), ["worn", "unrelated", "ordinary"]);

    const summary = { ...salesSummary("RAW", "DAMAGED", [100, 110, 120]), newestSale: stamp, windowDays: 60 };
    for (const row of [cheap, other]) row.screen = { ...row.screen!, soldEvidence: { status: "AVAILABLE", exactScope: true, note: "",
        references: [{ recordId: 1, name: "Ampharos", set: "Neo Genesis", cardNumber: "1/111", printing: "UNLIMITED",
            finish: "HOLO", condition: "DAMAGED", grader: null, grade: null, summary }] } };
    assert.deepEqual(order("Multiple diagonal creases."), ["worn", "unrelated", "ordinary"],
        "a comparable Damaged sale that covers costs preserves priority");
});
