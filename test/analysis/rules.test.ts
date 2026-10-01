import { test } from "node:test";
import assert from "node:assert/strict";
import {
    getGradingMode,
    applyPhotoCheckRules,
    applyConditionRules,
    moreCautious,
} from "../../server/analysis/rules.ts";

const photo = (number, view, overrides = {}) => ({
    number,
    view,
    usable: true,
    isStockImage: false,
    issues: [],
    ...overrides,
});

const frontBackAndCloseUp = [photo(1, "FRONT"), photo(2, "BACK"), photo(3, "FRONT_DETAIL")];

function photoCheck(overrides = {}) {
    return {
        photoSufficiency: "SUFFICIENT",
        confidence: "HIGH",
        cardCount: "ONE",
        holder: "NONE",
        images: [photo(1, "FRONT"), photo(2, "BACK")],
        missingViews: [],
        problems: [],
        ...overrides,
    };
}

// Grading mode

test("front and back photos alone get full grading, with a close-up note", () => {
    const result = getGradingMode(photoCheck());
    assert.equal(result.mode, "FULL");
    assert.ok(result.reasons.some((reason) => reason.includes("close-up")));
});

test("a close-up removes the note", () => {
    const result = getGradingMode(photoCheck({ images: frontBackAndCloseUp }));
    assert.equal(result.mode, "FULL");
    assert.deepEqual(result.reasons, []);
});

test("a missing back photo limits grading", () => {
    const result = getGradingMode(photoCheck({ images: [photo(1, "FRONT")] }));
    assert.equal(result.mode, "LIMITED");
    assert.ok(result.reasons.some((reason) => reason.includes("back")));
});

test("no usable front photo blocks grading", () => {
    const images = [photo(1, "FRONT", { usable: false }), photo(2, "BACK")];
    assert.equal(getGradingMode(photoCheck({ images })).mode, "BLOCKED");
});

test("a stock photo can't stand in for the real front", () => {
    const images = [photo(1, "FRONT", { isStockImage: true }), photo(2, "BACK")];
    assert.equal(getGradingMode(photoCheck({ images })).mode, "BLOCKED");
});

test("lots and graded slabs are blocked", () => {
    assert.equal(getGradingMode(photoCheck({ cardCount: "MULTIPLE" })).mode, "BLOCKED");
    assert.equal(getGradingMode(photoCheck({ holder: "GRADED_SLAB" })).mode, "BLOCKED");
});

test("an unexpected verdict from the model fails closed", () => {
    assert.equal(getGradingMode(photoCheck({ photoSufficiency: "MAYBE" })).mode, "BLOCKED");
});

test("a sleeve or low confidence limits grading", () => {
    assert.equal(getGradingMode(photoCheck({ holder: "SLEEVE_OR_TOPLOADER" })).mode, "LIMITED");
    assert.equal(getGradingMode(photoCheck({ confidence: "LOW" })).mode, "LIMITED");
});

// Photo check rules

test("without a close-up, the photo check can't claim high confidence", () => {
    assert.equal(applyPhotoCheckRules(photoCheck(), 2).confidence, "MEDIUM");

    const withCloseUp = photoCheck({ images: frontBackAndCloseUp });
    assert.equal(applyPhotoCheckRules(withCloseUp, 3).confidence, "HIGH");
});

test("reports for missing or repeated photos are dropped", () => {
    const images = [photo(1, "FRONT"), photo(1, "BACK"), photo(9, "BACK")];
    const checked = applyPhotoCheckRules(photoCheck({ images }), 2);
    assert.deepEqual(checked.images.map((p) => p.number), [1]);
});

// Condition rules

const area = (visibility = "CLEAR", severity = "MINOR") => ({
    visibility,
    severity,
    observations: [],
});

function assessment(overrides = {}) {
    return {
        centering: area(),
        corners: area(),
        edges: area(),
        surface: area(),
        creases: "NONE_SEEN",
        rawCondition: "NEAR_MINT",
        gradeRange: { low: 7, likely: 8, high: 9 },
        authenticity: { concern: "NONE_SEEN", reasons: [] },
        confidence: "HIGH",
        limitations: [],
        summary: "",
        ...overrides,
    };
}

