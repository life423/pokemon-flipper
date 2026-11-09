import assert from "node:assert/strict";
import { test } from "node:test";
import { findStampDecision, stampCandidate } from "../../server/analysis/stamp-decision.ts";
import { identifyCard } from "../../server/identity/card-identity.ts";
import type { CardRecord } from "../../server/pricing/types.ts";
import type { Evaluation, Printing, Targets } from "../../shared/types.ts";
import { cardEvaluation, salesSummary } from "../fixtures/card-evaluation.ts";

const now = Date.UTC(2026, 10, 8, 18);
const figures = { minProfit: 20, minRoi: 0 };
const cases = [
    { name: "Venusaur", set: "Base Set", number: "15/102", absent: "SHADOWLESS" },
    { name: "Dark Blastoise", set: "Team Rocket", number: "3/82", absent: "UNLIMITED" },
    { name: "Espeon", set: "Neo Discovery", number: "1/75", absent: "UNLIMITED" },
] as const;

async function setup(card = cases[0] as (typeof cases)[number]) {
    const { name, set, number, absent } = card;
    const evaluation = cardEvaluation();
    Object.assign(evaluation.listing, {
        title: `${name} ${set} ${number} 1st Edition Holo English`,
        availability: "ACTIVE", buyingOption: "FIXED_PRICE", price: 80, shipping: 4, endTime: null,
        termsCheckedAt: new Date(now).toISOString(),
        aspects: { "Card Name": name, "Card Number": number, Set: set, Finish: "Holo", Language: "English" },
    });
    evaluation.condition!.gradeRange = null;
    evaluation.photoCheck!.cardCount = "ONE";
    evaluation.photoCheck!.cardMatch = { verdict: "MATCH", problems: [] };
    evaluation.photoCheck!.cardIdentity = { name, set, cardNumber: number, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Legible name and number"] };
    evaluation.photoCheck!.printingMarks = { firstEditionStamp: "CANT_TELL", artBoxShadow: absent === "SHADOWLESS" ? "ABSENT" : "CANT_TELL", reprintMark: "NONE_SEEN" };
    const records: CardRecord[] = [{
        source: "pkmnprices", id: 13, name, setName: absent === "SHADOWLESS" ? "Base Set (Shadowless)" : set, cardNumber: number,
        variants: [{ name: "1st Edition Holofoil", finish: "HOLO", printing: "FIRST_EDITION" },
            { name: "Unlimited Holofoil", finish: "HOLO", printing: absent }],
    }];
    const identify = (check: NonNullable<Evaluation["photoCheck"]>) => identifyCard(evaluation.listing, check, { lookupCards: async () => records });
    evaluation.identity = (await identify(evaluation.photoCheck!)).identity;
    evaluation.rawPricing = null;
    evaluation.gradedPricing = null;
    evaluation.underwriting = null;
    return { evaluation, identify };
}

function matchedSales(printing: Printing, price: number, conditionEvidence: "AI_PHOTOS" | "SELLER_TEXT" = "AI_PHOTOS"): Evaluation["rawPricing"] {
    const condition = "LIGHTLY_PLAYED";
    return { status: "PRICED", source: "pkmnprices", printing, finish: "HOLO", conditionEvidence,
        prices: [{ condition, price, updatedAt: new Date(now).toISOString(), basis: "EBAY_SOLD", comps: salesSummary("RAW", condition, [price, price, price]) }] };
}

test("only exact alternatives that change the deal verdict qualify for a stamp check", async () => {
    for (const card of cases) {
        const { evaluation, identify } = await setup(card);
        const stamp = evaluation.photoCheck!.printingMarks;
        const decisions = await findStampDecision(evaluation, {
            now, identify, targets: figures, signal: new AbortController().signal,
            price: async identity => ({ rawPricing: matchedSales(identity.printing as Printing, identity.printing === "FIRST_EDITION" ? 220 : 70), gradedPricing: null }),
        });
        assert.equal(decisions?.VISIBLE.identity.printing, "FIRST_EDITION");
        assert.equal(decisions?.VISIBLE.underwriting.verdict, "BUY_RAW");
        assert.equal(decisions?.NOT_PRESENT.identity.printing, card.absent);
        assert.equal(decisions?.NOT_PRESENT.underwriting.verdict, "PASS");
        assert.equal(stamp?.firstEditionStamp, "CANT_TELL", "scenario pricing must not apply hypothetical evidence");
    }
});

test("financial targets, missing matching sales and borrowed markets stop extra stamp work", async () => {
    const { evaluation, identify } = await setup();
    const run = (first: number, second: number | null, targets: Targets, sellerText = false, wrongPrinting = false) => findStampDecision(evaluation, {
        now, identify, targets, signal: new AbortController().signal,
        price: async identity => {
            const firstEdition = identity.printing === "FIRST_EDITION";
            const price = firstEdition ? first : second;
            return { rawPricing: price === null ? null : matchedSales(wrongPrinting ? "UNLIMITED" : identity.printing as Printing, price, sellerText ? "SELLER_TEXT" : "AI_PHOTOS"), gradedPricing: null };
        },
    });
    assert.equal(await run(200, 160, figures), null, "both alternatives are deals");
    assert.equal(await run(200, 70, { minProfit: 200, minRoi: 0 }), null, "neither meets the actual targets");
    assert.equal(await run(200, null, figures), null, "an unpriced alternative is not a supported loss");
    assert.equal(await run(200, 70, figures, true), null, "seller condition is not an accepted raw comp");
    assert.equal(await run(200, 70, figures, false, true), null, "another printing cannot price the alternative");
});

test("ended, stale, or separately unresolved listings skip alternative research", async () => {
    const { evaluation } = await setup();
    const expectSkip = async (change: (input: Evaluation) => void) => {
        const item = structuredClone(evaluation);
        change(item);
        assert.equal(await findStampDecision(item, {
            now, targets: figures, signal: new AbortController().signal,
            identify: async () => assert.fail("unqualified listing should stop before the catalog"),
            price: async () => assert.fail("unqualified listing should stop before prices"),
        }), null);
    };
    await expectSkip(item => { item.listing.availability = "UNAVAILABLE"; });
    await expectSkip(item => { item.listing.endTime = new Date(now).toISOString(); });
    await expectSkip(item => { item.listing.termsCheckedAt = new Date(now - 3 * 60_000).toISOString(); });
    await expectSkip(item => { item.listing.shipping = null; });
    await expectSkip(item => { item.condition!.creases = "SUSPECTED"; });
    await expectSkip(item => { item.photoCheck!.printingMarks!.artBoxShadow = "CANT_TELL"; });
    await expectSkip(item => { item.photoCheck!.printingMarks!.firstEditionStamp = "VISIBLE"; });
});

test("only explicit negative reprint findings in saved prose qualify", async () => {
    const { evaluation } = await setup(cases[2]);
    const marks = evaluation.photoCheck!.printingMarks!;
    for (const observation of [
        "No anniversary/Pikachu reprint logo or Base Set 2 symbol is visible in the supplied views.",
        "No anniversary or other reprint mark is visible in the supplied front views; Base Set 2 mark not applicable/seen.",
    ]) {
        marks.reprintMark = observation;
        assert.ok(stampCandidate(evaluation), observation);
    }
    const rocket = (await setup(cases[1])).evaluation;
    rocket.photoCheck!.printingMarks!.reprintMark = "No Base Set 2 symbol or Pikachu anniversary stamp is visible in the supplied views; those marks are not applicable evidence for this Team Rocket card.";
    assert.ok(stampCandidate(rocket));
    for (const observation of [
        "CANT_TELL",
        "CELEBRATIONS_25TH",
        "Cannot reliably determine from the supplied blur.",
        "No Pikachu anniversary logo is visible in the supplied views.",
        "No anniversary or other reprint mark is visible in the supplied front views; possible Base Set 2 mark under glare.",
        "No anniversary or other reprint mark is visible in the supplied front views, but the relevant areas are obscured.",
        "No Base Set 2 symbol or Pikachu anniversary stamp is clearly visible in the supplied views.",
    ]) {
        marks.reprintMark = observation;
        assert.equal(stampCandidate(evaluation), null, observation);
    }
});
