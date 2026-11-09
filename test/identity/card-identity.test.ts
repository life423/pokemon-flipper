import { test } from "node:test";
import assert from "node:assert/strict";
import {
    titleContradiction,
    reprintShown,
    lookAlikeProblem,
    noveltyIn,
    normalizeCardNumber,
    sameCardNumber,
    printingClaimFromText,
    photoPrinting,
    resolvePrinting,
    identifyCard,
    readyForPricing,
    mapVariantPrintings,
    printingLabel,
    normalizeSetName,
    sameSetFamily,
    setSearchTerm,
} from "../../server/identity/card-identity.ts";
import { variantFor } from "../../server/pricing/raw-prices.ts";
import { toCardRecord } from "../../server/pricing/pkmnprices.ts";

const usd = variant => ({ currency: "USD", variant });

// Real pkmnprices records, trimmed.
const LUGIA = toCardRecord({
    id: 28158,
    name: "Lugia",
    number: "009",
    total_set_number: "111",
    set: { id: 607, name: "Neo Genesis" },
    prices: [
        usd("1st Edition Holofoil"),
        usd("Unlimited Holofoil"),
    ],
});

const BASE_CHARIZARD = toCardRecord({
    id: 12927,
    name: "Charizard",
    number: "004",
    total_set_number: "102",
    set: { id: 463, name: "Base Set" },
    prices: [usd("Holofoil")],
});

const BLACK_DOT_CHARIZARD = toCardRecord({
    id: 12972,
    name: "Charizard (Black Dot Error)",
    number: "004",
    total_set_number: "102",
    set: { id: 463, name: "Base Set" },
    prices: [usd("Holofoil")],
});

const SHADOWLESS_CHARIZARD = toCardRecord({
    id: 19092,
    name: "Charizard",
    number: "004",
    total_set_number: "102",
    set: { id: 525, name: "Base Set (Shadowless)" },
    prices: [
        usd("1st Edition Holofoil"),
        usd("Unlimited Holofoil"),
    ],
});

const lookup = (...records) => async () => records;
const BASE_FAMILY = lookup(BASE_CHARIZARD, BLACK_DOT_CHARIZARD, SHADOWLESS_CHARIZARD);

const LUGIA_LISTING = {
    title: "2000 Pokemon Neo Genesis Lugia 9/111 Holo Rare Unlimited Vintage WOTC CLEAN",
    aspects: {
        Set: "Neo Genesis",
        "Card Number": "9/111",
        "Card Name": "Lugia",
        Language: "English",
    },
};

function photoCheck(marks = {}, overrides = {}) {
    return {
        printingMarks: {
            firstEditionStamp: "NOT_PRESENT",
            artBoxShadow: "PRESENT",
            evidence: [],
            ...marks,
        },
        printedName: "Lugia",
        printedNumber: "9/111",
        ...overrides,
    };
}

function charizardListing(title) {
    return {
        title,
        aspects: {
            Set: "Base Set",
            "Card Number": "4/102",
            "Card Name": "Charizard",
            Language: "English",
        },
    };
}

const charizardPhotos = (marks) =>
    photoCheck(marks, { printedName: "Charizard", printedNumber: "4/102" });

// The milestone

test("milestone: the Lugia listing is Unlimited, matched despite 009/111, and selects the Unlimited variant only", async () => {
    const { identity, card } = await identifyCard(LUGIA_LISTING, photoCheck(), {
        lookupCards: lookup(LUGIA),
    });

    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.set, "Neo Genesis");
    assert.equal(identity.name, "Lugia");
    assert.equal(identity.cardNumber, "009/111");
    assert.equal(identity.printing, "UNLIMITED");
    assert.equal(identity.finish, "HOLO");
    assert.ok(readyForPricing(identity));

    const { variant } = variantFor(card, identity);
    assert.equal(variant?.printing, "UNLIMITED");
    assert.equal(variant?.name, "Unlimited Holofoil");
});

test("a 1st Edition copy of the same card selects only the 1st Edition variant", async () => {
    const listing = {
        ...LUGIA_LISTING,
        title: "2000 Pokemon Neo Genesis 1st Edition Lugia 9/111 Holo",
    };

    const { identity, card } = await identifyCard(
        listing,
        photoCheck({ firstEditionStamp: "VISIBLE" }),
        { lookupCards: lookup(LUGIA) }
    );

    assert.equal(identity.printing, "FIRST_EDITION");
    assert.equal(variantFor(card, identity).variant?.name, "1st Edition Holofoil");
});

test("seller says Unlimited but the photos show a stamp: review, and no price", async () => {
    const { identity } = await identifyCard(
        LUGIA_LISTING,
        photoCheck({ firstEditionStamp: "VISIBLE" }),
        { lookupCards: lookup(LUGIA) }
    );

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.equal(readyForPricing(identity), false);
});

// Base Set, split across two database sets

test("Base Set: a Shadowless copy selects the Shadowless catalog record", async () => {
    const { identity, card } = await identifyCard(
        charizardListing("1999 Pokemon Base Set Shadowless Charizard 4/102 Holo Rare"),
        charizardPhotos({ artBoxShadow: "ABSENT" }),
        { lookupCards: BASE_FAMILY }
    );

    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.printing, "SHADOWLESS");
    assert.equal(identity.set, "Base Set (Shadowless)");
    assert.equal(variantFor(card, identity).variant?.recordId, SHADOWLESS_CHARIZARD.id);
});

