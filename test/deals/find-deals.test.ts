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
function steps(answers, { detailsFail = false } = {}) {
    const calls = { details: 0, checks: [] };

    return {
        calls,
        readTitle: async (listing) => ({ aspects: { ...listing.aspects, Set: "Base Set" }, filled: listing.aspects.Set ? [] : ["Set"] }),
        loadDetails: async () => {
            calls.details += 1;
            if (detailsFail) throw new Error("eBay request failed (429): Too many requests");
            return { title: "Charizard 4/102", aspects: { Set: "Base Set" }, shipping: 5, cardCondition: "Lightly played (Excellent)", conditionNotes: [], seller: null };
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
