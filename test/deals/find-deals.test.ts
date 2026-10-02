import { test } from "node:test";
import assert from "node:assert/strict";
import { screenListing } from "../../server/deals/find-deals.ts";

const listing = (title, extra = {}) => ({
    id: "v1|1|0",
    title,
    currentPrice: 300,
    shipping: 5,
    bids: 0,
    isGraded: false,
    buyingOption: "FIXED_PRICE",
    endTime: null,
    images: [],
    url: "",
    seller: null,
    ...extra,
});

const screen = (status, extra = {}) => ({ status, reason: null, card: null, bestCase: null, assumed: null, ...extra });

// Steps that record what they were asked, with the check's answers in order.
function steps(answers, { detailsFail = false, photoAnswer = null } = {}) {
    const calls = { details: 0, checks: [] };

    return {
        calls,
        readTitle: async (listing) => ({ aspects: { ...listing.aspects, Set: "Base Set" }, filled: listing.aspects.Set ? [] : ["Set"] }),
        loadDetails: async () => {
            calls.details += 1;
            if (detailsFail) throw new Error("eBay request failed (429): Too many requests");
            return { title: "Charizard 4/102", aspects: { Set: "Base Set" }, shipping: 5, cardCondition: "Lightly played (Excellent)", conditionNotes: [], seller: null };
        },
        matchPhoto: async (imageUrl, card) => {
            calls.photos = (calls.photos ?? 0) + 1;
            return photoAnswer;
        },
        check: async (input) => {
            calls.checks.push(input);
            return answers.shift();
        },
    };
}

test("a listing dropped on its title never costs an eBay detail request", async () => {
    const s = steps([screen("DROPPED")]);
    const result = await screenListing(listing("Charizard 4/102 Base Set Holo"), s);

    assert.equal(result.screen.status, "DROPPED");
    assert.equal(s.calls.details, 0);
    assert.equal(s.calls.checks[0].cardCondition, null);
});

test("a candidate gets its details and a second check with the seller's condition", async () => {
    const s = steps([screen("CANDIDATE"), screen("DROPPED")]);
    const result = await screenListing(listing("Charizard 4/102 Base Set Holo"), s);

    assert.equal(s.calls.details, 1);
    assert.equal(s.calls.checks[1].cardCondition, "Lightly played (Excellent)");
    assert.equal(result.screen.status, "DROPPED");
    assert.equal(result.cardCondition, "Lightly played (Excellent)");
});

test("a title missing pieces gets its details, which might settle it", async () => {
    const s = steps([screen("UNSCREENED", { incomplete: true }), screen("CANDIDATE")]);
    const result = await screenListing(listing("Charizard Holo WOTC"), s);

    assert.equal(s.calls.details, 1);
    assert.equal(result.screen.status, "CANDIDATE");
});

test("when eBay refuses the detail request, the title's check stands", async () => {
    const s = steps([screen("CANDIDATE")], { detailsFail: true });
    const result = await screenListing(listing("Charizard 4/102 Base Set Holo"), s);

    assert.equal(s.calls.details, 1);
    assert.equal(result.screen.status, "CANDIDATE");
});

test("a title in another language is set aside without any checks", async () => {
    const s = steps([]);
    s.readTitle = async () => ({ aspects: { Language: "Japanese" }, filled: ["Language"] });
    const result = await screenListing(listing("Charizard Base Set"), s);

    assert.equal(result.match, "OTHER_LANGUAGE");
    assert.equal(s.calls.details, 0);
    assert.equal(s.calls.checks.length, 0);
});

test("a title the AI reads as junk is skipped before any check or eBay request", async () => {
    const s = steps([]);
    s.readTitle = async () => ({ aspects: {}, filled: [], condition: null, kind: "LOT" });
    const result = await screenListing(listing("Vintage Pokemon Cards WOTC Holo Collection"), s);

    assert.equal(result.match, "JUNK");
    assert.equal(s.calls.checks.length, 0);
    assert.equal(s.calls.details, 0);
});

test("a listing the check calls junk is skipped before any eBay request", async () => {
    const s = steps([screen("UNSCREENED", { junk: true })]);
    const result = await screenListing(listing("Charizard 4/102 Base Set Holo", { currentPrice: 5 }), s);

    assert.equal(result.match, "JUNK");
    assert.equal(s.calls.details, 0);
});

test("a title naming another set than the one searched is set aside before any check", async () => {
    const s = steps([]);
    s.readTitle = async () => ({ aspects: { Set: "Scarlet & Violet 151" }, filled: ["Set"], condition: null, kind: "SINGLE_CARD" });
    const intent = { cardName: "Charizard", sets: ["Base Set"], cardNumber: null, printing: null, graded: null, titleWords: ["charizard"], source: "ai" };
    const result = await screenListing(listing("Charizard ex 199/165 151 SIR", { currentPrice: 5 }), s, intent);

    assert.equal(result.match, "OTHER_SET");
    assert.equal(s.calls.checks.length, 0);
    assert.equal(s.calls.details, 0);
});

test("a candidate whose main photo shows another card is set aside before any eBay request", async () => {
    const card = { name: "Charizard", set: "Base Set", cardNumber: "004/102", printing: "UNLIMITED", printingLabel: "Unlimited" };
    const s = steps([screen("CANDIDATE", { card })], {
        photoAnswer: { verdict: "MISMATCH", problems: ["a Pikachu 30th anniversary logo on the artwork"] },
    });
    const result = await screenListing(listing("Charizard Base Set 4/102 Holo", { images: ["https://i.ebayimg.com/images/g/x/s-l225.jpg"] }), s);

    assert.equal(result.match, "OTHER_CARD");
    assert.match(result.screen.reason, /30th anniversary/);
    assert.equal(s.calls.details, 0);
});

test("a main photo that matches, or can't be judged, lets the candidate go on", async () => {
    const card = { name: "Charizard", set: "Base Set", cardNumber: "004/102", printing: "UNLIMITED", printingLabel: "Unlimited" };
    const s = steps([screen("CANDIDATE", { card }), screen("CANDIDATE", { card })], {
        photoAnswer: { verdict: "CANT_TELL", problems: [] },
    });
    const result = await screenListing(listing("Charizard Base Set 4/102 Holo", { images: ["https://i.ebayimg.com/images/g/x/s-l225.jpg"] }), s);

    assert.equal(result.match, undefined);
    assert.equal(s.calls.photos, 1);
    assert.equal(s.calls.details, 1);
});
