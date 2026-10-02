import { test } from "node:test";
import assert from "node:assert/strict";
import { bargainScore, bargainSignals } from "../shared/signals.ts";

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
    assert.deepEqual(bargainSignals(listing("1999 Pokemon Base Set Charizard 4/102 Holo"), evaluation({})), []);
});

test("photos showing a pricier printing the seller never states is the strongest signal", () => {
    const signals = bargainSignals(
        listing("Charizard 4/102 Base Set Holo"),
        evaluation({ status: "NEEDS_REVIEW", evidence: { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION", photoNotes: [] } })
    );

    assert.equal(signals[0].id, "SLEEPER");
    assert.match(signals[0].label, /1st Edition/);
});

test("a verified 1st Edition the title doesn't mention", () => {
    const signals = bargainSignals(
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
    const signals = bargainSignals(listing("Old Pokemon Charzard Card Vintage WOTC"), evaluation({}));

    assert.deepEqual(ids(signals).sort(), ["NAME_OFF", "NO_SET", "TITLE_OMITS_HOLO"]);
    assert.equal(bargainScore(signals), 43);
});

test("an auction with no bids ending at 3 AM Eastern", () => {
    const now = Date.parse("2026-10-02T12:00:00Z");
    const signals = bargainSignals(
        listing("1999 Pokemon Base Set Charizard 4/102 Holo", { buyingOption: "AUCTION", bids: 0, endTime: "2026-10-03T07:00:00Z" }),
        evaluation({}),
        now
    );

    assert.deepEqual(ids(signals), ["FEW_BIDS", "QUIET_HOUR"]);
    assert.match(signals[1].label, /3 AM Eastern/);
});

test("weak photos on an identified card, and a new seller", () => {
    const signals = bargainSignals(
        listing("1999 Pokemon Base Set Charizard 4/102 Holo", { seller: { username: "n", feedbackPercentage: 100, feedbackScore: 3 } }),
        evaluation({}, { photoCheck: { photoSufficiency: "PARTIAL" } })
    );

    assert.deepEqual(ids(signals), ["WEAK_PHOTOS", "NEW_SELLER"]);
});
