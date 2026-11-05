import { test } from "node:test";
import assert from "node:assert/strict";
import { criteriaMismatch, describeSearchCriteria, evaluatedCriteriaMismatch, explicitCriteria, finishIn, marketplaceQuery, searchAttributes } from "../../shared/search-criteria.ts";
import { cleanReading, readSearchByRules, readSearchLocally } from "../../server/search/intent.ts";
import { canAutoAnalyze } from "../../shared/analysis.ts";
import { photoFitsSearch } from "../../server/ai/photo-find.ts";

const query = "aquapolis cards psa 7 or better holo";
const intent = () => readSearchByRules(query);
const listing = (title = "Aquapolis Espeon Holo PSA 8", extra = {}) => ({ id: "one", title, isGraded: true, currentPrice: 200, shipping: 5, buyingOption: "FIXED_PRICE", bids: 0, endTime: null, images: [], seller: null, url: "", ...extra });

test("ordinary grade operators read inclusively without needing AI", () => {
    for (const phrase of ["psa 7 or better", "PSA 7+", "PSA7+", "at least PSA 7", "PSA at least 7", "PSA grade 7 or higher", "PSA 7 and up"]) {
        assert.deepEqual(explicitCriteria(phrase), { grader: "PSA", minGrade: 7, maxGrade: 10, finish: null }, phrase);
    }
    assert.deepEqual(explicitCriteria("cgc 8.5 to 9.5 reverse holo"), { grader: "CGC", minGrade: 8.5, maxGrade: 9.5, finish: "REVERSE_HOLO" });
    assert.equal(explicitCriteria("psa 8").maxGrade, 8);
    assert.equal(explicitCriteria("psa at most 8").minGrade, 1);
    assert.equal(explicitCriteria("1999 mewtwo 10/102").minGrade, null);
});

test("holo, non-holo and reverse holo remain distinct", () => {
    assert.equal(finishIn("NON_HOLO"), "NON_HOLO");
    assert.equal(finishIn("non-holographic"), "NON_HOLO");
    assert.equal(finishIn("reverse holo"), "REVERSE_HOLO");
    assert.equal(finishIn("holographic"), "HOLO");
    assert.equal(finishIn("holos"), "HOLO");
    assert.equal(finishIn("Aquapolis"), null);
    assert.equal(finishIn("normal type holo cards"), "HOLO");
    for (const title of ["Aquapolis PSA 8 Non-Holo", "Aquapolis PSA 8 Reverse Holo"]) assert.equal(criteriaMismatch(searchAttributes(title), intent()), "OTHER_FINISH");
});

test("range searches omit the exact grade from marketplace keywords", () => {
    assert.equal(marketplaceQuery(query, intent()), "aquapolis holo PSA");
    assert.equal(marketplaceQuery("aquapolis psa 7+ holo", readSearchByRules("aquapolis psa 7+ holo")), "aquapolis holo PSA");
    assert.equal(marketplaceQuery("aquapolis psa 8 holo", readSearchByRules("aquapolis psa 8 holo")), "aquapolis holo PSA 8");
    assert.equal(marketplaceQuery("show me some aquapolis cards graded 7+ holo", readSearchByRules("show me some aquapolis cards graded 7+ holo")), "aquapolis holo graded");
    assert.ok(marketplaceQuery("charizard 4/102", readSearchByRules("charizard 4/102")).includes("4/102"));
    assert.equal(marketplaceQuery("Unown A", readSearchByRules("Unown A")), "unown a");
});

test("conversational deal requests retain the exact printed name and independent criteria", () => {
    for (const prefix of ["find me a good deal on a", "Can you please find me the best deal on a", "show me deals for a", "get me a cheap deal on a"]) {
        const search = `${prefix} holographic Dark Blastoise Team Rocket`;
        const read = readSearchLocally(search);
        assert.equal(read.cardName, "dark blastoise", search);
        assert.deepEqual(read.sets, ["Team Rocket"]);
        assert.equal(read.finish, "HOLO");
        assert.equal(read.cardNumber, null, "only the catalog may supply an omitted number");
        assert.equal(marketplaceQuery(search, read), "holo dark blastoise team rocket");
    }
    const read = readSearchLocally("find me a good deal on a Team Rocket Dark Blastoise 1st Edition PSA 8 reverse holo");
    assert.equal(read.cardName, "dark blastoise");
    assert.equal(read.printing, "FIRST_EDITION");
    assert.equal(read.grader, "PSA");
    assert.equal(read.minGrade, 8);
    assert.equal(read.maxGrade, 8);
    assert.equal(read.finish, "REVERSE_HOLO");
    assert.ok(marketplaceQuery("reverse holographic", readSearchByRules("reverse holographic")).includes("reverse holo"));
    assert.equal(marketplaceQuery("non-holographic", readSearchByRules("non-holographic")), "non-holo");
    assert.equal(readSearchLocally("find me deals on raw Dark Blastoise Team Rocket non-holo").graded, false);
    for (const name of ["Unown A", "Rocket's Mewtwo", "Blaine's Arcanine"]) {
        const plain = readSearchLocally(name);
        assert.equal(readSearchLocally(`find me a good deal on ${name}`).cardName, plain.cardName);
        assert.equal(marketplaceQuery(name, plain), name.toLowerCase());
    }
});

