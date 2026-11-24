import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { CameraInputError, createCameraGrader } from "../../server/analysis/camera-grade.ts";
import { getAiUsageContext } from "../../server/ai/usage-context.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

async function photo(background: string, width = 450) {
    const png = await sharp({ create: { width, height: 650, channels: 3, background } }).png().withMetadata().toBuffer();
    return "data:image/png;base64," + png.toString("base64");
}
async function inputs() { return { front: await photo("#664488"), back: await photo("#3333aa") }; }

function reading(views = ["FRONT", "BACK"]) {
    const fixture = cardEvaluation();
    const condition = fixture.condition!;
    condition.authenticity = { concern: "NONE_SEEN", reasons: [], observations: [], limitations: [] };
    return { condition, photoCheck: { ...fixture.photoCheck!, cardCount: "ONE", printedName: "Venusaur",
        cardIdentity: { name: "Venusaur", set: "Base Set", cardNumber: "15/102", finish: "HOLO", confidence: "HIGH", language: "English", evidence: ["Name and number legible."] },
        cardMatch: { verdict: "MATCH", problems: [] }, printingMarks: { artBoxShadow: "PRESENT", firstEditionStamp: "NOT_PRESENT", reprintMark: "NONE_SEEN", evidence: [] },
        images: views.map((view, i) => ({ number: i+1, view, usable: true, isStockImage: false, obscuresCondition: false, issues: [] })),
    } };
}

function harness(report = reading()) {
    const cache = new Map(), requests: string[][] = [];
    const grader = createCameraGrader({ read: async key => cache.get(key) ?? null,
        save: async (key, value) => { cache.set(key, value); },
        review: async photos => {
            assert.match(getAiUsageContext().searchId!, /^[0-9a-f-]{36}$/);
            requests.push(photos.map(p => p.url));
            return report;
        },
    });
    return { grade: grader, requests, cache };
}

test("identical captures share one accounted grading call, strip metadata and replay without photos in storage", async () => {
    const { grade, requests, cache } = harness(), body = await inputs();
    const [first, duplicate] = await Promise.all([grade(body), grade(body)]);
    assert.deepEqual(first, duplicate);
    assert.equal(first.status, "graded"); assert.equal(first.grade, 7);
    assert.equal(first.condition, "LIGHTLY_PLAYED"); assert.equal(first.confidence, "MEDIUM");
    assert.ok(first.observations.some(note => /edge wear/.test(note)));
    assert.deepEqual(await grade(body), first); assert.equal(requests.length, 1);
    assert.equal(requests[0].length, 2);
    for (const url of requests[0]) {
        assert.match(url, /^data:image\/jpeg;base64,/);
        assert.equal((await sharp(Buffer.from(url.split(",")[1], "base64")).metadata()).exif, undefined);
    }
    assert.ok(!JSON.stringify([...cache]).includes("data:image"));
});

test("unusable and unrelated photos request a specific retake; the photographed slab label supplies its grade", async () => {
    const body = await inputs(), duplicateSide = harness(reading(["FRONT", "FRONT"]));
    const result = await duplicateSide.grade(body);
    assert.equal(result.grade, null); assert.match(result.guidance.join(" "), /whole back/);
    const stock = reading(); stock.photoCheck.images.forEach(p => { p.isStockImage = true; });
    assert.equal((await harness(stock).grade(body)).status, "retake");
    const slab = reading(); slab.photoCheck.holder = "GRADED_SLAB";
    slab.photoCheck.slab = { present: true, grade: "8.5", grader: "CGC", certNumber: null, gradeQualifier: null,
        labelText: "Venusaur CGC 8.5", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [], authenticityEvidence: [] };
    const label = await harness(slab).grade(body);
    assert.deepEqual([label.status, label.grade, label.condition], ["slab", 8.5, null]);
    assert.match(label.observations.join(" "), /CGC 8.5/);
    slab.photoCheck.slab.grade = null;
    assert.equal((await harness(slab).grade(body)).status, "retake");
});

test("confirmed damage and limited photo evidence cannot produce a confident near-mint grade", async () => {
    const body = await inputs(), damaged = reading();
    damaged.condition.gradeRange = { low: 8, likely: 9, high: 10 };
    damaged.condition.creases = "PRESENT";
    const result = await harness(damaged).grade(body);
    assert.deepEqual([result.grade, result.condition, result.confidence], [1, "DAMAGED", "LOW"]);
    const sleeve = reading(); sleeve.photoCheck.holder = "SLEEVE";
    const limited = await harness(sleeve).grade(body);
    assert.equal(limited.grade, 6); assert.equal(limited.confidence, "LOW");
    assert.match(limited.guidance.join(" "), /rough estimate/);
});

test("a failed checkpoint saves the accepted answer on retry without dispatching a duplicate review", async () => {
    const cache = new Map(), body = await inputs();
    let calls = 0, broken = true;
    const deps = { read: async key => cache.get(key) ?? null,
        save: async (key, value) => { if (broken && value.reading) throw new Error("disk full"); cache.set(key, value); },
        review: async () => { calls++; return reading(); } };
    const grade = createCameraGrader(deps);
    await assert.rejects(grade(body), /disk full/);
    await assert.rejects(createCameraGrader(deps)(body), /incomplete saved result/);
    broken = false;
    assert.equal((await grade(body)).status, "graded");
    assert.equal((await createCameraGrader(deps)(body)).grade, 7);
    assert.equal(calls, 1);
});

test("rejects duplicate views, mislabeled files, tiny photos and remote URLs before paying", async () => {
    const { grade, requests } = harness(), body = await inputs();
    for (const bad of [body.front, body.front.replace("image/png", "image/jpeg"), await photo("red", 20), "https://example.org/card.jpg", "data:image/jpeg;base64,PHN2Zz4="])
        await assert.rejects(grade({ ...body, back: bad }), CameraInputError);
    assert.equal(requests.length, 0);
});

test("independent graders cannot re-dispatch an in-flight capture or an indeterminate cancelled provider call", async () => {
    const cache = new Map(), body = await inputs();
    const started = Promise.withResolvers<void>(), interrupted = Promise.withResolvers<void>();
    let count = 0;
    const deps = { read: async key => cache.get(key) ?? null, save: async (key, value) => { cache.set(key, value); },
        review: async () => { count++; started.resolve(); await interrupted.promise; throw new Error("Network interrupted after dispatch."); } };
    const controller = new AbortController();
    const grade = createCameraGrader(deps), second = createCameraGrader(deps);
    const pending = grade(body, controller.signal);
    await started.promise;
    await assert.rejects(second(body), /duplicate paid review is blocked/);
    controller.abort();
    interrupted.resolve();
    await assert.rejects(pending);
    await assert.rejects(grade(body), /duplicate paid review is blocked/);
    assert.equal(count, 1);
});
