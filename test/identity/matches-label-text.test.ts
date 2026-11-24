import assert from "node:assert/strict";
import { test } from "node:test";
import { canMatchLabelText, matchesLabelText } from "../../server/identity/matches-label-text.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";
import type { ScreeningSoldReference } from "../../shared/types.ts";
import { salesSummary } from "../fixtures/card-evaluation.ts";

const market: ScreeningSoldReference = {
    recordId: 1, name: "Darkrai VSTAR", set: "SWSH: Crown Zenith: Galarian Gallery", cardNumber: "GG50/GG70",
    printing: "UNLIMITED", finish: "HOLO", soleCatalogVariant: true, grader: "PSA", grade: "10", condition: null, summary: salesSummary("PSA", 10),
};
const listing: ListingDetails = {
    id: "test", title: "2023 Pokemon Crown Zenith #GG50 Full Art/Darkrai VSTAR PSA 10", url: "", images: [],
    condition: "Graded", cardCondition: null, conditionNotes: [], buyingOption: "FIXED_PRICE", bids: 0, endTime: null,
    price: 200, shipping: 5, seller: null, aspects: {
        "Card Name": "FULL ART/DARKRAI VSTAR", Set: "2023 POKEMON SWORD AND SHIELD CROWN ZENITH", "Card Number": "GG50",
        "Professional Grader": "Professional Sports Authenticator (PSA)", Grade: "10", "Certification Number": "12345678",
    },
};
const lines = ["2023 POKEMON SWSH", "FA/DARKRAI VSTAR", "CROWN ZENITH", "# GG50", "GEM MT", "10", "12345678",
    "Evolves from Darkrai V", "F GG50/GG70", "When your Pokémon VSTAR", "is Knocked Out, your opponent takes 2 Prize cards."];

test("corroborates an incomplete seller record using one PSA label and the English card face", () => {
    assert.ok(matchesLabelText(lines, listing, market));
    for (const [index, replacement] of [[1, "FA/DARKRAI V"], [2, "LOST ORIGIN"], [3, "# GG51"], [4, "MINT"],
        [5, "9"], [6, "12345679"], [7, "Evolves from Charizard V"], [8, "F GG50"], [8, "GG50/70"], [8, "GG50/GG69"], [9, "VSTAR"]] as const) {
        assert.equal(matchesLabelText(lines.with(index, replacement), listing, market), false, replacement);
    }
    for (const conflicting of ["GG51/GG70", "23456789", "REVERSE HOLO", "Japanese", "REPRINT", "OC", "1st Edition", "CGC", "World Championship"]) {
        assert.equal(matchesLabelText([...lines, conflicting], listing, market), false, conflicting);
    }
});

test("contradictory seller details or a different market cannot qualify for this label check", () => {
    for (const [key, value] of Object.entries({ Set: "Silver Tempest", "Card Name": "Darkrai V", "Card Number": "GG51",
        Finish: "Non-Holo", Edition: "1st Edition", Language: "Japanese", "Grade Qualifier": "MK", Grade: "9",
        "Professional Grader": "CGC", "Certification Number": "" })) {
        assert.equal(canMatchLabelText({ ...listing, aspects: { ...listing.aspects, [key]: value } }, market), false, key);
    }
    for (const suffix of ["reprint", "French", "reverse holo", "(MC)", "cracked case"]) {
        assert.equal(canMatchLabelText({ ...listing, title: listing.title + " " + suffix }, market), false, suffix);
    }
    assert.equal(canMatchLabelText({ ...listing, title: listing.title.replace("GG50", "GG51") }, market), false);
    assert.equal(canMatchLabelText({ ...listing, title: listing.title.replace("Darkrai", "Giratina") }, market), false);
    assert.equal(canMatchLabelText({ ...listing, conditionNotes: ["Tampered holder"] }, market), false);
    assert.equal(canMatchLabelText(listing, { ...market, soleCatalogVariant: undefined }), false);
    assert.equal(canMatchLabelText(listing, { ...market, finish: "REVERSE_HOLO" }), false);
    assert.equal(canMatchLabelText(listing, { ...market, set: "Crown Zenith Promo" }), false);
});


test("an English 151 illustration label requires the matching certificate, grade, numbered card face and language code", () => {
    const reference = { ...market, name: "Charmeleon", set: "SV: Scarlet & Violet 151", cardNumber: "169/165", grade: "9" };
    const slab = { ...listing, title: "Pokemon MEW EN 151 Charmeleon #169 PSA 9", aspects: { ...listing.aspects,
        Set: "Pokemon MEW EN-151", "Card Name": "Charmeleon", "Card Number": "169", Grade: "9" } };
    const observed = ["2023 POKEMON MEW EN", "CHARMELEON", "ILLUSTRATION RARE", "#169", "MINT", "9", "12345678",
        "Evolves from Charmander", "MEW EN", "169/165"];
    assert.ok(matchesLabelText(observed, slab, reference));
    for (const [where, changed] of [[0, "2023 POKEMON SV2a"], [1, "CHARMANDER"], [2, "SPECIAL ILLUSTRATION RARE"],
        [4, "GEM MT"], [5, "10"], [6, "23456789"], [8, "MEW FR"], [9, "169/198"]] as const)
        assert.equal(matchesLabelText(observed.with(where, changed), slab, reference), false, changed);
});
