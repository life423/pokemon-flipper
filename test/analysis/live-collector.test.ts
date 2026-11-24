import assert from "node:assert/strict";
import test from "node:test";
import type { CollectorStrategyEvidence } from "../../server/analysis/collector-strategy-evidence.ts";
import { checkLiveListings } from "../../server/analysis/live-collector.ts";
import type { CollectorListingCandidate } from "../../server/deals/bin-competition.ts";
import { salesSummary } from "../fixtures/card-evaluation.ts";

const asOf = new Date().toISOString();
const saved: CollectorStrategyEvidence = {
    query: "English Charmeleon 169/165 PSA 9", asOf,
    reference: { recordId: 1, name: "Charmeleon", set: "Scarlet & Violet 151", cardNumber: "169/165",
        printing: "UNLIMITED", finish: "HOLO", grader: "PSA", grade: "9", condition: null,
        summary: salesSummary("PSA", 9, [70, 76, 79]) },
    listing: { title: "Earlier copy", url: "https://www.ebay.com/itm/123456789010", price: 80, shipping: 0,
        checkedAt: asOf, ceiling: 53, identity: "LABEL", pricing: { resale: 76, profit: -30, sales: 3, totalCost: 86.60, roi: -0.35 } },
};
const unknown: CollectorListingCandidate = { id: "v1|123456789011|0", title: saved.query, price: 65, shipping: null, total: null, minimumTotal: 70.36 };
const known: CollectorListingCandidate = { id: "v1|123456789012|0", title: saved.query, price: 70.21, shipping: 0, total: 76, minimumTotal: 76 };
const page = (...candidates: CollectorListingCandidate[]) => ({ candidates, fetched: candidates.length,
    rejected: 0, total: candidates.length, retained: candidates.length });

test("a collector can buy at the exact all-in limit only after the selected listing's shipping and slab check", async () => {
    const menus: string[][] = [], checked: string[] = [];
    let pages = 0;
    const result = await checkLiveListings("run", "source", 76, saved, asOf, new AbortController().signal, {
        discover: async () => ++pages === 1 ? page(unknown) : page(unknown, known),
        choose: async ({ candidates, checked: earlier }) => {
            menus.push(candidates.map(row => row.id));
            assert.deepEqual(earlier.map(row => row.id), checked);
            return { id: candidates[0].id, reason: "Verify the delivered price.", reused: false };
        },
        verify: async row => {
            checked.push(row.id);
            if (row.id === unknown.id) return { status: "unresolved", reason: "Destination shipping remains unknown.", listing: null };
            return { status: "verified", reason: "Exact slab and shipping verified.", listing: {
                ...saved.listing, url: "https://www.ebay.com/itm/123456789012", price: known.price,
                pricing: { ...saved.listing.pricing, totalCost: 76 } } };
        },
    });
    assert.deepEqual(menus, [[unknown.id, known.id], [known.id]]);
    assert.deepEqual(checked, [unknown.id, known.id]);
    assert.equal(result.fetched, 3);
    assert.equal(result.candidates, 2);
    assert.equal(result.decision, "BUY");
    assert.equal(result.listing?.total, 76);
    assert.match(result.steps[0].outcome, /shipping remains unknown/);
});

test("a cheap summary with no destination quote and a verified copy one cent over the cap both yield wait", async () => {
    const result = await checkLiveListings("run", "source", 76, saved, asOf, new AbortController().signal, {
        discover: async () => page(unknown, known),
        choose: async ({ candidates }) => ({ id: candidates[0].id, reason: "Resolve the shipping quote.", reused: false }),
        verify: async row => row.id === unknown.id
            ? { status: "unresolved", reason: "No shipping quote.", listing: null }
            : { status: "verified", reason: "Destination price refreshed.", listing: {
                ...saved.listing, price: 70.22, pricing: { ...saved.listing.pricing, totalCost: 76.01 } } },
    });
    assert.equal(result.decision, "WAIT");
    assert.equal(result.listing?.total, 76.01);
    assert.match(result.reason, /\$0\.01 above/);
});

test("cheaper unrelated slabs cannot hide the previously verified copy from the model", async () => {
    const prior = { ...known, id: "v1|123456789010|0", price: 80, total: 86.60, minimumTotal: 86.60 };
    const wrong = Array.from({ length: 12 }, (_, i) => ({
        ...known, id: `v1|1234567891${String(i).padStart(2,"0")}|0`, title: "Obsidian Flames Charmeleon 027 PSA 9",
    }));
    const checks: string[] = [];
    const result = await checkLiveListings("run", "source", 76, saved, asOf, new AbortController().signal, {
        discover: async () => page(...wrong, prior),
        choose: async ({ candidates, previousMatch }) => {
            assert.equal(previousMatch, prior.id);
            return candidates.some(row => row.id === prior.id)
                ? { id: prior.id, reason: "Recheck the known exact copy.", reused: false }
                : { id: "skip_menu", reason: "All titles identify Obsidian Flames 027.", reused: false };
        },
        verify: async row => {
            checks.push(row.id);
            return { status: "verified", reason: "Slab label and ZIP quote checked.", listing: saved.listing };
        },
    });
    assert.deepEqual(checks, [prior.id]);
    assert.equal(result.titleExclusions?.[0].listings.length, 12);
    assert.equal(result.decision, "WAIT");
    assert.equal(result.listing?.total, 86.60);
});
