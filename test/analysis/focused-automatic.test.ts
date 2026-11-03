import "../fixtures/mock-ai-spending.ts";
import "../fixtures/isolated-data.ts";
import { test } from "../fixtures/search-context.ts";
import assert from "node:assert/strict";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { evaluateListing } from "../../server/analysis/evaluate.ts";
import { loadSaved } from "../../server/analysis/store.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { resultGroup } from "../../shared/analysis.ts";
import { photoReviewStatus } from "../../shared/photo-review.ts";

test("focused automatic cheap first-edition research avoids historical fanout and manual upgrade reuses paid assessments", async t => {
    offlineEbayCredentials(t);
    for (const key of ["OPENAI_API_KEY", "PKMNPRICES_API_KEY"]) {
        const previous = process.env[key]; process.env[key] = "offline-focused";
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const previousTracker = process.env.POKEMON_PRICE_TRACKER_API_KEY;
    delete process.env.POKEMON_PRICE_TRACKER_API_KEY;
    t.after(() => { if (previousTracker !== undefined) process.env.POKEMON_PRICE_TRACKER_API_KEY = previousTracker; });
    // Advance the mocked provider clock so its intentional one-second pacing
    // does not delay offline responses. This does not affect real providers.
    let clock = Date.now(); t.mock.method(Date, "now", () => clock += 1001);
    const id = "v1|focused-cheap-first-edition|0";
    const title = "Bulbasaur Base Set 1st Edition 44/102 Non-Holo";
    const images = ["front", "back", "front-detail", "back-detail"].map(view => `https://i.ebayimg.com/images/g/offline-${view}/s-l1600.jpg`);
    const current = { title, images, price: 2, shipping: 0, bids: 0, endTime: null };
    const card = { id: 998811, name: "Bulbasaur", number: "44", total_set_number: "102", set: { id: 42, name: "Base Set" },
        prices: [
            { currency: "USD", variant: "1st Edition Normal", condition: "Near Mint", market_price: 50 },
            { currency: "USD", variant: "1st Edition Normal", condition: "Lightly Played", market_price: 5 },
            { currency: "USD", variant: "1st Edition Normal", condition: "Damaged", market_price: 1 },
            { currency: "USD", variant: "Unlimited Normal", condition: "Near Mint", market_price: 20 },
            { currency: "USD", variant: "Unlimited Normal", condition: "Lightly Played", market_price: 3 },
        ] };
    const photoCheck = { ...cardEvaluation().photoCheck!, cardCount: "ONE", printedName: "Bulbasaur", printedNumber: "44/102",
        cardIdentity: { name: "Bulbasaur", set: "Base Set", cardNumber: "44/102", finish: "NON_HOLO", language: "English", confidence: "HIGH", evidence: ["Name, number and edition stamp are legible."] },
        printingMarks: { firstEditionStamp: "VISIBLE", artBoxShadow: "ABSENT", reprintMark: "NONE_SEEN", evidence: ["The 1st Edition stamp is visible."] } };
    const condition = cardEvaluation().condition!;
    const schemas: string[] = [], historical: string[] = [], unexpected: string[] = [];
    let photoStarted!: () => void, releasePhoto!: () => void;
    const started = new Promise<void>(resolve => { photoStarted = resolve; });
    const released = new Promise<void>(resolve => { releasePhoto = resolve; });
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.hostname === "api.ebay.com") {
            assert.match(url.pathname, /buy\/browse\/v1\/item\//);
            const ordinary = url.pathname.includes("ordinary"), disproved = url.pathname.includes("disproved");
            const itemId = ordinary ? "v1|ordinary-low-value|0" : disproved ? "v1|disproved-first-edition|0" : id;
            const itemTitle = ordinary ? title.replace("1st Edition", "Unlimited") : title;
            const views = ordinary || disproved ? images.map(image => image.replace("offline-", ordinary ? "ordinary-" : "disproved-")) : images;
            return Response.json({ itemId, title: itemTitle, itemWebUrl: "https://www.ebay.com/itm/123456789012", buyingOptions: ["FIXED_PRICE"],
                price: { value: "2", currency: "USD" }, shippingOptions: [{ shippingCost: { value: "0", currency: "USD" } }],
                image: { imageUrl: views[0] }, additionalImages: views.slice(1).map(imageUrl => ({ imageUrl })), condition: "Ungraded",
                localizedAspects: Object.entries({ Set: "Base Set", "Card Name": "Bulbasaur", "Card Number": "44/102", Language: "English" }).map(([name, value]) => ({ name, value })) });
        }
        if (url.hostname === "api.pkmnprices.com") {
            if (url.pathname === "/v1/sets") return Response.json({ data: [card.set] });
            if (url.pathname === "/v1/cards") return Response.json({ data: [card] });
            if (url.pathname === `/v1/cards/${card.id}`) return Response.json(card);
            historical.push(String(url));
            if (url.pathname.endsWith("/sales/volume")) return Response.json({ data: [], pagination: { total_pages: 0 } });
            assert.ok(url.pathname.endsWith("/listings/ebay"));
            if (url.searchParams.get("graded") === "false") return Response.json({ data: [], pagination: { has_more: false } });
            const grader = url.searchParams.get("grader")!, grade = url.searchParams.get("grade")!;
            return Response.json({ data: [190, 200, 210].map((price, index) => ({ id: `${grader}-${grade}-${index}`, title: `${title} ${grader} ${grade}`,
                price, currency: "USD", grader, grade, variant: "1st Edition Normal", attribution: "exact", sale_type: "fixed_price", sold_at: new Date().toISOString() })), pagination: { has_more: false } });
        }
        if (url.hostname !== "api.openai.com") { unexpected.push(String(url)); throw new Error("Unexpected offline provider"); }
        const body = JSON.parse(String(init?.body));
        const schema = body.text.format.name;
        schemas.push(schema);
        let result;
        if (schema === "photo_check") {
            photoStarted(); await released;
            result = /ordinary-|disproved-/.test(JSON.stringify(body.input)) ? { ...photoCheck,
                printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["The stamp area is empty and an artwork shadow is present."] } } : photoCheck;
        }
        else if (schema === "card_condition") result = condition;
        else {
            assert.equal(schema, "comp_check", "only manual graded checks may add paid tasks");
            result = { sales: [1, 2, 3].map(line => ({ line, keep: true, reason: null, note: "Exact offline fixture" })) };
        }
        const text = JSON.stringify(result);
        return Response.json({ id: "offline-focused", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
            usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
    });

    const first = evaluateListing(id, { automatic: true, current });
    await started;
    const duplicate = evaluateListing(id, { automatic: true, current });
    releasePhoto();
    const [focused, same] = await Promise.all([first, duplicate]);
    assert.equal(focused, same, "duplicate automatic requests share one focused evaluation");
    assert.equal(focused.researchMode, "FOCUSED_LOW_RESALE");
    assert.equal(focused.identity?.printing, "FIRST_EDITION");
    assert.deepEqual(schemas.sort(), ["card_condition", "card_condition", "photo_check"]);
    assert.deepEqual(historical, [], "focused research must not start either grader, sold-copy photos, secondary feeds or volume");
    assert.equal(focused.rawPricing?.prices?.find(price => price.condition === "LIGHTLY_PLAYED")?.price, 5);
    assert.ok(focused.rawPricing?.prices?.every(price => price.basis === "TCGPLAYER"));
    assert.match(focused.rawPricing?.evidenceNote ?? "", /market feed/);
    assert.equal(focused.gradedPricing?.PSA?.status, "PRICE_UNAVAILABLE");
    assert.equal(focused.gradedPricing?.CGC?.status, "PRICE_UNAVAILABLE");
    assert.equal(focused.underwriting?.verdict, "PASS", "a cheap item is not automatically profitable after fees");
    assert.equal(retargetEvaluation(focused, { minProfit: 0, minRoi: 0 }).underwriting?.verdict, "PASS");
    assert.equal((await loadSaved(id))?.latestEvaluation?.evaluation.researchMode, "FOCUSED_LOW_RESALE");

    const again = await evaluateListing(id, { automatic: true, current });
    assert.equal(again.researchMode, "FOCUSED_LOW_RESALE");
    assert.deepEqual(historical, []);
    assert.equal(schemas.length, 3, "automatic retries reuse both paid current-listing stages");

    const [full, concurrentFocus] = await Promise.all([
        evaluateListing(id, { automatic: false, current }),
        evaluateListing(id, { automatic: true, current }),
    ]);
    assert.equal(full.researchMode, "FULL");
    assert.equal(concurrentFocus.researchMode, "FOCUSED_LOW_RESALE", "manual and automatic requests must not share differently scoped results");
    assert.notEqual(full, concurrentFocus);
    assert.ok(full.reusedSteps.includes("photoCheck"));
    assert.ok(full.reusedSteps.includes("condition"));
    assert.equal(schemas.filter(schema => schema === "photo_check").length, 1);
    assert.equal(schemas.filter(schema => schema === "card_condition").length, 2);
    assert.ok(historical.some(url => url.includes("grader=PSA")));
    assert.ok(historical.some(url => url.includes("grader=CGC")));
    assert.ok(historical.some(url => url.includes("graded=false")));
    assert.ok(historical.some(url => url.includes("sales/volume")));
    assert.equal(full.gradedPricing?.PSA?.status, "PRICED");
    const historicalCount = historical.length;
    const restoredFocus = await evaluateListing(id, { automatic: true, current });
    assert.equal(restoredFocus.researchMode, "FOCUSED_LOW_RESALE");
    assert.equal(historical.length, historicalCount, "a later automatic retry does not resume the full route");

    for (const kind of ["ordinary", "disproved"]) {
        const itemId = kind === "ordinary" ? "v1|ordinary-low-value|0" : "v1|disproved-first-edition|0";
        const snapshot = { ...current, title: kind === "ordinary" ? title.replace("1st Edition", "Unlimited") : title,
            images: images.map(image => image.replace("offline-", `${kind}-`)) };
        const deferred = await evaluateListing(itemId, { automatic: true, current: snapshot });
        assert.equal(deferred.researchMode, "DEFERRED_LOW_RESALE");
        assert.equal(deferred.identity?.printing, "UNLIMITED");
        assert.equal(deferred.condition, null, "ordinary low-value cards do not trigger new condition opinions");
        assert.equal(deferred.gradeStatus, "DEFERRED_LOW_RESALE");
        assert.equal(photoReviewStatus(deferred).needsYourReview, false);
        assert.equal(resultGroup({ id: itemId } as never, deferred), null, "intentional deferrals are neither deals nor manual reviews");
        assert.equal(resultGroup({ id: itemId } as never, retargetEvaluation(deferred, { minProfit: 0, minRoi: 0 })), null);
        assert.equal(schemas.filter(schema => schema === "card_condition").length, 2);
        assert.equal(historical.length, historicalCount);
        const repeat = await evaluateListing(itemId, { automatic: true, current: snapshot });
        assert.equal(repeat.researchMode, "DEFERRED_LOW_RESALE");
        assert.equal(schemas.filter(schema => schema === "photo_check").length, kind === "ordinary" ? 2 : 3);
    }
    assert.deepEqual(unexpected, []);
});