test("Base Set: an Unlimited copy selects the Base Set catalog record", async () => {
    const { identity, card } = await identifyCard(
        charizardListing("1999 Pokemon Base Set Charizard 4/102 Holo Unlimited"),
        charizardPhotos({ artBoxShadow: "PRESENT" }),
        { lookupCards: BASE_FAMILY }
    );

    assert.equal(identity.printing, "UNLIMITED");
    assert.equal(identity.set, "Base Set");
    assert.equal(variantFor(card, identity).variant?.recordId, BASE_CHARIZARD.id);
});

test("Base Set: a 1st Edition copy selects its own printing", async () => {
    const { identity, card } = await identifyCard(
        charizardListing("1999 Pokemon Base Set 1st Edition Charizard 4/102 Holo"),
        charizardPhotos({ firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" }),
        { lookupCards: BASE_FAMILY }
    );

    assert.equal(identity.printing, "FIRST_EDITION");
    assert.equal(identity.set, "Base Set (Shadowless)");
    assert.equal(variantFor(card, identity).variant?.name, "1st Edition Holofoil");
});

test("Base Set: the Black Dot Error only matches when the listing names it", async () => {
    const photos = charizardPhotos({ artBoxShadow: "PRESENT" });

    const plain = await identifyCard(
        charizardListing("1999 Pokemon Base Set Charizard 4/102 Holo Unlimited"),
        photos,
        { lookupCards: BASE_FAMILY }
    );
    const error = await identifyCard(
        charizardListing("Base Set Charizard 4/102 Holo Unlimited Black Dot Error"),
        photos,
        { lookupCards: BASE_FAMILY }
    );

    assert.equal(plain.identity.name, "Charizard");
    assert.equal(error.identity.name, "Charizard (Black Dot Error)");
    assert.equal(variantFor(error.card, error.identity).variant?.recordId, BLACK_DOT_CHARIZARD.id);
});

test("printing labels are read set by set", () => {
    assert.deepEqual(mapVariantPrintings(["Holofoil"], "Base Set"), { Holofoil: "UNLIMITED" });
    assert.deepEqual(
        mapVariantPrintings(["1st Edition Holofoil", "Unlimited Holofoil"], "Base Set (Shadowless)"),
        { "1st Edition Holofoil": "FIRST_EDITION", "Unlimited Holofoil": "SHADOWLESS" }
    );
    assert.deepEqual(mapVariantPrintings(["Unlimited Holofoil"], "Neo Genesis"), {
        "Unlimited Holofoil": "UNLIMITED",
    });
    assert.deepEqual(mapVariantPrintings(["Holofoil"], "Neo Genesis"), { Holofoil: "UNKNOWN" });
    assert.deepEqual(mapVariantPrintings(["Holofoil", "Reverse Holofoil"], "Crown Zenith"), {
        Holofoil: "UNLIMITED",
        "Reverse Holofoil": "UNLIMITED",
    });
});

// Matching the database record

test("the Rare Candy mix-up can't happen: a database match for the wrong card is rejected", async () => {
    const rareCandy = toCardRecord({
        id: 1,
        name: "Rare Candy",
        number: "90",
        total_set_number: "110",
        set: { name: "EX Holon Phantoms" },
        prices: [],
    });

    const { identity } = await identifyCard(LUGIA_LISTING, photoCheck(), {
        lookupCards: lookup(rareCandy),
    });

    assert.equal(identity.status, "NEEDS_REVIEW");
});

test("a printed number that disagrees with the item details goes to review", async () => {
    const { identity } = await identifyCard(
        LUGIA_LISTING,
        photoCheck({}, { printedNumber: "19/111" }),
        { lookupCards: lookup(LUGIA) }
    );

    assert.equal(identity.status, "NEEDS_REVIEW");
});

test("a listing without a set or number goes to review before any lookup", async () => {
    let looked = false;
    const listing = { title: "Lugia holo", aspects: { "Card Name": "Lugia" } };

    const { identity } = await identifyCard(listing, photoCheck({}, { printedNumber: null }), {
        lookupCards: async () => {
            looked = true;
            return [];
        },
    });

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.equal(looked, false);
});

test("an unknown printing is never ready for pricing", () => {
    const identity = {
        status: "IDENTIFIED",
        set: "Neo Genesis",
        cardNumber: "009/111",
        printing: "UNKNOWN",
    };

    assert.equal(readyForPricing(identity), false);
});

// Card numbers

test("009/111 and 9/111 are the same card number", () => {
    const parsed = normalizeCardNumber("009/111");

    assert.equal(parsed.number, 9);
    assert.equal(parsed.total, 111);
    assert.equal(sameCardNumber("009/111", "9/111"), true);
    assert.equal(sameCardNumber("#9/111", "9 / 111"), true);
    assert.equal(sameCardNumber("9/111", "9/112"), false);
    assert.equal(sameCardNumber("9/111", "19/111"), false);
});

test("promo numbers keep their letters", () => {
    assert.equal(sameCardNumber("SWSH075", "SWSH75"), true);
    assert.equal(sameCardNumber("SWSH075", "SM075"), false);
    assert.equal(sameCardNumber("TG01/TG30", "TG1/TG30"), true);
});

function dateNumberCase(name = "Dark Alakazam", numerator = 1, month = "Jan") {
    const fraction = `${numerator}/82`;
    const listing = { title: `${name} 2000 Pokemon Team Rocket #${numerator} Holo PSA 9`,
        aspects: { Set: "Team Rocket", "Card Name": name, "Card Number": `${month}-82`, Language: "English" } };
    const photos = photoCheck({}, { printedName: name, printedNumber: fraction, cardCount: "ONE",
        cardMatch: { verdict: "MATCH", problems: [] }, images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, issues: [] }],
        cardIdentity: { name, set: "Team Rocket", cardNumber: fraction, language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Collector fraction is readable."] } });
    const record = toCardRecord({ id: numerator, name, number: String(numerator), total_set_number: "82", set: { id: 1, name: "Team Rocket" }, prices: [usd("Unlimited Holofoil")] });
    return { listing, photos, record, fraction };
}

test("date-formatted seller numbers use an agreeing title and clear photographed fraction without changing source evidence", async () => {
    for (const [name, numerator, month] of [["Dark Alakazam", 1, "Jan"], ["Dark Gyarados", 8, "Aug"], ["Dark Arbok", 2, "Feb"]]) {
        const { listing, photos, record, fraction } = dateNumberCase(name, numerator, month);
        const before = structuredClone({ listing, photos });
        const { identity } = await identifyCard(listing, photos, { lookupCards: async query => { assert.equal(query.cardNumber, fraction); return [record]; } });
        assert.equal(identity.status, "IDENTIFIED"); assert.equal(identity.cardNumber, fraction);
        assert.match(identity.reasons.join(" "), /seller-entered card number.*date-formatted/);
        assert.deepEqual({ listing, photos }, before);
        assert.equal(sameCardNumber(`${month}-82`, fraction), false, "global number matching must not guess from a month");
    }
});

test("date-shaped specifics alone, partial photo numbers and real contradictions never authorize a corrected lookup", async () => {
    for (const change of [
        (value) => { value.listing.title = "Dark Alakazam Team Rocket Holo PSA 9"; },
        (value) => { value.listing.title = "Dark Alakazam Team Rocket #2 Holo PSA 9"; },
        (value) => { value.listing.title = "Dark Alakazam Team Rocket #1/83 Holo PSA 9"; },
        (value) => { value.listing.aspects["Card Number"] = "Feb-82"; },
        (value) => { value.listing.aspects["Card Number"] = "Jan-83"; },
        (value) => { value.listing.aspects["Card Number"] = "2/82"; },
        (value) => { value.photos.cardIdentity.confidence = "MEDIUM"; },
        (value) => { value.photos.printedNumber = "1"; },
        (value) => { value.photos.cardIdentity.cardNumber = "1"; },
        (value) => { value.photos.images[0].isStockImage = true; },
        (value) => { value.photos.cardCount = "UNKNOWN"; },
        (value) => { value.photos.cardMatch = { verdict: "MISMATCH", problems: ["Another card is pictured."] }; },
        (value) => { value.photos.printedNumber = value.photos.cardIdentity.cardNumber = "H1/H82"; value.listing.title = "Dark Alakazam Team Rocket #H1/H82 Holo PSA 9"; },
        (value) => { value.photos.printedNumber = value.photos.cardIdentity.cardNumber = "1a/82"; value.listing.title = "Dark Alakazam Team Rocket #1a/82 Holo PSA 9"; },
    ]) {
        const value = dateNumberCase(); change(value);
        const result = await identifyCard(value.listing, value.photos, { lookupCards: async () => assert.fail("unresolved number must not start a catalog lookup") });
        assert.equal(result.identity.status, "NEEDS_REVIEW"); assert.equal(result.card, null);
    }
});

function sellerFieldCorrectionCase() {
    const listing = { title: "Wizards of the Coast Dark Blastoise 3/82 Team Rocket Holo Rare English 2000",
        aspects: { "Card Name": "Dark Blastoise", Set: "Team Rocket", "Card Number": "20/82", Finish: "Regular", Features: "Unlimited", Language: "English" } };
    const photos = photoCheck({ firstEditionStamp: "NOT_PRESENT", artBoxShadow: "CANT_TELL", evidence: ["The edition stamp area is visibly empty."] }, {
        holder: "NONE", cardCount: "ONE", printedName: "Dark Blastoise", printedNumber: "3/82",
        images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, issues: [] }, { number: 2, view: "BACK", usable: true, isStockImage: false, issues: [] }],
        cardIdentity: { name: "Dark Blastoise", set: "Team Rocket", cardNumber: "3/82", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["Readable name, 3/82 fraction, Rocket symbol and holo artwork agree."] },
        cardMatch: { verdict: "MISMATCH", problems: ["The visible collector number is 3/82, not the seller aspects' 20/82.", "The visible finish is holo, not the seller aspects' Regular."] } });
    const record = toCardRecord({ id: 26301, name: "Dark Blastoise", number: "003", total_set_number: "82", set: { id: 1, name: "Team Rocket" }, prices: [usd("Unlimited Holofoil")] });
    return { listing, photos, record };
}

test("catalog-backed physical number and finish correct conflicting seller fields while original claims remain intact", async t => {
    t.mock.method(globalThis, "fetch", () => assert.fail("seller-field correction needs only supplied observations and catalog records"));
    const { listing, photos, record } = sellerFieldCorrectionCase(), before = structuredClone({ listing, photos });
    let lookups = 0;
    const result = await identifyCard(listing, photos, { lookupCards: async query => { lookups++; assert.equal(query.cardNumber, "3/82"); return [record]; } });
    assert.equal(lookups, 1); assert.equal(result.identity.status, "IDENTIFIED"); assert.equal(result.sellerClaimsCorrected, true);
    assert.equal(sameCardNumber(result.identity.cardNumber, "3/82"), true); assert.equal(result.identity.finish, "HOLO"); assert.equal(result.identity.printing, "UNLIMITED");
    assert.equal(result.identity.notThisCard, undefined); assert.match(result.identity.reasons.join(" "), /seller|item details/i);
    assert.doesNotMatch(result.identity.reasons.join(" "), /independent.*readings/i);
    assert.deepEqual({ listing, photos }, before);
});

test("seller-field correction requires complete strong photos and an explicit agreeing title before any corrected lookup", async () => {
    const cases = [
        ["medium identity", value => { value.photos.cardIdentity.confidence = "MEDIUM"; }],
        ["missing identity evidence", value => { value.photos.cardIdentity.evidence = []; }],
        ["unknown language", value => { value.photos.cardIdentity.language = null; }],
        ["partial photographed number", value => { value.photos.printedNumber = "3"; }],
        ["partial structured number", value => { value.photos.cardIdentity.cardNumber = "3"; }],
        ["partial title number", value => { value.listing.title = "Dark Blastoise #3 Team Rocket Holo English"; }],
        ["different title number", value => { value.listing.title = "Dark Blastoise 20/82 Team Rocket Holo English"; }],
        ["unresolved name mixed with metadata", value => { value.photos.cardMatch.problems.push("The seller aspects say Regular finish, but the card name is unreadable despite holo treatment."); }],
        ["different title denominator", value => { value.listing.title = "Dark Blastoise 3/83 Team Rocket Holo English"; }],
        ["different title finish", value => { value.listing.title = "Dark Blastoise 3/82 Team Rocket Non-Holo English"; }],
        ["reverse-holo title", value => { value.listing.title = "Dark Blastoise 3/82 Team Rocket Reverse Holo English"; }],
        ["missing title set", value => { value.listing.title = "Dark Blastoise 3/82 Holo English"; }],
        ["different title set", value => { value.listing.title = "Dark Blastoise 3/82 Jungle Holo English"; }],
        ["wrong reprint set", value => { value.listing.title = "Dark Blastoise 3/82 EX Team Rocket Returns Holo English"; }],
        ["stock front", value => { value.photos.images[0].isStockImage = true; }],
        ["unknown holder", value => { value.photos.holder = "UNKNOWN"; }],
        ["multiple cards", value => { value.photos.cardCount = "MULTIPLE"; }],
        ["unexplained mismatch", value => { value.photos.cardMatch.problems = ["The pictured card does not match the listing."]; }],
    ];
    for (const [label, change] of cases) {
        const value = sellerFieldCorrectionCase(); change(value);
        const result = await identifyCard(value.listing, value.photos, { lookupCards: async () => assert.fail(`${label}: rejected evidence cannot authorize a guessed catalog target`) });
        assert.equal(result.identity.status, "NEEDS_REVIEW", label); assert.equal(result.sellerClaimsCorrected, undefined, label);
    }
});

test("seller-field correction does not collapse different printed names, owners or forms", async () => {
    for (const name of ["Blastoise", "Dark Alakazam", "Dark Blastoise ex", "Misty's Dark Blastoise"]) {
        const value = sellerFieldCorrectionCase(); value.listing.title = `${name} 3/82 Team Rocket Holo English`;
        const result = await identifyCard(value.listing, value.photos, { lookupCards: async () => assert.fail("a different name or printed form cannot authorize correction") });
        assert.equal(result.identity.status, "NEEDS_REVIEW", name); assert.equal(result.sellerClaimsCorrected, undefined, name);
    }
});

test("real printing, authenticity and reprint concerns remain blocking after seller-field comparisons", async () => {
    for (const change of [
        value => { value.photos.printingMarks.firstEditionStamp = "VISIBLE"; },
        value => { value.photos.printingMarks.reprintMark = "CELEBRATIONS_25TH"; },
        value => { value.photos.cardMatch.problems.push("The card shows a suspicious counterfeit texture."); },
        value => { value.photos.cardMatch.problems.push("The visible First Edition stamp contradicts the seller's Unlimited claim."); },
    ]) {
        const value = sellerFieldCorrectionCase(); change(value);
        const result = await identifyCard(value.listing, value.photos, { lookupCards: lookup(value.record) });
        assert.equal(result.identity.status, "NEEDS_REVIEW"); assert.equal(result.sellerClaimsCorrected, undefined);
    }
});

test("a local seller-field correction is not accepted without a matching catalog identity and finish", async () => {
    for (const records of [[], [{ ...sellerFieldCorrectionCase().record, variants: [{ name: "Unlimited", printing: "UNLIMITED", finish: "NON_HOLO" }] }],
        [{ ...sellerFieldCorrectionCase().record, name: "Dark Blastoise ex" }]]) {
        const { listing, photos } = sellerFieldCorrectionCase();
        const result = await identifyCard(listing, photos, { lookupCards: lookup(...records) });
        assert.equal(result.identity.status, "NEEDS_REVIEW"); assert.equal(result.sellerClaimsCorrected, undefined);
    }
});

// Printing claims and evidence

test("reads printing claims from seller text", () => {
    assert.equal(printingClaimFromText("Lugia 9/111 Holo 1st Edition"), "FIRST_EDITION");
    assert.equal(printingClaimFromText("1st Ed. Charizard"), "FIRST_EDITION");
    assert.equal(printingClaimFromText("Charizard Shadowless Holo"), "SHADOWLESS");
    assert.equal(printingClaimFromText("Unlimited Shadowless Charizard"), "SHADOWLESS");
    assert.equal(printingClaimFromText("Lugia Holo Rare Unlimited"), "UNLIMITED");
    assert.equal(printingClaimFromText("Lugia holo non 1st edition"), "UNLIMITED");
    assert.equal(printingClaimFromText("Lugia Holo WOTC Vintage"), "NOT_STATED");
    assert.equal(printingClaimFromText("1st Edition Lugia Unlimited"), "CONFLICTING");
});

test("photo marks map to a printing, and unclear marks stay unknown", () => {
    const base = { shadowMatters: true };
    const other = { shadowMatters: false };

    assert.equal(photoPrinting({ firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" }, base), "FIRST_EDITION");
    assert.equal(photoPrinting({ firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" }, base), "SHADOWLESS");
    assert.equal(photoPrinting({ firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT" }, base), "UNLIMITED");
    assert.equal(photoPrinting({ firstEditionStamp: "NOT_PRESENT", artBoxShadow: "CANT_TELL" }, base), "UNKNOWN");
    assert.equal(photoPrinting({ firstEditionStamp: "NOT_PRESENT", artBoxShadow: "CANT_TELL" }, other), "UNLIMITED");
    assert.equal(photoPrinting({ firstEditionStamp: "CANT_TELL", artBoxShadow: "PRESENT" }, other), "UNKNOWN");
    assert.equal(photoPrinting(undefined, other), "UNKNOWN");
});

test("printing evidence that all agrees is accepted", () => {
    const result = resolvePrinting(
        { title: "UNLIMITED", itemSpecifics: "UNLIMITED", photo: "UNLIMITED" },
        { hasEditions: true }
    );

    assert.equal(result.status, "ACCEPTED");
    assert.equal(result.printing, "UNLIMITED");
});

test("agreement between the title and photo cannot override a lower-value seller detail", () => {
    const result = resolvePrinting(
        { title: "FIRST_EDITION", itemSpecifics: "UNLIMITED", photo: "FIRST_EDITION" },
        { hasEditions: true }
    );

    assert.equal(result.status, "NEEDS_REVIEW");
});

test("photos that can't show the printing send it to review", () => {
    const result = resolvePrinting(
        { title: "UNLIMITED", itemSpecifics: "NOT_STATED", photo: "UNKNOWN" },
        { hasEditions: true }
    );

    assert.equal(result.status, "NEEDS_REVIEW");
});

test("a pricier printing seen only in the photos is flagged, not priced", () => {
    const result = resolvePrinting(
        { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION" },
        { hasEditions: true }
    );

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.match(result.reason, /sleeper/);
});

test("a card printed once needs no printing evidence, but a 1st Edition claim on it is flagged", () => {
    const plain = resolvePrinting(
        { title: "NOT_STATED", itemSpecifics: "NOT_STATED", photo: "UNKNOWN" },
        { hasEditions: false }
    );
    const claimed = resolvePrinting(
        { title: "FIRST_EDITION", itemSpecifics: "NOT_STATED", photo: "UNKNOWN" },
        { hasEditions: false }
    );

    assert.equal(plain.status, "ACCEPTED");
    assert.equal(plain.printing, "UNLIMITED");
    assert.equal(claimed.status, "NEEDS_REVIEW");
});

// Collector names for Base Set printings

test("Base Set printings are named the way collectors say them", () => {
    assert.equal(printingLabel("FIRST_EDITION", "Base Set (Shadowless)"), "1st Edition Shadowless");
    assert.equal(printingLabel("SHADOWLESS", "Base Set"), "Shadowless (no 1st Edition)");
    assert.equal(printingLabel("UNLIMITED", "Base Set"), "Unlimited");
    assert.equal(printingLabel("FIRST_EDITION", "Neo Genesis"), "1st Edition");
});

test("titles naming 1st Edition Shadowless and Shadowless without 1st Edition are read apart", () => {
    assert.equal(printingClaimFromText("1999 Base Set 1st Edition Shadowless Charizard"), "FIRST_EDITION");
    assert.equal(printingClaimFromText("1999 Base Set Shadowless without 1st Edition Charizard"), "SHADOWLESS");
    assert.equal(printingClaimFromText("Charizard Shadowless NO 1st Ed PSA 8"), "SHADOWLESS");
});

// Graded listings: set names from labels, and the label as printing evidence

test("set names from grading labels and series prefixes match the database's", () => {
    assert.equal(normalizeSetName("1999 POKEMON GAME"), "base set");
    assert.equal(normalizeSetName("POKEMON NEO GENESIS"), "neo genesis");
    assert.equal(normalizeSetName("2000 Pokemon Rocket"), "team rocket");
    assert.equal(normalizeSetName("2000 POKEMON NEO GENESIS 1ST EDITION"), "neo genesis");
    assert.equal(normalizeSetName("1999 POKEMON GAME SHADOWLESS"), "base set shadowless");
    assert.equal(normalizeSetName("Base Set (Shadowless)"), "base set shadowless");
    assert.equal(sameSetFamily("Crown Zenith", "Sword & Shield Crown Zenith"), true);
    for (const set of ["Sword & Shield - Lost Origin", "Sword Shield Lost Origin", "Sword and Shield Lost Origin"]) {
        assert.equal(normalizeSetName(set), "lost origin");
        assert.equal(setSearchTerm(set), "Origin");
        assert.equal(sameSetFamily("SWSH11: Lost Origin", set), true);
        assert.equal(sameSetFamily("SWSH09: Brilliant Stars", set), false);
    }
    assert.equal(normalizeSetName("Sword & Shield"), "sword shield");
    assert.equal(normalizeSetName("Sword & Shield Black Star Promos"), "sword shield black star promos");
    assert.equal(sameSetFamily("Sword & Shield Base Set", "Base Set"), false);
    assert.equal(sameSetFamily("XY Base Set", "Base Set"), false);
    assert.equal(sameSetFamily("Base Set 2", "Base Set"), false);
});

function slabListing(title, labelText, marks = { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL" }) {
    return {
        listing: {
            title,
            aspects: {
                Set: "1999 POKEMON GAME",
                "Card Number": "4",
                "Card Name": "CHARIZARD-HOLO",
                Language: "English",
            },
        },
        photos: {
            ...charizardPhotos(marks),
            slab: { present: true, labelText },
        },
    };
}

test("a PSA label that prints 1ST EDITION identifies a 1st Edition Shadowless slab", async () => {
    const { listing, photos } = slabListing(
        "PSA 8 1999 Pokemon 1st Edition Charizard 4/102 Holo",
        "1999 POKEMON GAME 1ST EDITION #4 CHARIZARD-HOLO NM-MT 8"
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.printing, "FIRST_EDITION");
    assert.equal(identity.printingLabel, "1st Edition Shadowless");
    assert.equal(identity.evidence.photoSource, "slab label");
});

test("a legible label with no edition printed marks an Unlimited slab", async () => {
    const { listing, photos } = slabListing(
        "PSA 8 Base Set Charizard 4/102 Holo",
        "1999 POKEMON GAME #4 CHARIZARD-HOLO NM-MT 8"
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.printing, "UNLIMITED");
    assert.equal(identity.set, "Base Set");
});

test("a reprint in the title, or another card number, overrules the item details", () => {
    assert.match(
        titleContradiction("Pokemon TCG Charizard 4/102 25th anniversary celebrations", "Base Set", "4/102"),
        /celebrations|anniversary/
    );
    assert.match(
        titleContradiction("Charizard Pokemon 30th Anniversary Classic Collection", "Base Set", "4/102"),
        /classic collection|anniversary/
    );
    assert.match(
        titleContradiction("NM Pokemon TCG Obsidian Flames Hyper Rare Charizard 228/197", "Base Set", "4/102"),
        /228\/197/
    );
    assert.equal(
        titleContradiction("Charizard 4/102 Celebrations 25th Anniversary", "Celebrations: Classic Collection", "4/102"),
        null
    );
    assert.equal(titleContradiction("Lugia 009/111 Neo Genesis Holo 9/10 condition", "Neo Genesis", "9/111"), null);
});

test("a database may put a series name in front of a set, except Base Set", () => {
    assert.equal(sameSetFamily("XY - Evolutions", "Evolutions"), true);
    assert.equal(sameSetFamily("SV: Scarlet & Violet 151", "151"), true);
    assert.equal(sameSetFamily("SV: Prismatic Evolutions", "Evolutions"), false);
    assert.equal(sameSetFamily("XY Base Set", "Base Set"), false);
});

test("Celebrations reprints are fine when the set says Celebrations", () => {
    assert.equal(titleContradiction("Charizard 30th Celebration Promo", "Me: 30th Celebration", "4"), null);
    assert.match(titleContradiction("Rainbow Charizard GX gold foil Holo", "Hidden Fates", "9"), /gold foil/);
});

test("a reprint listed with the original's set goes to review", async () => {
    const listing = charizardListing("Pokemon TCG Charizard 4/102 25th anniversary celebrations");
    const { identity } = await identifyCard(listing, charizardPhotos(), { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.match(identity.reasons[0], /celebrations|anniversary/);
});

function lugiaSlab(title, labelText, marks = {}) {
    return {
        listing: { ...LUGIA_LISTING, title },
        photos: photoCheck(marks, { slab: { present: true, labelText } }),
    };
}

test("in a set with no Shadowless printing, a label that names no printing says Unlimited", async () => {
    const { listing, photos } = lugiaSlab(
        "Pokemon Lugia Neo Genesis Unlimited Holo #9 PSA 6",
        "2000 P.M. NEO GENESIS #9 LUGIA-HOLO EX-MT 6"
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: lookup(LUGIA) });

    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.printing, "UNLIMITED");
    assert.equal(identity.evidence.label, "UNLIMITED");
    assert.equal(identity.evidence.photoSource, "photos");
});

test("a 1st Edition title and stamp go to review when the label doesn't say 1st Edition", async () => {
    const { listing, photos } = lugiaSlab(
        "PSA 6 Lugia 1st Edition Neo Genesis 9/111 Holo",
        "2000 P.M. NEO GENESIS #9 LUGIA-HOLO EX-MT 6",
        { firstEditionStamp: "VISIBLE" }
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: lookup(LUGIA) });

    assert.equal(identity.status, "NEEDS_REVIEW");
});

test("in Base Set, a label without 1ST EDITION still rules 1st Edition out", async () => {
    const { listing, photos } = slabListing(
        "PSA 8 1st Edition Charizard 4/102 Holo",
        "1999 POKEMON GAME #4 CHARIZARD-HOLO NM-MT 8",
        { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT" }
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.match(identity.reasons.join(" "), /label/);
});

test("a complete ordinary PSA Base Set label prevents a false Shadowless upgrade", async () => {
    const { listing, photos } = slabListing(
        "PSA 8 Charizard 4/102 Holo",
        "1999 POKEMON GAME #4 CHARIZARD-HOLO NM-MT 8",
        { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" }
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.printing, "UNLIMITED");
    assert.equal(identity.evidence.label, "UNLIMITED");
    assert.equal(identity.evidence.photoSource, "PSA slab label");
});

test("repeated incorrect Shadowless photo readings cannot overrule the ordinary PSA label", async () => {
    const { listing, photos } = slabListing("1999 Base Set Charizard Holo PSA 8", "1999 POKEMON GAME #4 CHARIZARD-HOLO NM-MT 8", { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "ABSENT" });
    photos.slab.grader = "PSA";
    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY,
        photoIdentity: { name: "Charizard", set: "Base Set (Shadowless)", cardNumber: "4/102", finish: "HOLO", printing: "SHADOWLESS" } });
    assert.equal(identity.status, "IDENTIFIED"); assert.equal(identity.printing, "UNLIMITED"); assert.equal(identity.set, "Base Set");
    const partial = { ...photos, slab: { ...photos.slab, labelText: "PSA 8" } };
    assert.equal((await identifyCard(listing, partial, { lookupCards: BASE_FAMILY })).identity.status, "NEEDS_REVIEW", "a partial label cannot authorize a premium");
});

test("corroborated physical identity can survive a missing catalog record without inventing prices", async () => {
    const { identity, card } = await identifyCard(charizardListing(), charizardPhotos(), { lookupCards: async () => [],
        photoIdentity: { name: "Charizard", set: "Base Set", cardNumber: "4/102", finish: "HOLO", printing: "UNLIMITED" } });
    assert.equal(identity.status, "IDENTIFIED"); assert.equal(card, null);
    assert.equal(variantFor(card, identity).variant, undefined);
});

test("a title that disagrees with the slab label goes to review", async () => {
    const { listing, photos } = slabListing(
        "PSA 8 1st Edition Charizard 4/102 Holo",
        "1999 POKEMON GAME SHADOWLESS #4 CHARIZARD-HOLO NM-MT 8"
    );

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "NEEDS_REVIEW");
});

test("look-alike reprints: the listing has to say which Classic Collection it is", () => {
    const CLASSIC = "Celebrations: Classic Collection";
    const strict = { requireMarker: true };

    assert.match(
        lookAlikeProblem("MINTY Charizard Classic Collection 4/102 30th ANNIVERSARY!", CLASSIC, strict) ?? "",
        /2026 30th Celebration/
    );
    assert.match(
        lookAlikeProblem("Charizard 4/102 Celebrations Classic Collection Holo 120HP", CLASSIC, strict) ?? "",
        /doesn't say which/
    );
    assert.equal(lookAlikeProblem("PSA 9 Charizard Holo 4/102 Celebrations Classic Collection 2021", CLASSIC, strict), null);
    assert.equal(lookAlikeProblem("Charizard 4/102 30th Celebration Classic Collection 2026", "ME: 30th Celebration", strict), null);
    assert.equal(lookAlikeProblem("1999 Base Set Charizard 4/102 Holo", "Base Set", strict), null);
});

test("metal cards are novelties, including PSA's Ultra Premium label", () => {
    assert.equal(noveltyIn("Aquapolis 143 Metal Energy Reverse Foil PSA 7"), null);
    assert.equal(titleContradiction("Aquapolis 143 Metal Energy Reverse Foil PSA 7", "Aquapolis", "143/147"), null);
    assert.ok(noveltyIn("2021 POKEMON CELEBRATIONS ULTRA-PREM COLL #4 CHARIZARD PSA 6"));
    assert.ok(noveltyIn("Charizard Gold Metal Card Celebrations"));
    assert.equal(noveltyIn("2021 Pokemon Celebrations Classic Collection Charizard 4/102"), null);
});

test("a reprint's mark in the photos means it isn't the card the title says", () => {
    assert.match(reprintShown("CELEBRATIONS_25TH", "Base Set") ?? "", /Celebrations/);
    assert.equal(reprintShown("CELEBRATIONS_25TH", "Celebrations: Classic Collection"), null);
    assert.match(reprintShown("BASE_SET_2", "Base Set") ?? "", /Base Set 2/);
    assert.equal(reprintShown("NONE_SEEN", "Base Set"), null);
    assert.equal(reprintShown("CANT_TELL", "Base Set"), null);
});

test("a Celebrations logo in the photos sends a Base Set listing to review as a reprint", async () => {
    const listing = charizardListing("Nintendo Pokemon TCG Charizard Base Set 4/102 Holo Rare 3rd Print EN 1999");
    const photos = charizardPhotos();
    photos.printingMarks = { ...photos.printingMarks, reprintMark: "CELEBRATIONS_25TH" };

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.match(identity.notThisCard, /Celebrations/);
    assert.match(identity.reasons[0], /isn't the Base Set card/);
});

test("anything else in the photos that shows another card sends it to review", async () => {
    const listing = charizardListing("PSA 8 Charizard 4/102 Base Set Holo");
    const photos = charizardPhotos();
    photos.cardMatch = { verdict: "MISMATCH", problems: ["the set total reads 4/132"] };

    const { identity } = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });

    assert.equal(identity.status, "NEEDS_REVIEW");
    assert.equal(identity.notThisCard, "the set total reads 4/132");
});

test("a pricier claim the photos clearly don't support is priced as what the photos show", () => {
    const decision = resolvePrinting(
        { title: "NOT_STATED", itemSpecifics: "FIRST_EDITION", photo: "UNLIMITED" },
        { hasEditions: true, setName: "Neo Genesis" }
    );

    assert.equal(decision.status, "ACCEPTED");
    assert.equal(decision.printing, "UNLIMITED");
    assert.match(decision.reason, /seller says 1st Edition, but the photos show Unlimited/);
});

test("a readable Shadowless card and matching title can correct a seller's First Edition field", async () => {
    const listing = charizardListing("Charizard 4/102 Base Set Shadowless Holo");
    listing.aspects.Features = "1st Edition";
    const photos = charizardPhotos({ artBoxShadow: "ABSENT" });
    const confirmed = await identifyCard(listing, photos, { lookupCards: BASE_FAMILY });
    assert.equal(confirmed.identity.status, "IDENTIFIED");
    assert.equal(confirmed.identity.printing, "SHADOWLESS");
    assert.equal(confirmed.identity.recordId, SHADOWLESS_CHARIZARD.id);
    assert.match(confirmed.identity.reasons.join(" "), /conflicting item detail/);
    assert.equal(listing.aspects.Features, "1st Edition");

    const unreadable = await identifyCard(listing, charizardPhotos({ firstEditionStamp: "CANT_TELL", artBoxShadow: "ABSENT" }),
        { lookupCards: BASE_FAMILY });
    assert.equal(unreadable.identity.status, "NEEDS_REVIEW");
    const conflictingLabel = resolvePrinting({ title: "SHADOWLESS", itemSpecifics: "FIRST_EDITION", photo: "SHADOWLESS", label: "FIRST_EDITION" },
        { hasEditions: true, setName: "Base Set" });
    assert.equal(conflictingLabel.status, "NEEDS_REVIEW");
});

test("a pricier printing than the seller claims still needs both: no settling upward", () => {
    const decision = resolvePrinting(
        { title: "UNLIMITED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION" },
        { hasEditions: true, setName: "Neo Genesis" }
    );

    assert.equal(decision.status, "NEEDS_REVIEW");
});

test("corroborated photos can identify a seller's wrong set and finish without borrowing the seller's premium claim", async () => {
    const seller = { title: "Lugia Team Rocket 9/111 Non-Holo Unlimited", aspects: { Set: "Team Rocket", "Card Name": "Lugia", "Card Number": "9/111", Finish: "Non-Holo" } };
    const photos = photoCheck({}, { cardMatch: { verdict: "MISMATCH", problems: ["Neo Genesis symbol, not Team Rocket"] } });
    const { identity, card } = await identifyCard(seller, photos, {
        lookupCards: lookup(LUGIA), photoIdentity: { name: "Lugia", set: "Neo Genesis", cardNumber: "9/111", finish: "HOLO", printing: "UNLIMITED" },
    });
    assert.equal(identity.status, "IDENTIFIED");
    assert.equal(identity.set, "Neo Genesis");
    assert.equal(identity.finish, "HOLO");
    assert.equal(variantFor(card, identity).variant?.name, "Unlimited Holofoil");
    const ordinary = await identifyCard(seller, photos, { lookupCards: lookup(LUGIA) });
    assert.equal(ordinary.identity.status, "NEEDS_REVIEW");
});

test("unclaimed premium printings require corroboration and conflicting slab/text claims still require review", () => {
    const evidence = { title: "UNLIMITED", itemSpecifics: "NOT_STATED", photo: "FIRST_EDITION" };
    assert.equal(resolvePrinting(evidence, { hasEditions: true }).status, "NEEDS_REVIEW");
    assert.equal(resolvePrinting({ ...evidence, corroboratedPhoto: "FIRST_EDITION" }, { hasEditions: true }).status, "ACCEPTED");
    assert.equal(resolvePrinting({ ...evidence, corroboratedPhoto: "FIRST_EDITION", label: "UNLIMITED" }, { hasEditions: true }).status, "NEEDS_REVIEW");
    assert.equal(resolvePrinting({ ...evidence, corroboratedPhoto: "FIRST_EDITION" }, { hasEditions: false }).status, "NEEDS_REVIEW");
});
