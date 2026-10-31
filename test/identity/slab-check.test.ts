import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSlab, graderCode, normalizeGrade, normalizeSlabReading } from "../../server/identity/slab-check.ts";

const slabPhotos = (overrides = {}) => ({
    photoSufficiency: "SUFFICIENT",
    images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, issues: [] }],
    slab: {
        present: true,
        grader: "PSA",
        grade: "9",
        gradeQualifier: null,
        certNumber: "12345678",
        labelText: "2000 POKEMON NEO GENESIS #9 LUGIA-HOLO MINT 9",
        caseCondition: "INTACT",
        authenticity: "NONE_SEEN",
        concerns: [],
        ...overrides,
    },
});

const ASPECTS = {
    "Professional Grader": "Professional Sports Authenticator (PSA)",
    Grade: "9",
    "Certification Number": "12345678",
};

test("grader names and grades are read the way labels and eBay write them", () => {
    assert.equal(graderCode("Professional Sports Authenticator (PSA)"), "PSA");
    assert.equal(graderCode("Beckett Grading Services (BGS)"), "BGS");
    assert.equal(graderCode("Certified Guaranty Company (CGC)"), "CGC");
    assert.equal(graderCode("Some Other Grader"), null);
    assert.equal(normalizeGrade("MINT 9"), "9");
    assert.equal(normalizeGrade("GEM MT 10"), "10");
    assert.equal(normalizeGrade("8.5"), "8.5");
    assert.equal(normalizeGrade("unreadable"), null);
});

test("a readable slab that matches its item details passes, with a cert link", () => {
    const slab = checkSlab(slabPhotos(), ASPECTS);

    assert.equal(slab.status, "OK");
    assert.equal(slab.grader, "PSA");
    assert.equal(slab.grade, "9");
    assert.equal(slab.certUrl, "https://www.psacard.com/cert/12345678");
});

test("PSA ordinary grade descriptions are not special qualifiers; mixed or incorrect descriptions remain blocked", () => {
    for (const [grade, gradeQualifier] of [["7", "NM"], ["7", "Near Mint"], ["8", "NM-MT"], ["9", "MINT"], ["10", "GEM-MT"], ["6", "EX-MT"]]) {
        assert.equal(checkSlab(slabPhotos({ grade, gradeQualifier })).status, "OK");
    }
    for (const gradeQualifier of ["NM OC", "OC", "MK", "Authentic", "MINT"]) assert.equal(checkSlab(slabPhotos({ grade: "7", gradeQualifier })).status, "NEEDS_REVIEW");
});

test("item details that disagree with the label send it to review", () => {
    const wrongGrade = checkSlab(slabPhotos(), { ...ASPECTS, Grade: "10" });
    const wrongCert = checkSlab(slabPhotos(), { ...ASPECTS, "Certification Number": "99999999" });

    assert.equal(wrongGrade.status, "NEEDS_REVIEW");
    assert.match(wrongGrade.reasons[0], /grade 10, but the label says 9/);
    assert.equal(wrongCert.status, "NEEDS_REVIEW");
});

test("a cracked case, a qualifier, or an unreadable label goes to review", () => {
    assert.equal(checkSlab(slabPhotos({ caseCondition: "CRACKED" }), ASPECTS).status, "NEEDS_REVIEW");
    assert.equal(checkSlab(slabPhotos({ gradeQualifier: "OC" }), ASPECTS).status, "NEEDS_REVIEW");
    assert.equal(checkSlab(slabPhotos({ grade: null }), ASPECTS).status, "NEEDS_REVIEW");
    assert.equal(checkSlab({ slab: { present: false } }, ASPECTS).status, "NEEDS_REVIEW");
});

test("\"None\" written as a qualifier isn't a qualifier", () => {
    assert.equal(checkSlab(slabPhotos({ gradeQualifier: "None" }), ASPECTS).status, "OK");
});

test("a slab that looks fake is flagged as such", () => {
    assert.equal(checkSlab(slabPhotos({ authenticity: "LIKELY_FAKE" }), ASPECTS).status, "LIKELY_FAKE");
});

