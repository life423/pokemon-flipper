import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSlab, graderCode, normalizeGrade } from "../slab-check.js";

const slabPhotos = (overrides = {}) => ({
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