test("AI cleaning preserves explicit constraints and never requires filler words in titles", () => {
    const read = cleanReading({ ...intent(), sets: ["Aquapolis"], minGrade: 1, maxGrade: 1, grader: "CGC", titleWords: ["cards", "holo"], keywords: "Aquapolis holo PSA" }, query);
    assert.deepEqual([read.grader, read.minGrade, read.maxGrade, read.finish], ["PSA", 7, 10, "HOLO"]);
    assert.deepEqual(read.titleWords, []);
    assert.deepEqual(describeSearchCriteria(read), ["PSA 7+", "Holo only"]);
    assert.equal(marketplaceQuery(query, read), "aquapolis holo PSA");
});

test("saved model printing guesses cannot narrow or override the requested printing", () => {
    const cases = [
        { search: "Pokemon Fossil holo PSA 8", savedPrinting: "FIRST_EDITION", savedKeywords: "Fossil 1st Edition holo PSA", expected: null, expectedKeywords: "pokemon fossil holo" },
        { search: "Pokemon Fossil Unlimited holo PSA 8", savedPrinting: "FIRST_EDITION", savedKeywords: "Fossil 1st Edition holo PSA", expected: "UNLIMITED", expectedKeywords: "pokemon fossil unlimited holo" },
        { search: "Pokemon Fossil 1st Edition holo PSA 8", savedPrinting: "UNLIMITED", savedKeywords: "Fossil Unlimited holo PSA", expected: "FIRST_EDITION", expectedKeywords: "pokemon fossil 1st edition holo" },
        { search: "Pokemon Fossil First Edition Unlimited holo PSA 8", savedPrinting: "FIRST_EDITION", savedKeywords: "Fossil 1st Edition holo PSA", expected: null, expectedKeywords: "pokemon fossil first edition unlimited holo" },
    ] as const;
    for (const { search, savedPrinting, savedKeywords, expected, expectedKeywords } of cases) {
        const saved = { ...readSearchByRules(search), printing: savedPrinting, keywords: savedKeywords };
        const cleaned = cleanReading(saved, search);
        assert.equal(cleaned.printing, expected, search);
        assert.equal(cleaned.keywords, expectedKeywords, search);
        assert.equal(marketplaceQuery(search, cleaned), `${expectedKeywords} PSA 8`, search);
        assert.equal(readSearchLocally(search).printing, expected, search);
    }
    const explicitFirst = cleanReading({ ...intent(), printing: "FIRST_EDITION", keywords: "Fossil 1st Edition holo PSA" }, "Pokemon Fossil 1st Edition holo PSA 8");
    assert.equal(explicitFirst.printing, "FIRST_EDITION");
    assert.equal(explicitFirst.keywords, "Fossil 1st Edition holo PSA", "matching compact keywords remain reusable");
});

test("saved discovery keywords cannot substitute or add a finish constraint", () => {
    for (const [requested, expected] of [["holo", "HOLO"], ["reverse holo", "REVERSE_HOLO"], ["non-holo", "NON_HOLO"], ["", null], ["holo non-holo", null]] as const) {
        const search = `Dark Blastoise Team Rocket ${requested}`.trim();
        for (const savedFinish of ["holo", "reverse holo", "non-holo"]) {
            const savedKeywords = `Dark Blastoise Team Rocket ${savedFinish}`;
            const read = cleanReading({ ...readSearchByRules(search), keywords: savedKeywords }, search);
            assert.equal(read.finish, expected, search);
            assert.equal(read.keywords, savedFinish === requested ? savedKeywords : search.toLowerCase());
            assert.equal(marketplaceQuery(search, read), search.toLowerCase());
        }
    }
    const read = cleanReading({ ...intent(), keywords: "Aquapolis PSA" }, query);
    assert.equal(read.keywords, "Aquapolis PSA", "compatible keywords without a finish remain reusable");
});

