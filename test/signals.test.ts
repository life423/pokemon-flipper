import { test } from "node:test";
import assert from "node:assert/strict";
import { compareListingEvidence, listingSignals } from "../shared/signals.ts";

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
    seller: { username: "s", feedbackPercentage: 100, feedbackScore: 500 },
    ...extra,
});

const evaluation = (identity, extra = {}) => ({
    identity: {
        status: "IDENTIFIED",
        name: "Charizard",
        set: "Base Set",
        cardNumber: "004/102",
        printing: "UNLIMITED",
        printingLabel: "Unlimited",
        finish: "HOLO",
        language: "ENGLISH",
        evidence: { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "UNLIMITED", photoNotes: [] },
        reasons: [],
        ...identity,
    },
    photoCheck: { photoSufficiency: "SUFFICIENT" },
    ...extra,
});

const ids = (signals) => signals.map((signal) => signal.id);

test("a clean, well-listed card has no signals", () => {
    assert.deepEqual(listingSignals(listing("1999 Pokemon Base Set Charizard 4/102 Holo"), evaluation({})), []);
});

test("photos showing a pricier printing the seller never states is the strongest signal", () => {
    const signals = listingSignals(
        listing("Charizard 4/102 Base Set Holo"),
        evaluation({ status: "NEEDS_REVIEW", evidence: { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION", photoNotes: [] } })
    );

    assert.equal(signals[0].id, "SLEEPER");
    assert.match(signals[0].label, /1st Edition/);
});

test("a verified 1st Edition the title doesn't mention", () => {
    const signals = listingSignals(
        listing("Charizard 4/102 Base Set Holo"),
        evaluation({
            printing: "FIRST_EDITION",
            printingLabel: "1st Edition",
            evidence: { title: "NOT_STATED", itemSpecifics: "FIRST_EDITION", photo: "FIRST_EDITION", photoNotes: [] },
        })
    );

    assert.deepEqual(ids(signals), ["TITLE_OMITS_PRINTING"]);
});

test("vague titles: a misspelled name, no set or number, no holo", () => {
    const signals = listingSignals(listing("Old Pokemon Charzard Card Vintage WOTC"), evaluation({}));

    assert.deepEqual(ids(signals).sort(), ["NAME_OFF", "NO_SET", "TITLE_OMITS_HOLO"]);
    assert.ok(signals.every((signal) => signal.kind === "OPPORTUNITY"));
});

test("an auction with no bids ending at 3 AM Eastern", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const signals = listingSignals(
        listing("1999 Pokemon Base Set Charizard 4/102 Holo", { buyingOption: "AUCTION", bids: 0, endTime: "2026-10-03T07:00:00Z" }),
        evaluation({}),
        now
    );

    assert.deepEqual(ids(signals), ["FEW_BIDS", "QUIET_HOUR"]);
    assert.match(signals[1].label, /3 AM Eastern/);
});

test("weak photos on an identified card, and a new seller", () => {
    const signals = listingSignals(
        listing("1999 Pokemon Base Set Charizard 4/102 Holo", { seller: { username: "n", feedbackPercentage: 100, feedbackScore: 3 } }),
        evaluation({}, { photoCheck: { photoSufficiency: "PARTIAL" } })
    );

    assert.deepEqual(ids(signals), ["WEAK_PHOTOS", "NEW_SELLER"]);
});

test("a listing Dig deeper found says how it was hidden", () => {
    const misspelled = listingSignals(
        listing("Charzard 4/102 Holo WOTC", { found: { how: "MISSPELLED", note: "one card: Charizard 4/102" } }),
        evaluation({})
    );

    assert.equal(misspelled.find((signal) => signal.id === "FOUND").kind, "CONTEXT");
    assert.equal(misspelled.find((signal) => signal.id === "FOUND").label, "Found via alternate-name search");
    assert.ok(misspelled.some((signal) => signal.id === "NAME_OFF" && signal.kind === "OPPORTUNITY"));
});

test("limited seller history and weak photos remain cautions without improving opportunity order", () => {
    const title = "Charizard Base Set 4/102 Holo";
    const risks = listingSignals(listing(title, { seller: { feedbackScore: 3 } }), evaluation({}, { photoCheck: { photoSufficiency: "PARTIAL" } }));
    assert.ok(risks.every((signal) => signal.kind === "CAUTION"));
    assert.equal(compareListingEvidence(risks, listingSignals(listing(title), evaluation({}))), 0);
    assert.ok(risks.every((signal) => !/misprice|bargain/i.test(signal.detail)));
});

test("the same printing mistake is explained once and strongest evidence outranks stacked title clues", () => {
    const premium = listingSignals(listing("Charizard Base Set 4/102 Holo", { mistakes: [{ kind: "FIRST_EDITION", detail: "Visible stamp" }] }), evaluation({ evidence: { photo: "FIRST_EDITION", title: "NOT_STATED", itemSpecifics: "NOT_STATED" } }));
    assert.equal(premium.filter((signal) => /SLEEPER|FIRST_EDITION|PRINTING/.test(signal.id)).length, 1);
    const vague = listingSignals(listing("Old Charzard Pokemon Card"), evaluation({}));
    assert.ok(compareListingEvidence(premium, vague) < 0);
});

test("a non-holo card does not produce a holo opportunity", () => {
    const signals = listingSignals(listing("Charizard Base Set 4/102"), evaluation({ finish: "NON_HOLO" }));
    assert.ok(!signals.some((signal) => signal.id === "TITLE_OMITS_HOLO"));
});

test("an invalid auction date does not break listing explanations", () => {
    assert.doesNotThrow(() => listingSignals(listing("Charizard", { buyingOption: "AUCTION", endTime: "not-a-date" }), evaluation({})));
});
