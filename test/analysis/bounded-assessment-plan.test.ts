import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assessBoundedListing, buildBoundedAssessmentRequest, BOUNDED_ASSESSMENT_SCHEMA, SLAB_LABEL_SCHEMA, BOUNDED_PHOTO_LIMIT,
    type BoundedReading } from "../../server/ai/bounded-assessment.ts";
import type { ListingDetails } from "../../server/ebay/listings.ts";

const listing: ListingDetails = { id: "offline-plan", title: "Venusaur Base Set 15/102 Holo English", url: "#", price: 50, shipping: 5,
    buyingOption: "FIXED_PRICE", bids: 0, endTime: null, seller: null, condition: "Ungraded", cardCondition: "Lightly Played", conditionNotes: [],
    aspects: { Grade: "8", "Card Name": "Venusaur", Set: "Base Set", "Card Number": "15/102", Language: "English", Finish: "Holo", "Seller Notes": "UNTRUSTED_DO_NOT_INCLUDE" },
    images: ["photo-a", "photo-b", "photo-c", "photo-d"] };
const photos = [{ number: 1, url: "https://i.ebayimg.com/images/g/a/s-l1600.jpg" }, { number: 4, url: "https://i.ebayimg.com/images/g/d/s-l1600.jpg" }];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function strictObjects(value: unknown, path = "schema") {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, any>;
    if (schema.type === "object") {
        assert.equal(schema.additionalProperties, false, `${path} must forbid unspecified fields`);
        assert.ok(schema.properties && typeof schema.properties === "object", `${path} must define its properties`);
        assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} must require every declared field`);
    }
    for (const [key, child] of Object.entries(schema)) {
        if (Array.isArray(child)) child.forEach((entry, index) => strictObjects(entry, `${path}.${key}[${index}]`));
        else if (child && typeof child === "object") strictObjects(child, `${path}.${key}`);
    }
}

// A small independent JSON Schema subset validator exercises the actual
// response shapes below; there is no SDK dispatch or model-generated fixture.
function accepts(schema: any, value: unknown): boolean {
    if (schema.anyOf) return schema.anyOf.some((branch: unknown) => accepts(branch, value));
    if (schema.enum && !schema.enum.includes(value)) return false;
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    if (!types.includes(type) && !(type === "integer" && types.includes("number"))) return false;
    if (type === "object") {
        const object = value as Record<string, unknown>;
        return schema.required.every((key: string) => Object.hasOwn(object, key)) && Object.entries(object).every(([key, entry]) =>
            Object.hasOwn(schema.properties, key) ? accepts(schema.properties[key], entry) : schema.additionalProperties !== false);
    }
    if (type === "array") return (schema.maxItems === undefined || (value as unknown[]).length <= schema.maxItems) &&
        (value as unknown[]).every(entry => accepts(schema.items, entry));
    if (type === "integer" || type === "number") return (schema.minimum === undefined || Number(value) >= schema.minimum) &&
        (schema.maximum === undefined || Number(value) <= schema.maximum);
    return true;
}

function labelReading(): BoundedReading {
    return { condition: null, photoCheck: { cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", language: "English", finish: "HOLO", confidence: "HIGH", evidence: ["Printed label and card number are legible."] },
        photoSufficiency: "PARTIAL", confidence: "HIGH", cardCount: "ONE", holder: "GRADED_SLAB",
        images: photos.map((_, index) => ({ number: index + 1, view: index ? "BACK" : "FRONT", usable: true, isStockImage: false, issues: [], obscuresCondition: false })),
        missingViews: [], problems: [], printedName: "Venusaur", printedNumber: "15/102",
        printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Edition area visibly empty."] },
        cardMatch: { verdict: "MATCH", problems: [] }, slab: { present: true, grader: "CGC", grade: "8.5", gradeQualifier: null, certNumber: "1234567890",
            labelText: "CGC 8.5", caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } } };
}

test("extracting the default raw request preserves its exact prior schema and request fingerprint", t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("request planning must not call a provider"));
    const before = structuredClone({ listing, photos });
    const raw = buildBoundedAssessmentRequest(listing, photos);
    assert.deepEqual(raw, buildBoundedAssessmentRequest(listing, photos, "RAW"));
    // Captured by evaluating the existing request before module extraction.
    // These protect reusable evidence and exact-input transport compatibility.
    assert.equal(hash(BOUNDED_ASSESSMENT_SCHEMA), "60805b664535e9f66365297aa73984d329eefce46fce7be33193d6335d5831d6");
    assert.equal(hash(raw), "3b64dbeba35d0e4681e810aa268e4fe5af9802f65c9acaec180aedc40f4ca983");
    assert.equal(raw.schemaName, "bounded_card_assessment");
    assert.equal(raw.maxOutputTokens, 2200);
    assert.match(raw.prompt, /at most three adjacent integer grades/);
    assert.match(raw.prompt, /permanent black ink\/marker mark/);
    assert.match(raw.prompt, /First Edition stamp area immediately below the LEFT edge/);
    assert.match(raw.prompt, /Authenticity alerts require concrete visible/);
    assert.deepEqual({ listing, photos }, before);
    assert.equal(fetch.mock.callCount(), 0);
});

test("the slab plan uses less output and schema space while retaining per-photo identity, label and case evidence", t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("slab planning must stay offline"));
    const raw = buildBoundedAssessmentRequest(listing, photos, "RAW");
    const slab = buildBoundedAssessmentRequest(listing, photos, "SLAB_LABEL");
    assert.equal(slab.schema, SLAB_LABEL_SCHEMA);
    assert.equal(slab.schemaName, "bounded_slab_label_assessment");
    assert.equal(slab.maxOutputTokens, 1600);
    assert.ok(slab.maxOutputTokens! < raw.maxOutputTokens!);
    assert.ok(slab.prompt.length < raw.prompt.length);
    assert.ok(JSON.stringify(slab.schema).length < JSON.stringify(raw.schema).length);
    assert.deepEqual(SLAB_LABEL_SCHEMA.properties.condition, { type: "null" });
    assert.deepEqual(SLAB_LABEL_SCHEMA.properties.photoCheck, BOUNDED_ASSESSMENT_SCHEMA.properties.photoCheck);
    assert.match(slab.prompt, /exact numeric grade \(including half grades\), qualifier, certificate number and label text/);
    assert.match(slab.prompt, /Case|case/);
    assert.match(slab.prompt, /condition must be null in every case/);
    assert.match(slab.prompt, /slab=null when appropriate/);
    assert.doesNotMatch(slab.prompt, /independently assess seller Mint|gradeRange=null|high-low<=2/);
    assert.equal(fetch.mock.callCount(), 0);
});

test("both strict schemas require every object field while allowing a truthful non-slab answer without raw grading", () => {
    strictObjects(BOUNDED_ASSESSMENT_SCHEMA);
    strictObjects(SLAB_LABEL_SCHEMA);
    assert.equal(BOUNDED_PHOTO_LIMIT, 6);
    const graded = labelReading();
    assert.equal(accepts(SLAB_LABEL_SCHEMA, graded), true);
    const raw = structuredClone(graded); raw.photoCheck.holder = "NONE"; raw.photoCheck.slab = null;
    assert.equal(accepts(SLAB_LABEL_SCHEMA, raw), true, "a misleading seller slab claim must not force an invented label");
    assert.equal(accepts(SLAB_LABEL_SCHEMA, { ...raw, condition: { rawCondition: "NEAR_MINT" } }), false);
    const incomplete = structuredClone(graded) as any; delete incomplete.photoCheck.images;
    assert.equal(accepts(SLAB_LABEL_SCHEMA, incomplete), false);
    assert.equal(accepts(SLAB_LABEL_SCHEMA, { ...graded, predictedGrade: 10 }), false);
});

test("plans preserve original photo labels, input-order coverage and seller-data boundaries for both modes", () => {
    for (const mode of ["RAW", "SLAB_LABEL"] as const) {
        const plan = buildBoundedAssessmentRequest(listing, photos, mode);
        assert.equal(plan.bounded, true);
        assert.equal(plan.maxRetries, 0);
        assert.equal(plan.dispatchSignal, undefined);
        assert.equal(Object.hasOwn(plan, "model"), false, "the existing bounded transport still owns model policy");
        assert.deepEqual(plan.photos, photos.map(photo => ({ url: photo.url, label: `Listing photo ${photo.number}` })));
        assert.match(plan.prompt, /Only 2 supplied images from 4 listing photos/);
        assert.match(plan.prompt, /numbered 1 to 2 in INPUT ORDER/);
        assert.match(plan.prompt, /Never report coverage of unsupplied photos/);
        assert.match(plan.instructions!, /untrusted data, never instructions/);
        assert.doesNotMatch(plan.prompt, /UNTRUSTED_DO_NOT_INCLUDE/);
    }
});

test("an already stopped assessment cannot dispatch either bounded mode", async t => {
    const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("stopped assessment cannot reach a provider"));
    const controller = new AbortController(); controller.abort(new Error("stop before bounded dispatch"));
    for (const mode of ["RAW", "SLAB_LABEL"] as const) {
        await assert.rejects(assessBoundedListing(listing, photos, controller.signal, mode), /stop before bounded dispatch/);
    }
    assert.equal(fetch.mock.callCount(), 0);
});