test("a valid report with close-ups passes through unchanged", () => {
    const input = assessment();
    assert.deepEqual(applyConditionRules(input, "FULL", { closeUps: true }), input);
});

test("without close-ups, a clean-looking surface becomes unconfirmed", () => {
    // The Neo Genesis Lugia case: surface rated clear with no flaws
    // from two whole-card photos with glare.
    const result = applyConditionRules(assessment({ surface: area("CLEAR", "NONE") }), "FULL");

    assert.equal(result.surface.visibility, "PARTIAL");
    assert.equal(result.surface.severity, "UNKNOWN");
    assert.equal(result.confidence, "MEDIUM");
    assert.ok(result.limitations.some((note) => note.includes("close-up")));
});

test("without close-ups, a visible surface flaw still counts", () => {
    const result = applyConditionRules(assessment({ surface: area("CLEAR", "MODERATE") }), "FULL");
    assert.equal(result.surface.severity, "MODERATE");
});

test("limited mode drops the likely grade and forces low confidence", () => {
    const result = applyConditionRules(assessment(), "LIMITED", { closeUps: true });
    assert.equal(result.gradeRange.likely, null);
    assert.equal(result.confidence, "LOW");
});

test("an unseen area gets unknown severity and caps confidence", () => {
    const result = applyConditionRules(
        assessment({ corners: area("NOT_VISIBLE", "NONE") }),
        "FULL",
        { closeUps: true }
    );
    assert.equal(result.corners.severity, "UNKNOWN");
    assert.equal(result.confidence, "MEDIUM");
});

test("out-of-order or out-of-range grades are rejected", () => {
    const reject = (gradeRange) =>
        assert.equal(applyConditionRules(assessment({ gradeRange }), "FULL"), null);

    reject({ low: 9, likely: 8, high: 7 });
    reject({ low: 7, likely: 10, high: 9 });
    reject({ low: 0, likely: null, high: 11 });
});

test("the model's original report is never modified", () => {
    const input = assessment();
    applyConditionRules(input, "LIMITED");
    assert.equal(input.gradeRange.likely, 8);
    assert.equal(input.surface.visibility, "CLEAR");
});

test("a partial verdict alone doesn't limit grading", () => {
    assert.equal(getGradingMode(photoCheck({ photoSufficiency: "PARTIAL" })).mode, "FULL");
});

test("an insufficient verdict still blocks grading", () => {
    assert.equal(getGradingMode(photoCheck({ photoSufficiency: "INSUFFICIENT" })).mode, "BLOCKED");
});

// Picking the more cautious of two answers

test("the lower grade range is the more cautious answer, in either order", () => {
    const optimistic = assessment({ gradeRange: { low: 7, likely: 8, high: 9 } });
    const cautious = assessment({ gradeRange: { low: 6, likely: 7, high: 8 } });

    assert.equal(moreCautious(optimistic, cautious), cautious);
    assert.equal(moreCautious(cautious, optimistic), cautious);
});

test("an authenticity flag or a crease in either answer wins over a lower grade", () => {
    const lower = assessment({ gradeRange: { low: 4, likely: 5, high: 6 } });
    const flagged = assessment({ authenticity: { concern: "POSSIBLE", reasons: ["odd font"] } });
    const creased = assessment({ creases: "PRESENT" });

    assert.equal(moreCautious(lower, flagged), flagged);
    assert.equal(moreCautious(lower, creased), creased);
});

test("with the same grades, the worse raw condition is more cautious", () => {
    const nearMint = assessment({ rawCondition: "NEAR_MINT" });
    const played = assessment({ rawCondition: "LIGHTLY_PLAYED" });

    assert.equal(moreCautious(nearMint, played), played);
});

test("a value the rules don't recognize counts as the riskiest", () => {
    const flagged = assessment({ authenticity: { concern: "LIKELY_FAKE", reasons: [] } });
    const unknown = assessment({ authenticity: { concern: "UNSURE", reasons: [] } });

    assert.equal(moreCautious(flagged, unknown), unknown);
});
