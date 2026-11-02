import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedSoldCondition, corroboratedSoldCondition, createSoldConditionAssessor, type SoldConditionReading } from "../../server/ai/sold-condition.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import type { Comp } from "../../server/pricing/types.ts";
import type { Identity } from "../../shared/types.ts";
const identity = cardEvaluation().identity!;
function reading(): SoldConditionReading {
    return { card: { name: identity.name, set: identity.set, cardNumber: identity.cardNumber, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Visible name, collector number and Base Set artwork agree"] }, printing: "UNLIMITED", condition: "LIGHTLY_PLAYED", confidence: "HIGH", oneRawCard: true, frontVisible: true, backVisible: true, closeUps: true, structuralDamage: false, evidence: ["Minor corner whitening on both sides"], limitations: [] };
}
test("sold-copy classification requires actual identity, printing and visible condition; structural damage outranks a mint guess", () => {
    const input = reading(); assert.equal(acceptedSoldCondition(input, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(acceptedSoldCondition({ ...input, backVisible: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, oneRawCard: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, printing: "FIRST_EDITION" }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", closeUps: false }, identity, 4), null);
    assert.equal(acceptedSoldCondition({ ...input, condition: "MINT", structuralDamage: true, backVisible: false }, identity, 4)?.condition, "DAMAGED");
});
test("ended listings can supply photos; concurrent requests and repeat opens share the saved visual reading", async () => {
    const saved = new Map<string, unknown>(); let detailsCalls = 0, aiCalls = 0;
    const photos = Array.from({ length: 14 }, (_, index) => `sold-copy-view-${index}`);
    const assessor = createSoldConditionAssessor({
        details: async () => { detailsCalls++; return { images: photos, availability: "UNAVAILABLE" } as any; },
        assess: async views => { aiCalls++; assert.deepEqual(views, photos, "do not hide views behind a four-photo sample"); return { result: reading(), usage: { inputTokens: 10, outputTokens: 10 } }; },
        cached: async <T>(key: string) => saved.get(key) as T ?? null,
        save: async (key, value) => { saved.set(key, value); },
    });
    const sale = { listing_url: "https://www.ebay.com/itm/123456789012", title: "Seller says Near Mint" } as Comp;
    const results = await Promise.all([assessor(sale, identity), assessor(sale, identity)]);
    assert.equal(detailsCalls, 1); assert.equal(aiCalls, 1); assert.equal(results[0]?.condition, "LIGHTLY_PLAYED");
    await assessor(sale, identity); assert.equal(aiCalls, 1);
});

test("two medium readings may settle wear but cannot vote away missing views, damage or a Mint evidence gap", () => {
    const a = { ...reading(), confidence: "MEDIUM" };
    assert.equal(corroboratedSoldCondition(a, a, identity, 4)?.condition, "LIGHTLY_PLAYED");
    assert.equal(corroboratedSoldCondition(a, { ...a, condition: "NEAR_MINT" }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, backVisible: false }, a, identity, 4), null);
    assert.equal(corroboratedSoldCondition(a, { ...a, structuralDamage: true }, identity, 4), null);
    assert.equal(corroboratedSoldCondition({ ...a, condition: "MINT" }, { ...a, condition: "MINT" }, identity, 4), null);
});

test("historical reviews use the approved 100-worker ceiling rather than a hidden two-worker queue", async () => {
    let active = 0, peak = 0, started = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const assessor = createSoldConditionAssessor({
        details: async id => ({ images: [`${id}-front`, `${id}-back`] } as any),
        assess: async () => { started++; active++; peak = Math.max(peak, active); await gate; active--; return { result: reading(), usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async () => null, save: async () => {},
    });
    const jobs = Array.from({ length: 105 }, (_, index) => assessor({ listing_url: `https://www.ebay.com/itm/${100000000000 + index}` } as Comp, identity));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 100); release(); await Promise.all(jobs);
    assert.equal(started, 105); assert.equal(peak, 100);
});

test("unresolved sold-copy targets do not retrieve photos or pay for an unusable reading", async () => {
    let detailsCalls = 0, aiCalls = 0;
    const assessor = createSoldConditionAssessor({
        details: async () => { detailsCalls++; return { images: ["front", "back"] } as any; },
        assess: async () => { aiCalls++; return { result: reading(), usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async () => null, save: async () => {},
    });
    const unresolved: Partial<Identity>[] = [{ finish: "NOT_STATED" }, { finish: "UNKNOWN" }, { finish: "CONFLICTING" },
        { status: "NEEDS_REVIEW" }, { printing: "UNKNOWN" }, { name: null }, { set: null }, { cardNumber: null }];
    for (const change of unresolved) assert.equal(await assessor({ listing_url: "https://www.ebay.com/itm/123456789012" } as Comp, { ...identity, ...change }), null);
    assert.equal(detailsCalls, 0); assert.equal(aiCalls, 0);
});

test("unchanged failed evidence survives the old retry window; genuinely new photos can resolve it", async () => {
    const cases: SoldConditionReading[][] = [
        [{ ...reading(), condition: "UNKNOWN", confidence: "LOW" }],
        [{ ...reading(), backVisible: false }],
        [{ ...reading(), printing: "FIRST_EDITION" }],
        [{ ...reading(), card: { ...reading().card, name: "Charizard" } }],
        [{ ...reading(), confidence: "MEDIUM" }, { ...reading(), confidence: "MEDIUM", condition: "NEAR_MINT" }],
    ];
    for (const answers of cases) {
        let clock = 0, calls = 0, photos = ["front", "back"];
        const saved = new Map<string, { at: number; data: unknown }>();
        const assessor = createSoldConditionAssessor({
            details: async () => ({ images: photos } as any),
            assess: async () => ({ result: answers[calls++] ?? reading(), usage: { inputTokens: 1, outputTokens: 1 } }),
            cached: async <T>(key: string, hours: number) => { const entry = saved.get(key); return entry && clock - entry.at < hours * 3600000 ? entry.data as T : null; },
            save: async (key, data) => { saved.set(key, { at: clock, data }); },
        });
        const sale = { listing_url: "https://www.ebay.com/itm/123456789012" } as Comp;
        assert.equal(await assessor(sale, identity), null);
        assert.equal(calls, answers.length);
        clock += 2 * 3600000;
        assert.equal(await assessor(sale, identity), null);
        assert.equal(calls, answers.length, "time alone must not repurchase unchanged negative evidence");
        photos = ["new-clear-front", "new-clear-back"];
        assert.equal((await assessor(sale, identity))?.condition, "LIGHTLY_PLAYED");
        assert.equal(calls, answers.length + 1, "new photo evidence gets one fresh assessment");
        clock += 2 * 3600000;
        assert.equal((await assessor(sale, identity))?.condition, "LIGHTLY_PLAYED");
        assert.equal(calls, answers.length + 1, "successful new evidence is reused too");
    }
});

test("a saved medium primary may complete its missing corroboration once without repeating the primary", async () => {
    let calls = 0;
    const saved = new Map<string, unknown>();
    const primary = { ...reading(), confidence: "MEDIUM" };
    const assessor = createSoldConditionAssessor({
        details: async () => ({ images: ["front", "back"] } as any),
        assess: async () => { calls++; return { result: primary, usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async <T>(key: string) => (saved.get(key) ?? (key.startsWith("sold-condition:v") ? primary : null)) as T | null,
        save: async (key, data) => { saved.set(key, data); },
    });
    const sale = { listing_url: "https://www.ebay.com/itm/123456789012" } as Comp;
    assert.equal((await assessor(sale, identity))?.condition, "LIGHTLY_PLAYED");
    assert.equal(calls, 1);
    assert.equal((await assessor(sale, identity))?.condition, "LIGHTLY_PLAYED");
    assert.equal(calls, 1);
});

test("one canceled sold-review consumer does not cancel the other consumer's needed assessment", async () => {
    const first = new AbortController(); let release!: () => void; let started!: () => void; let calls = 0;
    const gate = new Promise<void>(resolve => release = resolve), ready = new Promise<void>(resolve => started = resolve);
    const assessor = createSoldConditionAssessor({
        details: async () => { started(); await gate; return { images: ["front", "back"] } as any; },
        assess: async (_photos, _identity, signal) => { assert.equal(signal?.aborted, false); calls++; return { result: reading(), usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async () => null, save: async () => {},
    });
    const sale = { listing_url: "https://www.ebay.com/itm/123456789012" } as Comp;
    const canceled = assessor(sale, identity, first.signal), needed = assessor(sale, identity);
    const rejected = assert.rejects(canceled, { name: "AbortError" });
    await ready; first.abort(); await rejected; release();
    assert.equal((await needed)?.condition, "LIGHTLY_PLAYED"); assert.equal(calls, 1);
});

test("stopping queued sold reviews dispatches no assessments and does not cache cancellation as failed evidence", async () => {
    const controller = new AbortController(); let release!: () => void; let details = 0, calls = 0;
    const gate = new Promise<void>(resolve => release = resolve);
    const assessor = createSoldConditionAssessor({
        details: async () => { details++; await gate; return { images: ["front", "back"] } as any; },
        assess: async () => { calls++; return { result: reading(), usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async () => null, save: async () => { assert.fail("cancellation is not a failed photo reading"); },
    });
    const jobs = Array.from({ length: 105 }, (_, index) => assessor({ listing_url: `https://www.ebay.com/itm/${100000000000 + index}` } as Comp, identity, controller.signal));
    const settled = Promise.allSettled(jobs);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(details, 100); controller.abort(); release();
    assert.ok((await settled).every(result => result.status === "rejected"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(details, 100, "the five queued lookups never start"); assert.equal(calls, 0);
});

test("a paid primary finishes saving after stop; resuming buys only its missing corroboration", async () => {
    const controller = new AbortController(); const saved = new Map<string, unknown>(); let calls = 0;
    let ready!: () => void; const paid = new Promise<void>(resolve => ready = resolve);
    const assessor = createSoldConditionAssessor({
        details: async () => ({ images: ["front", "back"] } as any),
        assess: async () => { calls++; if (calls === 1) controller.abort(); return { result: { ...reading(), confidence: "MEDIUM" }, usage: { inputTokens: 1, outputTokens: 1 } }; },
        cached: async <T>(key: string) => saved.get(key) as T ?? null,
        save: async (key, value) => { saved.set(key, value); ready(); },
    });
    const sale = { listing_url: "https://www.ebay.com/itm/123456789012" } as Comp;
    await assert.rejects(assessor(sale, identity, controller.signal), { name: "AbortError" });
    await paid; await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1, "stopping prevents the follow-up request");
    assert.equal((await assessor(sale, identity))?.condition, "LIGHTLY_PLAYED");
    assert.equal(calls, 2, "the completed primary is retained rather than purchased twice");
});
