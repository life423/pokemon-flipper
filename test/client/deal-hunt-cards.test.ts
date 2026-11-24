import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { DealHuntResponse } from "../../shared/deal-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("the hunt displays its decision alongside the actual listing and evidence", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    t.after(() => vite.close());
    const { DealHuntResult } = await vite.ssrLoadModule("/src/components/DealHunt.tsx");
    const now = Date.parse("2026-11-24T15:00:00Z");
    const evaluation = cardEvaluation();
    const title = "Venusaur Base Set 15/102 Holo";
    const photo = "https://i.ebayimg.com/example-front.jpg";
    Object.assign(evaluation.listing, { title, url: "https://www.ebay.com/itm/123456789012", photos: [],
        termsCheckedAt: new Date(now).toISOString(), endTime: new Date(now + 60 * 60_000).toISOString() });
    const listing: ListingSummary = { ...evaluation.listing, images: [photo], currentPrice: evaluation.listing.price, isGraded: false };
    const render = (result: DealHuntResponse & { listing?: ListingSummary }) => renderToStaticMarkup(createElement(DealHuntResult, {
        result, now, updatedTerms: new Map(), onEvidence() {}, shortlistButton: () => createElement("button", null, "Shortlist"),
    }));
    const report: DealHuntResponse["report"] = { searchId: "saved-hunt", goal: "resell", decision: "BID",
        reason: "The next bid clears your profit target.", destination: { listingId: listing.id, section: "sales" }, steps: [] };

    await t.test("a selected auction shows the seller image, named decision and price evidence action", () => {
        const markup = render({ report, evaluation, listing, candidates: [listing] });
        assert.equal(markup.match(/<article\b/g)?.length, 1, "the selected auction appears once");
        assert.ok(markup.includes(`aria-label="${title}"`));
        assert.ok(markup.includes(`<h3><span>Bid opportunity · </span>${title}</h3>`));
        const image = markup.match(/<img\b[^>]*>/)?.[0] ?? "";
        assert.ok(image.includes(`src="${photo}"`), "the search thumbnail survives an empty refreshed gallery");
        assert.ok(image.includes(`alt="${title}"`));
        assert.match(markup, /<button[^>]*>View price evidence<\/button>/);
        assert.ok(markup.includes(report.reason));
    });

    await t.test("a fresh grading card withdraws its purchase advice exactly when the quote expires", () => {
        const response = { report: { ...report, goal: "grade_raw" as const, decision: "BUY" as const, reason: "Current grading route clears target.",
            destination: { listingId: listing.id, section: "grading" as const } }, evaluation, listing: { ...listing, buyingOption: "FIXED_PRICE" as const },
            gradingOpportunity: { grader: "PSA" as const, dateSource: "listed" as const, listingDate: new Date(now - 1_000).toISOString(),
                delivered: 50, gradingCosts: 36, validUntil: now + 1, likely: { grade: 8, profit: 65, sales30: 4 }, lower: { grade: 7, profit: 20, sales30: 2 } } };
        assert.match(render(response), /View grading breakdown/);
        response.gradingOpportunity.validUntil = now;
        const markup = render(response);
        assert.match(markup, /Recheck listing/);
        assert.match(markup, /grading quote has expired/);
        assert.doesNotMatch(markup, /View grading breakdown|Current grading route clears target|data-decision="BUY"/);
    });

    const wait: DealHuntResponse = { report: { ...report, decision: "WAIT", destination: null,
        reason: "No eligible auction was found in the requested window." }, evaluation: null };
    await t.test("an empty Wait explains the outcome without making up a listing", () => {
        const markup = render(wait);
        assert.match(markup, /<h3>Wait<\/h3>/);
        assert.ok(markup.includes(wait.report.reason));
        assert.doesNotMatch(markup, /<article\b|<img\b|View price evidence/);
    });
    await t.test("an open candidate in a Wait report gets its own photo card without a bid recommendation", () => {
        const markup = render({ ...wait, candidates: [listing, { ...listing, id: "ended", title: "Ended auction", endTime: new Date(now - 1).toISOString() }] });
        assert.match(markup, /<h3>Listings found<\/h3>/);
        assert.ok(markup.includes(`<h3>${title}</h3>`));
        assert.equal(markup.match(/<article\b/g)?.length, 1);
        assert.ok(markup.includes(`src="${photo}"`));
        assert.doesNotMatch(markup, /Bid opportunity|View price evidence|Ended auction/);
    });
});
