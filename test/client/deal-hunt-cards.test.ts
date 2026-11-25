import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { AuctionOpportunity } from "../../shared/auction-opportunity.ts";
import type { DealHuntResponse } from "../../shared/deal-hunt.ts";
import type { ListingSummary } from "../../shared/types.ts";
import { verifiedPurchase } from "../../shared/money/verified-purchase.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { PRICING_VERSION } from "../../shared/pricing-freshness.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";

test("the hunt displays its decision alongside the actual listing and evidence", async t => {
    const vite = await createServer({ configFile: fileURLToPath(new URL("../../client/vite.config.js", import.meta.url)),
        envFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
    t.after(() => vite.close());
    const { DealHunt, DealHuntResult } = await vite.ssrLoadModule("/src/components/DealHunt.tsx");
    const { AuctionOpportunities } = await vite.ssrLoadModule("/src/components/AuctionOpportunities.tsx");
    const now = Date.parse("2026-11-24T15:00:00Z");
    const evaluation = cardEvaluation();
    // This suite tests gallery fallback and quote expiry on an ordinary printing.
    Object.assign(evaluation.identity!, { name: "Alakazam", cardNumber: "1/102" });
    const title = "Alakazam Base Set 1/102 Holo";
    const photo = "https://i.ebayimg.com/example-front.jpg";
    Object.assign(evaluation.listing, { title, url: "https://www.ebay.com/itm/123456789012", photos: [], availability: "ACTIVE",
        termsCheckedAt: new Date(now).toISOString(), endTime: new Date(now + 60 * 60_000).toISOString() });
    const listing: ListingSummary = { ...evaluation.listing, images: [photo], currentPrice: evaluation.listing.price, isGraded: false };
    const render = (result: DealHuntResponse & { listing?: ListingSummary }, currentListing?: ListingSummary, destinationReady = true) => renderToStaticMarkup(createElement(DealHuntResult, {
        result, now, currentListing, destinationReady, updatedTerms: new Map(), onEvidence() {}, shortlistButton: () => createElement("button", null, "Shortlist"),
    }));
    const report: DealHuntResponse["report"] = { searchId: "saved-hunt", goal: "resell", decision: "BID",
        reason: "The next bid clears your profit target.", destination: { listingId: listing.id, section: "sales" }, steps: [] };

    await t.test("the hunt under a search starts on its results and an empty list cannot silently widen it", () => {
        for (const listings of [[listing], []]) {
            const markup = renderToStaticMarkup(createElement(DealHunt, { searchId: "named", listings,
                filters: { typeFilter: "AUCTION" }, targets: MONEY_CONFIG.targets, minPotentialGrade: 0, now,
                updatedTerms: new Map(), latestListings: new Map(), destinationReady: true }));
            assert.match(markup, /<option value="search" selected="">Only these results/);
            assert.match(markup, new RegExp(`aria-disabled="${!listings.length}">Find auction opportunities`));
        }
    });

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

    await t.test("a later auction quote or an unchecked destination removes the saved bid advice", () => {
        const response = { report, evaluation, listing };
        for (const current of [
            { ...listing, termsCheckedAt: new Date(now + 1).toISOString() },
            { ...listing, availability: "UNAVAILABLE" as const },
            { ...listing, shippingDestination: "10001" },
        ]) {
            const markup = render(response, current);
            assert.match(markup, /Waiting for a fresh bid limit/);
            assert.doesNotMatch(markup, /Bid opportunity|View price evidence|data-decision="BID"/);
        }
        assert.match(render(response, listing, false), /Waiting for a fresh bid limit/);
    });

    await t.test("auction cards keep TCGplayer asking prices separate from observed transactions", () => {
        const opportunity: AuctionOpportunity = { listingId: listing.id, endsAt: listing.endTime!, checkedAt: new Date(now).toISOString(),
            validUntil: now + 60_000, status: "BID", currentPrice: 20, marketValue: 63, sales30: 1, sales60: 2, sampleSize: 2,
            marketLabel: "Lightly Played raw", marketBasis: "TCGPLAYER_OFFERS", nextBid: 23, nextTotal: 25, maxBid: 37,
            profitAtNext: 12, route: "Sell raw", routeKind: "RAW", exitSales30: 1, exitSales60: 2, grading: null, reason: report.reason };
        const selected = render({ report, evaluation, listing, auctionOpportunity: opportunity });
        assert.match(selected, /TCGplayer asking-price estimate/);
        assert.doesNotMatch(selected, /sold estimate|from 2 matching sales/);
        const renderPanel = (receipt: AuctionOpportunity) => renderToStaticMarkup(createElement(AuctionOpportunities, { listings: [listing],
            decisions: { [listing.id]: { auctionOpportunity: receipt } }, now, onOpen() {} }));
        const panel = renderPanel(opportunity);
        assert.match(panel, /TCGplayer asking-price estimate/);
        assert.match(panel, /2 matching sales in the past 60 days/);
        assert.match(renderPanel({ ...opportunity, marketBasis: undefined, sales60: undefined }), /1 matching sale in the past 30 days/);
    });

    await t.test("a fresh grading card withdraws its purchase advice exactly when the quote expires", () => {
        const checked = structuredClone(evaluation), checkedAt = new Date(now).toISOString();
        Object.assign(checked.listing, { buyingOption: "FIXED_PRICE", shipping: 0, availability: "ACTIVE", termsCheckedAt: checkedAt, endTime: null });
        Object.assign(checked, { pricesCheckedAt: checkedAt, pricingVersion: PRICING_VERSION, assessmentVersion: "fixture/bounded-prompts-4",
            conditionVersion: "fixture/bounded-condition-1/prompts-1" });
        checked.underwriting = underwrite(checked, MONEY_CONFIG);
        const purchase = verifiedPurchase(checked, checked.underwriting.best!, MONEY_CONFIG.targets);
        const response = { report: { ...report, goal: "grade_raw" as const, decision: "BUY" as const, reason: "Current grading route clears target.",
            destination: { listingId: listing.id, section: "grading" as const }, verifiedPurchase: purchase }, evaluation: checked,
            listing: { ...listing, buyingOption: "FIXED_PRICE" as const },
            gradingOpportunity: { grader: "PSA" as const, dateSource: "listed" as const, listingDate: new Date(now - 1_000).toISOString(),
                delivered: 50, gradingCosts: 36, validUntil: now + 1, likely: { grade: 8, profit: 65, sales30: 4 }, lower: { grade: 7, profit: 20, sales30: 2 } } };
        assert.match(render(response), /View grading breakdown/);
        assert.match(render(response), /Max item price/);
        for (const current of [
            { ...response.listing, availability: "UNAVAILABLE" as const, termsCheckedAt: undefined },
            { ...response.listing, shippingDestination: "10001" },
            { ...response.listing, termsCheckedAt: new Date(now + 1).toISOString() },
        ]) {
            const markup = render(response, current);
            assert.match(markup, /Waiting for a fresh price check/);
            assert.doesNotMatch(markup, /Max item price|View grading breakdown|data-decision="BUY"/);
        }
        response.gradingOpportunity.validUntil = now;
        const markup = render(response);
        assert.match(markup, /Waiting for a fresh price check/);
        assert.match(markup, /grading quote has expired/);
        assert.doesNotMatch(markup, /View grading breakdown|Current grading route clears target|data-decision="BUY"/);
    });

    const wait: DealHuntResponse = { report: { ...report, decision: "WAIT", destination: null,
        reason: "No eligible auction was found in the requested window." }, evaluation: null };
    await t.test("a saved buy cannot display an original-release margin after its photo evidence is disputed", () => {
        const copy = cardEvaluation();
        Object.assign(copy.identity!, { name: "Charizard", cardNumber: "004/102" });
        const oldBuy = { ...report, decision: "BUY" as const, reason: "Old projected profit $214.25.",
            marketNote: "Old Base Set estimate $487.99.", steps: [{ action: "check_sales", title: "Old value", observation: "$487.99" }] as DealHuntResponse["report"]["steps"] };
        const renderCopy = () => render({ report: oldBuy, evaluation: copy, listing: { ...listing, title: "Charizard Base Set", buyingOption: "FIXED_PRICE" } });
        const valid = copy.releaseMark!;
        delete copy.releaseMark;
        assert.match(renderCopy(), /Release unverified/);
        copy.releaseMark = { ...valid, mark: "PIKACHU_25" };
        const corrected = renderCopy();
        assert.match(corrected, /2021 Celebrations/);
        assert.doesNotMatch(corrected, /data-decision="BUY"|214\.25|487\.99|Max item price/);
        copy.listing.photos![0] = "new front";
        assert.doesNotMatch(renderCopy(), /2021 Celebrations|data-decision="BUY"/);
    });
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
