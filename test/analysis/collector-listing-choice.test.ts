import assert from "node:assert/strict";
import test from "node:test";
import { chooseCollectorListing, type CollectorListingMenu } from "../../server/analysis/collector-listing-choice.ts";
import { createModelExperimentRunner } from "../../server/analysis/model-experiment.ts";

test("a live collector choice reuses identical menus and cannot reselect a rejected listing", async () => {
    const menu: CollectorListingMenu = {
        searchId: "85dcd150-e067-4c21-8e11-8d61211b195c", query: "English Charmeleon 169/165 PSA 9",
        asOf: "2026-11-24T20:30:00Z", target: 76, reference: { estimate: 76, count: 8 },
        candidates: [
            { id: "one", title: "Charmeleon 169 PSA 9", price: 65, shipping: null },
            { id: "two", title: "Charmeleon 169/165 PSA 9", price: 75, shipping: 0 },
        ], checked: [],
    };
    const cache = new Map<string, unknown>();
    let calls = 0;
    const run = createModelExperimentRunner({
        cached: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        run: async request => {
            calls++;
            assert.deepEqual(request.photos, []);
            if (calls === 1) assert.deepEqual(JSON.parse(request.prompt).candidates.map((c: { shipping: number | null }) => c.shipping), [null, 0]);
            return { result: { id: "one", reason: "Check the destination shipping quote.", conflicts: [] }, usage: { inputTokens: 8, outputTokens: 4 } };
        },
    });
    assert.equal((await chooseCollectorListing(menu, undefined, run)).id, "one");
    assert.equal((await chooseCollectorListing(menu, undefined, run)).reused, true);
    menu.checked.push({ id: "one", outcome: "Wrong language" });
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /unchecked/);
    assert.equal(calls, 1);
    menu.candidates.shift();
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /invalid/i);
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /invalid/i);
    assert.equal(calls, 2);
});

test("a model menu skip requires a quoted conflict for every candidate", async () => {
    const menu: CollectorListingMenu = {
        searchId: "85dcd150-e067-4c21-8e11-8d61211b195c", query: "English Charmeleon Scarlet & Violet 151 169/165 PSA 9",
        asOf: "2026-11-24T20:30:00Z", target: 76, reference: { estimate: 76, count: 8 }, checked: [],
        candidates: [
            { id: "one", title: "2023 Charmeleon Obsidian Flames 027 PSA 9", price: 20, shipping: null },
            { id: "two", title: "Charmeleon Hidden Fates PSA 9", price: 26, shipping: 1 },
        ],
    };
    let conflicts = ["Obsidian Flames", "Hidden Fates"];
    const run = createModelExperimentRunner({
        cached: async () => null, save: async () => {},
        run: async () => ({ result: { id: "skip_menu", reason: "Each title names a different set.", conflicts }, usage: { inputTokens: 8, outputTokens: 7 } }),
    });
    assert.equal((await chooseCollectorListing(menu, undefined, run)).id, "skip_menu");
    conflicts = ["Obsidian Flames"];
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /invalid/i);
    conflicts = ["unknown shipping", "Hidden Fates"];
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /invalid/i);
    conflicts = ["PSA 9", "Hidden Fates"];
    await assert.rejects(chooseCollectorListing(menu, undefined, run), /invalid/i);
});