test("unsupported suspicion is not external verification and visible authenticity evidence remains blocking", () => {
    const reading = slabPhotos({ authenticity: "POSSIBLE", authenticityEvidence: [] }).slab;
    assert.equal(normalizeSlabReading(reading).authenticity, "NONE_SEEN");
    assert.equal(checkSlab({ ...slabPhotos(), slab: reading }).status, "OK");
    assert.equal(normalizeSlabReading({ ...reading, authenticityEvidence: ["A reseal seam is visible."] }).authenticity, "POSSIBLE");
    assert.equal(normalizeSlabReading({ ...reading, authenticity: "LIKELY_FAKE" }).authenticity, "LIKELY_FAKE");
    assert.equal(normalizeSlabReading({ ...reading, authenticityEvidence: undefined }).authenticity, "POSSIBLE");
});

test("stock-only or unusable slab photos require review even with a readable label", () => {
    const stock = slabPhotos();
    stock.images[0].isStockImage = true;
    const unusable = slabPhotos();
    unusable.images[0].usable = false;

    for (const photos of [stock, unusable, { ...slabPhotos(), images: [] }]) {
        const result = checkSlab(photos, ASPECTS);
        assert.equal(result.status, "NEEDS_REVIEW");
        assert.match(result.reasons.join(" "), /specific slab/);
    }
});

test("a real front photo still permits slab resale without raw-card grading views", () => {
    const photos = slabPhotos();
    // Sufficiency describes raw condition grading, which slabs skip.
    photos.photoSufficiency = "INSUFFICIENT";
    photos.images.push({ number: 2, view: "BACK", usable: false, isStockImage: true, issues: [] });
    assert.equal(checkSlab(photos, ASPECTS).status, "OK");
});

test("ordinary CGC grade descriptions are accepted only at their corresponding numeric grade", () => {
    for (const [grade, description] of [["8.5", "NM/MINT+"], ["8.5", "near mint / mint +"], ["8", "NM/Mint"], ["9.5", "Mint+"], ["9", "Mint"], ["10", "Gem Mint"], ["6.5", "Ex/NM+"], ["1", "Poor"]]) {
        const slab = checkSlab(slabPhotos({ grader: "CGC", grade, gradeQualifier: description }));
        assert.equal(slab.status, "OK", `${grade}: ${description}`);
        assert.equal(slab.gradeQualifier, null);
    }
    for (const overrides of [{ grader: "CGC", grade: "8", gradeQualifier: "NM/MINT+" }, { grader: "PSA", grade: "8.5", gradeQualifier: "NM/MINT+" }]) {
        assert.equal(checkSlab(slabPhotos(overrides)).status, "NEEDS_REVIEW");
    }
});

test("CGC special labels, mixed qualifiers and unknown designations still require review", () => {
    for (const gradeQualifier of ["Pristine", "Perfect", "Black Label", "OC", "Authentic Altered", "NM/MINT+ OC", "Mint (MC)", "unrecognized label"]) {
        const slab = checkSlab(slabPhotos({ grader: "CGC", grade: "8.5", gradeQualifier }));
        assert.equal(slab.status, "NEEDS_REVIEW", gradeQualifier);
        assert.equal(slab.gradeQualifier, gradeQualifier);
    }
    assert.equal(checkSlab(slabPhotos({ grader: "CGC", grade: "10", gradeQualifier: "Pristine" })).status, "NEEDS_REVIEW");
    assert.equal(checkSlab(slabPhotos({ grader: "CGC", grade: "9.5", gradeQualifier: "Gem Mint" })).status, "NEEDS_REVIEW", "legacy Gem Mint 9.5 is not silently pooled with current Mint+ 9.5");
});

test("accepting an ordinary CGC description does not bypass photo, label, case or authenticity checks", () => {
    const valid = { grader: "CGC", grade: "8.5", gradeQualifier: "NM/MINT+" };
    for (const overrides of [{ caseCondition: "CRACKED" }, { authenticity: "POSSIBLE" }]) {
        assert.equal(checkSlab(slabPhotos({ ...valid, ...overrides })).status, "NEEDS_REVIEW");
    }
    assert.equal(checkSlab(slabPhotos({ ...valid, authenticity: "LIKELY_FAKE" })).status, "LIKELY_FAKE");
    assert.equal(checkSlab(slabPhotos(valid), { Grade: "9" }).status, "NEEDS_REVIEW");
    assert.equal(checkSlab(slabPhotos(valid), { "Certification Number": "wrong123" }).status, "NEEDS_REVIEW");
    const stock = slabPhotos(valid); stock.images[0].isStockImage = true;
    assert.equal(checkSlab(stock).status, "NEEDS_REVIEW");
});
