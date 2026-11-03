import "../fixtures/isolated-data.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoundedEvaluator } from "../../server/analysis/bounded-evaluate.ts";
import { GRADERS } from "../../shared/money/underwriting.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { CardRecord } from "../../server/pricing/types.ts";

// The current compact route must retain exact BGS/TAG resale without buying a
// raw grade, a cross-grader comparison or an active-listing fallback.
test("BGS and TAG compact label assessments price only the photographed certified grade", async t => {
    t.mock.method(globalThis, "fetch", () => { assert.fail("All provider work must use injected offline evidence"); });
    const now = Date.now();
    const card: CardRecord = { source: "pkmnprices", id: 998877, name: "Lugia", cardNumber: "9/111", setName: "Neo Genesis", tcgPlayerId: null,
        variants: [{ name: "Unlimited Holofoil", finish: "HOLO", printing: "UNLIMITED", prices: [] }] };
    for (const grader of ["BGS", "TAG"]) {
        const cache = new Map<string, any>();
        let photoCalls = 0;
        const targets: { grader: string; grade: string }[] = [];
        const listing: ListingDetails = { id: `${grader}-offline`, title: `Lugia 9/111 Neo Genesis Unlimited Holo ${grader} 6.5`,
            url: "https://www.ebay.com/itm/123456789012", price: 100, shipping: 5, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null,
            images: ["front", "back"].map(view => `https://i.ebayimg.com/images/g/${grader}-${view}/s-l1600.jpg`),
            availability: "ACTIVE", condition: "Graded", cardCondition: null, conditionNotes: [],
            aspects: { Set: "Neo Genesis", "Card Name": "Lugia", "Card Number": "9/111", Language: "English", Finish: "Holo", "Professional Grader": grader, Grade: "6.5" } };
        const evaluate = createBoundedEvaluator({ now: () => now, details: async () => structuredClone(listing), saved: async () => null,
            cached: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, structuredClone(value)); },
            assess: async (_listing, photos, _signal, mode) => {
                photoCalls++; assert.equal(mode, "SLAB_LABEL"); assert.equal(photos.length, 2);
                return { result: { condition: null, photoCheck: { confidence: "HIGH", photoSufficiency: "SUFFICIENT", cardCount: "ONE", holder: "GRADED_SLAB",
                    images: photos.map((_, index) => ({ number: index + 1, view: index === 0 ? "FRONT" : "BACK", usable: true, isStockImage: false, obscuresCondition: false, issues: [] })), missingViews: [], problems: [],
                    printedName: "Lugia", printedNumber: "9/111", cardMatch: { verdict: "MATCH", problems: [] },
                    cardIdentity: { name: "Lugia", set: "Neo Genesis", cardNumber: "9/111", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["Readable name, number and label"] },
                    printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Unlimited label and card"] },
                    slab: { present: true, grader, grade: "6.5", gradeQualifier: "EX MT+", certNumber: grader === "TAG" ? "A1234567" : "12345678",
                        labelText: `2000 POKEMON NEO GENESIS LUGIA HOLO #9 ${grader} EX MT+ 6.5`, caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } } }, usage: { inputTokens: 1, outputTokens: 1 } };
            },
            lookup: async () => [card], fetchRawComps: async () => { assert.fail("An existing slab needs no raw sold prices"); },
            fetchComps: async (_id, options) => { targets.push({ grader: options.grader, grade: String(options.grade) }); return [950, 1000, 1050].map((price, index) => ({
                id: `${grader}-${index}`, title: listing.title, price, currency: "USD", grader, grade: "6.5", grade_qualifier: "EX MT+", variant: "Unlimited Holofoil", attribution: "exact", sale_type: "fixed_price", listing_url: null,
                sold_at: new Date(now - (index + 1) * 86400000).toISOString(),
            })); }, compChecks: async () => new Map(),
        });
        const evaluation = await evaluate(listing.id);
        assert.equal(evaluation.slab?.status, "OK", JSON.stringify(evaluation.slab));
        assert.equal(evaluation.slab?.grader, grader); assert.equal(evaluation.slab?.grade, "6.5");
        assert.equal(evaluation.slabPricing?.summary?.median, 1000); assert.equal(evaluation.slabPricing?.summary?.count, 3);
        assert.equal(evaluation.underwriting?.verdict, "BUY_GRADED"); assert.equal(evaluation.underwriting?.best?.label, `Resell as ${grader} 6.5`);
        assert.equal(evaluation.condition, null); assert.equal(evaluation.gradedPricing, null); assert.equal(evaluation.rawPricing, null);
        assert.ok(evaluation.underwriting!.best!.profit < 900, "fees, shipping and tax reduce the gross spread");
        assert.deepEqual(targets, [{ grader, grade: "6.5" }]); assert.equal(photoCalls, 1);
        const reused = await evaluate(listing.id); assert.equal(reused.slab?.grader, grader); assert.equal(photoCalls, 1); assert.equal(targets.length, 1);
    }
    assert.deepEqual(GRADERS, ["PSA", "CGC"], "new raw submission services remain independent from existing slabs");
});
