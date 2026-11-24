import assert from "node:assert/strict";
import test from "node:test";
import { compareCardmarket } from "../../server/pricing/cardmarket.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

const now = Date.UTC(2026, 10, 24, 12);
const record: CardRecord = { id: 987, name: "Venusaur", setName: "Base Set", cardNumber: "15/102", source: "pkmnprices",
    variants: [{ name: "Holofoil", printing: "UNLIMITED", finish: "HOLO" }] };
function raw() {
    const value = cardEvaluation();
    value.condition!.rawCondition = "NEAR_MINT";
    value.identity!.recordId = record.id;
    value.photoCheck!.cardCount = "ONE";
    return value;
}
function checkedOffer() {
    return { article_id: 123, price: 39, quantity: 1, updated_at: new Date(now).toISOString(), language: "EN",
        variant: "Holofoil", condition: "Near Mint", signed: false, altered: false, graded: false, grader: null as string | null,
        grade: null as string | null, comment: "", seller_country: "DE" };
}
test("a saved raw assessment fetches one exact native active-ask page and retains only fresh matching EUR articles", async () => {
    const input = raw(), row = checkedOffer();
    let lookups = 0, fxReads = 0;
    const result = await compareCardmarket(input, { now: () => now, record: async id => { assert.equal(id, "987"); return record; },
        offers: async (id, params) => {
            lookups++;
            assert.equal(id, "987");
            assert.deepEqual(Object.fromEntries(params), { variant: "Holofoil", graded: "false", signed: "false", altered: "false",
                sort: "price_asc", limit: "5", condition: "Near Mint" });
            return [row, { ...row }, { ...row, article_id: 124, price: 33 }, { ...row, article_id: 222, condition: "Mint" },
                { ...row, article_id: 225, updated_at: new Date(now - 7 * 86400000).toISOString() }];
        }, fx: async () => { fxReads++; return { usdPerEur: 1.1, date: "2026-11-24" }; } });
    assert.equal(lookups, 1); assert.equal(fxReads, 1);
    assert.equal(result.status, "AVAILABLE"); assert.equal(result.basis, "ACTIVE_ASK"); assert.equal(result.currency, "EUR");
    assert.deepEqual(result.offers.map(item => [item.articleId, item.priceEur]), [["124", 33], ["123", 39]]);
    for (const change of [{ graded: true }, { price: 0 }, { language: "DE" }, { signed: true }, { altered: true },
        { variant: "Reverse Holofoil" }, { comment: "First Edition" }, { comment: "shadowless" }, { currency: "USD" },
        { updated_at: "bad-date" }, { quantity: 0 }, { updated_at: new Date(now + 1000).toISOString() }]) {
        const result = await compareCardmarket(input, { now: () => now, record: async () => record, offers: async () => [{ ...row, ...change }],
            fx: async () => { throw new Error("No FX when no offers matched"); } });
        assert.equal(result.status, "UNAVAILABLE", JSON.stringify(change));
    }
});

test("verified slabs match ordinary exact grader and grade, independent of raw condition", async () => {
    const input = raw();
    input.condition = null;
    input.photoCheck!.holder = "GRADED_SLAB";
    input.photoCheck!.slab = { present: true, grader: "PSA", grade: "9", gradeQualifier: null, certNumber: "12345", labelText: "PSA 9",
        caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    input.slab = { status: "OK", grader: "PSA", grade: "9", gradeQualifier: null, certNumber: "12345", certUrl: null, labelText: "PSA 9",
        caseCondition: "INTACT", reasons: [], concerns: [] };
    const row = { ...checkedOffer(), graded: true, grader: "PSA", grade: "9" };
    const result = await compareCardmarket(input, { now: () => now, record: async () => record, fx: async () => null, offers: async (_, params) => {
        assert.equal(params.get("grader"), "PSA"); assert.equal(params.get("grade"), "9"); assert.equal(params.has("condition"), false);
        return [row, { ...row, article_id: 2, grader: "CGC" }, { ...row, article_id: 3, grade: "10" },
            { ...row, article_id: 4, comment: "qualified (OC)" }, { ...row, article_id: 5, graded: false }];
    } });
    assert.equal(result.status, "AVAILABLE"); assert.deepEqual(result.offers.map(o => o.articleId), ["123"]);
});

test("conflicts, ambiguous records, damaged cards and unresolved editions never request an offer page", async () => {
    const input = raw();
    const compare = (copy: ReturnType<typeof raw>, target = record) => compareCardmarket(copy, {
        now: () => now, record: async () => target, offers: async () => { throw new Error("Should not query Cardmarket"); } });
    for (const patch of [{ name: "Mewtwo" }, { id: 988 }, { setName: "Base Set 2" }, { cardNumber: "15/130" },
        { variants: [...record.variants, ...record.variants] }]) assert.equal((await compare(input, { ...record, ...patch })).status, "UNAVAILABLE");
    input.identity!.status = "NEEDS_REVIEW"; assert.equal((await compare(input)).status, "UNAVAILABLE");
    input.identity!.status = "IDENTIFIED";
    for (const condition of ["LIGHTLY_PLAYED", "MODERATELY_PLAYED", "HEAVILY_PLAYED", "DAMAGED"] as const) {
        input.condition!.rawCondition = condition;
        assert.match((await compare(input)).reason ?? "", /different standards/);
    }
    input.condition!.rawCondition = "MINT"; input.identity!.printing = "SHADOWLESS";
    assert.equal((await compare(input, { ...record, variants: [{ ...record.variants[0]!, printing: "SHADOWLESS" }] })).status, "UNAVAILABLE");
});