test("natural language reading can represent spelled-out grades while plain queries stay unconstrained", () => {
    const read = cleanReading({ ...intent(), minGrade: 7, maxGrade: 10 }, "Aquapolis holo graded seven or higher by PSA");
    assert.deepEqual([read.minGrade, read.maxGrade], [7, 10]);
    const plain = cleanReading({ ...intent(), grader: "PSA", minGrade: 7, maxGrade: 10 }, "aquapolis cards");
    assert.equal(plain.grader, null);
    assert.equal(plain.minGrade, null);
    assert.equal(cleanReading({ ...intent(), minGrade: 9, maxGrade: 10 }, "PSA Aquapolis holo").minGrade, null);
    assert.equal(readSearchByRules("ungraded aquapolis").graded, false);
    const implicit = cleanReading({ ...intent(), grader: null, minGrade: 7, maxGrade: 10 }, "aquapolis holos 7 or better");
    assert.equal(implicit.minGrade, 7);
    assert.equal(implicit.finish, "HOLO");
});

test("only the requested grader and in-range slab grades match", () => {
    for (const grade of [7, 8, 9, 10]) assert.equal(criteriaMismatch(searchAttributes(`Aquapolis PSA ${grade} Holo`), intent()), null);
    assert.equal(criteriaMismatch(searchAttributes("Aquapolis PSA 6 Holo"), intent()), "OTHER_GRADE");
    assert.equal(criteriaMismatch(searchAttributes("Aquapolis CGC 8 Holo"), intent()), "OTHER_GRADER");
    assert.equal(criteriaMismatch(searchAttributes("Aquapolis Holo PSA"), intent()), "UNCONFIRMED_CRITERIA");
    assert.equal(criteriaMismatch(searchAttributes("Aquapolis Holo PSA"), intent(), false), null);
    assert.equal(searchAttributes("1999 Pokemon Aquapolis Holo PSA NM-MT 8").grade, 8);
    for (const grader of ["PSA", "CGC", "BGS", "SGC", "TAG"]) for (const delimiter of ["-", "- ", " - ", "– ", " — "]) {
        assert.deepEqual(searchAttributes(`Aquapolis Holo ${grader}${delimiter}8.5`), { grader, grade: 8.5, finish: "HOLO" });
    }
    assert.deepEqual(searchAttributes("1999 Pokemon Jolteon-Holo Jungle 4/64 PSA- 8 Fresh Slab With TB"), { grader: "PSA", grade: 8, finish: "HOLO" });
    assert.equal(searchAttributes("Aquapolis PSA-ready 10").grade, null);
    assert.equal(searchAttributes("Aquapolis PSA- 2003 Holo 7/147").grade, null);
    assert.equal(searchAttributes("PSA 2003 Aquapolis Holo 7/147").grade, null);
    assert.equal(searchAttributes("Aquapolis holo", { "Professional Grader": "Professional Sports Authenticator (PSA)", Grade: "NM-MT 8" }).grade, 8);
});

test("photo discovery cannot recover the wrong finish as a matching holo", () => {
    const photo = { cardCount: 1, isStockImage: false, card: { name: "Espeon", set: "Aquapolis", cardNumber: "H9/H32", language: "English", confidence: "HIGH", finish: "REVERSE_HOLO" }, printingMarks: {}, shows: "card" };
    assert.equal(photoFitsSearch(photo, intent()), false);
    assert.equal(photoFitsSearch({ ...photo, card: { ...photo.card, finish: "HOLO" } }, intent()), true);
});

test("a full photo assessment overrides matching seller claims for search results", () => {
    const evaluation = { listing: { title: "Aquapolis Holo PSA 8", aspects: {} }, identity: { finish: "HOLO" }, photoCheck: { slab: { present: true, grader: "PSA", grade: "8" } } };
    assert.equal(evaluatedCriteriaMismatch(evaluation, intent()), false);
    assert.equal(evaluatedCriteriaMismatch({ ...evaluation, photoCheck: { slab: { present: true, grader: "PSA", grade: "6" } } }, intent()), true);
    assert.equal(evaluatedCriteriaMismatch({ ...evaluation, identity: { finish: "REVERSE_HOLO" } }, intent()), true);
});
