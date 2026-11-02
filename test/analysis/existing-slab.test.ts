import "../fixtures/mock-ai-spending.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { offlineEbayCredentials } from "../fixtures/ebay-credentials.ts";
import { canAutoAnalyze, resultGroup } from "../../shared/analysis.ts";
import { GRADERS } from "../../shared/money/underwriting.ts";

// Real evaluator/SDK/provider adapters, deterministic transport responses. No
// credentials, live requests or writes to the user's data are used by this test.
test("BGS and TAG flow from screening through AI label checking, sold pricing and net resale", async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-slab-test-"));
    for (const [name, value] of Object.entries({ POKEMON_FLIPPER_DATA_DIR: directory, OPENAI_API_KEY: "offline-slab", PKMNPRICES_API_KEY: "offline-slab" })) {
        const old = process.env[name]; process.env[name] = value;
        t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
    }
    offlineEbayCredentials(t);
    const card = { id: 998877, name: "Lugia", number: "009", total_set_number: "111", set: { id: 42, name: "Neo Genesis" },
        prices: [{ currency: "USD", variant: "Unlimited Holofoil", condition: "Near Mint", market_price: 500 }] };
    const targets: { grader: string; grade: string }[] = [];
    const photoRequests: string[] = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.includes("oauth2/token")) return Response.json({ access_token: "offline", expires_in: 3600 });
        if (url.hostname === "api.ebay.com") {
            assert.match(url.pathname, /buy\/browse\/v1\/item\//);
            const grader = url.pathname.includes("TAG") ? "TAG" : "BGS";
            return Response.json({ itemId: `${grader}-offline`, title: `Lugia 9/111 Neo Genesis Unlimited Holo ${grader} 6.5`,
                itemWebUrl: "https://www.ebay.com/itm/123456789012", buyingOptions: ["FIXED_PRICE"], price: { value: "100", currency: "USD" },
                shippingOptions: [{ shippingCost: { value: "5", currency: "USD" } }], image: { imageUrl: `https://i.ebayimg.com/images/g/${grader}/s-l1600.jpg` },
                condition: "Graded", localizedAspects: Object.entries({ Set: "Neo Genesis", "Card Name": "Lugia", "Card Number": "9/111", Language: "English", "Professional Grader": grader, Grade: "6.5" }).map(([name, value]) => ({ name, value })) });
        }
        if (url.hostname === "api.pkmnprices.com") {
            if (url.pathname === "/v1/sets") return Response.json({ data: [card.set] });
            if (url.pathname === "/v1/cards") return Response.json({ data: [card] });
            if (url.pathname === `/v1/cards/${card.id}`) return Response.json(card);
            if (url.pathname.endsWith("/sales/volume")) return Response.json({ data: [], pagination: { total_pages: 0 } });
            assert.ok(url.pathname.endsWith("/listings/ebay"));
            const grader = url.searchParams.get("grader")!; const grade = url.searchParams.get("grade")!;
            targets.push({ grader, grade });
            return Response.json({ data: [950, 1000, 1050].map((price, i) => ({ id: `${grader}-${i}`, title: `Lugia 9/111 Neo Genesis Unlimited Holo ${grader} 6.5`,
                price, currency: "USD", grader, grade, grade_qualifier: "EX MT+", variant: "Unlimited Holofoil", attribution: "exact", sold_at: new Date(Date.now() - (i + 1) * 86400000).toISOString() })), pagination: { has_more: false } });
        }
        assert.equal(url.hostname, "api.openai.com", "no unexpected external request is permitted");
        const request = JSON.parse(String(init?.body));
        const schema = request.text.format.name;
        let result;
        if (schema === "comp_check") result = { sales: [1, 2, 3].map(line => ({ line, keep: true, reason: null, note: "Exact fixture slab" })) };
        else {
            assert.equal(schema, "photo_check");
            const grader = JSON.stringify(request.input).includes("/images/g/TAG/") ? "TAG" : "BGS";
            photoRequests.push(grader);
            result = { confidence: "HIGH", photoSufficiency: "SUFFICIENT", cardCount: "ONE", holder: "GRADED_SLAB",
                images: [{ number: 1, view: "FRONT", usable: true, isStockImage: false, obscuresCondition: false, issues: [] }], missingViews: [], problems: [],
                printedName: "Lugia", printedNumber: "9/111", cardMatch: { verdict: "MATCH", problems: [] },
                cardIdentity: { name: "Lugia", set: "Neo Genesis", cardNumber: "9/111", finish: "HOLO", language: "English", confidence: "HIGH", evidence: ["Readable name, number and label"] },
                printingMarks: { firstEditionStamp: "NOT_PRESENT", artBoxShadow: "PRESENT", reprintMark: "NONE_SEEN", evidence: ["Unlimited label and card"] },
                slab: { present: true, grader, grade: "6.5", gradeQualifier: "EX MT+", certNumber: grader === "TAG" ? "A1234567" : "12345678",
                    labelText: `2000 POKEMON NEO GENESIS LUGIA HOLO #9 ${grader} EX MT+ 6.5`, caseCondition: "INTACT", authenticity: "NONE_SEEN", authenticityEvidence: [], concerns: [] } };
        }
        return Response.json({ id: "resp_offline", object: "response", status: "completed", output: [{ id: "msg_offline", type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(result), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    });
    const { prescreen } = await import("../../server/deals/prescreen.ts");
    const { evaluateListing } = await import("../../server/analysis/evaluate.ts");
    const { lookupCards, fetchComps } = await import("../../server/pricing/pkmnprices.ts");
    for (const grader of ["BGS", "TAG"]) {
        const title = `Lugia 9/111 Neo Genesis Unlimited Holo ${grader} 6.5`;
        const screen = await prescreen({ title, aspects: { Set: "Neo Genesis", "Card Name": "Lugia", "Card Number": "9/111", Language: "English", "Professional Grader": grader, Grade: "6.5" }, price: 100, shipping: 5, isGraded: true, cardCondition: null }, { lookupCards, fetchComps });
        const listing = { id: `${grader}-offline`, title, currentPrice: 100, shipping: 5, images: [`https://i.ebayimg.com/images/g/${grader}/s-l1600.jpg`], screen };
        assert.equal(canAutoAnalyze(listing), true);
        assert.equal(resultGroup(listing, null), "candidates");
        const evaluation = await evaluateListing(listing.id, { remember: false });
        assert.equal(evaluation.slab?.status, "OK", JSON.stringify(evaluation.slab));
        assert.equal(evaluation.slab?.grader, grader);
        assert.equal(evaluation.slab?.grade, "6.5");
        assert.equal(evaluation.slabPricing?.summary?.median, 1000);
        assert.equal(evaluation.slabPricing?.summary?.count, 3);
        assert.equal(evaluation.underwriting?.verdict, "BUY_GRADED");
        assert.equal(evaluation.underwriting?.best?.label, `Resell as ${grader} 6.5`);
        assert.equal(evaluation.condition, null, "certified slabs do not need raw-condition grading");
        assert.equal(evaluation.gradedPricing, null, "no raw submission fees or cross-grader price substitution");
        assert.ok(evaluation.underwriting!.best!.profit < 900, "fees, shipping and tax reduce gross spread");
        assert.equal(resultGroup(listing, evaluation), "deals");
    }
    assert.deepEqual(photoRequests, ["BGS", "TAG"]);
    assert.ok(targets.every(target => ["BGS", "TAG"].includes(target.grader) && target.grade === "6.5"));
    assert.deepEqual(GRADERS, ["PSA", "CGC"], "raw submission services stay unchanged");
    assert.ok(directory.startsWith(path.join(os.tmpdir(), "pokemon-slab-test-")));
    await fs.rm(directory, { recursive: true });
});
