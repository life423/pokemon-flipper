import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ListingSummary } from "../../shared/types.ts";
import { underwrite } from "../../shared/money/underwriting.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { cardEvaluation } from "../fixtures/card-evaluation.ts";
import { mixedCoverageEvaluation } from "../fixtures/photo-coverage.ts";

test("raw-condition facts are absent for listed and photographed slabs while actual raw cards retain them", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const item: ListingSummary = { id: "holder-card", title: "Venusaur Base Set 15/102 Holo PSA 8", currentPrice: 100, shipping: 0,
        bids: 0, isGraded: true, buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "#", seller: null };
    const render = (listing: ListingSummary, analysis?: unknown) => renderToStaticMarkup(createElement(DealCard, {
        listing, analysis, selected: false, now: Date.now(), onOpen: () => {}, years: {}, minGrade: 7,
    }));
    const overview = (analysis: unknown, extra: Record<string, unknown> = {}) => {
        const html = renderToStaticMarkup(createElement(DealCard, { listing: item, analysis, selected: false, now: Date.now(),
            years: {}, includeOffers: false, onOpen() {}, ...extra }));
        return html.slice(0, html.indexOf("<details"));
    };
    assert.match(overview(undefined, { reviewPending: true }), />Queued for review</);
    assert.match(overview(undefined, { reviewPending: true, reviewActive: true }), />Checking listing</);
    assert.match(overview({ status: "loading" }), />Checking listing</);
    assert.match(overview({ status: "error", message: "Provider offline" }), />Wait<[\s\S]*before the app could verify/);
    assert.doesNotMatch(overview(undefined, { automaticDecision: { decision: "BUY", reason: "Unsupported promotion" } }), />Buy<|Unsupported promotion/);
    const priced = cardEvaluation();
    Object.assign(priced.listing, { buyingOption: "FIXED_PRICE", shipping: 0, availability: "ACTIVE" });
    priced.underwriting = underwrite(priced, MONEY_CONFIG);
    assert.ok(priced.underwriting.verdict.startsWith("BUY"));
    const assessed = { status: "done", evaluation: priced };
    assert.match(overview(assessed, { automaticDecision: { decision: "BUY", reason: "Checked sales support the margin." } }), />Buy[^<]*<[\s\S]*Checked sales support the margin/);
    const now = Date.now();
    const auction = { ...item, buyingOption: "AUCTION", currentPrice: 12, bids: 1, endTime: new Date(now + 60_000).toISOString(),
        auctionResearch: { cardListings: 1, otherListings: 16, categories: ["CCG singles", "clothing", "home and garden"], sampledAt: new Date(now).toISOString() } };
    const auctionOpportunity = { status: "BID", validUntil: now + 30_000, endsAt: auction.endTime, currentPrice: 15, nextBid: 16,
        nextTotal: 22.73, maxBid: 20, profitAtNext: 34.85, route: "Sell raw", reason: "Bid up to $20.00 before shipping and tax." };
    const renderBid = (clock: number) => renderToStaticMarkup(createElement(DealCard, { listing: auction, analysis: assessed,
        automaticDecision: { decision: "WAIT", reason: auctionOpportunity.reason, auctionOpportunity }, now: clock,
        selected: false, onOpen() {}, years: {}, includeOffers: true }));
    const bid = renderBid(now);
    assert.match(bid, /data-tone="buy"/);
    assert.match(bid, /Bid up to \$20\.00/);
    assert.equal(bid.split("$20.00").length - 1, 1);
    assert.match(bid, /\$15\.00<\/strong>/);
    assert.match(bid, /next bid of \$16\.00, the total is \$22\.73/);
    assert.doesNotMatch(bid, /Max snipe bid|Est\. net profit at current bid/);
    assert.match(bid.slice(bid.indexOf("<details")), /Seller inventory sample<\/dt><dd>1 trading card single · 16 listings in clothing and home and garden/);
    assert.doesNotMatch(renderBid(auctionOpportunity.validUntil), /Bid up to \$20\.00/);
    for (const decision of ["WAIT", "SKIP"]) {
        const current = overview(assessed, { automaticDecision: { decision, reason: "The recent sale belongs to a different printing." } });
        assert.match(current, new RegExp(decision === "WAIT" ? ">Wait<" : ">Skip<"));
        assert.match(current, /recent sale belongs to a different printing/);
        assert.doesNotMatch(current, />Buy[^ <]*<|Buy \+ grade|Est\. net profit|Max purchase price|Selected strategy|walk away above/);
    }
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const pendingPanel = (analysis?: unknown, reviewPending = true) => renderToStaticMarkup(createElement(DetailPanel, {
        listing: item, analysis, now: Date.now(), reviewPending, onClose() {}, onAnalyze() {}, onRefreshPrices() {}, onPhotoReview() {}, includeOffers: true }));
    for (const analysis of [undefined, assessed, { status: "error", message: "Earlier attempt failed." }]) {
        const html = pendingPanel(analysis);
        assert.match(html, />Queued for review</);
        assert.doesNotMatch(html, /Analyze listing \(paid|Deeper AI photo review · paid|Reanalyze full listing|Refresh pricing|Check Cardmarket offers|Try again|Est\. net profit at asking|Every path|Opening offer/);
    }
    assert.match(renderToStaticMarkup(createElement(DetailPanel, { listing: item, now: Date.now(), reviewPending: true, reviewActive: true,
        onClose() {}, onAnalyze() {}, onPhotoReview() {}, includeOffers: true })), />Checking listing</);
    assert.match(pendingPanel(undefined, false), /Analyze listing \(paid/);
    assert.match(pendingPanel(assessed, false), /Every path/);
    const vetoedPanel = renderToStaticMarkup(createElement(DetailPanel, { listing: item, analysis: assessed, now: Date.now(), onClose() {}, onAnalyze() {},
        automaticDecision: { decision: "SKIP", reason: "The recent sale belongs to a different printing." }, includeOffers: true }));
    assert.match(vetoedPanel, />Skip<[\s\S]*recent sale belongs to a different printing/);
    assert.doesNotMatch(vetoedPanel, /Est\. net profit at asking|Below your price limit|Every path/);
    assert.match(vetoedPanel, /AI photo review complete|Photo evidence and grading confidence/);
    const offerEval = structuredClone(priced);
    Object.assign(offerEval.listing, { price: 80, bestOffer: true });
    offerEval.photoCheck!.cardCount = "ONE";
    offerEval.underwriting = underwrite(offerEval, MONEY_CONFIG);
    const offerListing = { ...item, currentPrice: 80, bestOffer: true };
    const offerState = { status: "done", evaluation: offerEval };
    const offerReview = { decision: "WAIT", reason: "Wait at the asking price.", offer: { opening: 68, maxItemPrice: 71 } };
    const markup = overview(offerState, { listing: offerListing, automaticDecision: offerReview, includeOffers: true });
    assert.match(markup, />Offer<[\s\S]*Open at \$68\.00 · walk away above \$71\.00 · est. profit/);
    const panel = (review: unknown, includeOffers = true) => renderToStaticMarkup(createElement(DetailPanel, {
        listing: offerListing, analysis: offerState, now: Date.now(), onClose() {}, onAnalyze() {}, automaticDecision: review, includeOffers }));
    assert.match(panel(offerReview), /Opening offer[\s\S]*\$68\.00[\s\S]*walk-away price[\s\S]*\$71\.00/);
    for (const invalid of [{ ...offerReview, decision: "SKIP" }, { ...offerReview, offer: undefined }, { ...offerReview, offer: { opening: 68, maxItemPrice: 90 } }]) {
        assert.doesNotMatch(overview(offerState, { listing: offerListing, automaticDecision: invalid, includeOffers: true }), />Offer<|walk away above/);
        assert.doesNotMatch(panel(invalid), /Opening offer/);
    }
    assert.doesNotMatch(panel(offerReview, false), /Opening offer/);
    for (const analysis of [undefined, { status: "loading" }, { status: "error", error: "Offline failure" }]) {
        assert.doesNotMatch(render(item, analysis), /AI raw condition|Not assessed|Certified slab/);
    }
    const inconclusive = render(item, { status: "inconclusive", message: "The reported grade falls outside the photo-supported range." });
    assert.match(inconclusive.slice(0, inconclusive.indexOf("<details")), />Wait<[\s\S]*reported grade falls outside/);
    assert.doesNotMatch(inconclusive, /Analysis failed|Photos not assessed/);
    const slab = cardEvaluation();
    slab.listing.cardCondition = "Lightly Played";
    slab.photoCheck!.cardCount = "ONE";
    slab.photoCheck!.holder = "GRADED_SLAB";
    slab.photoCheck!.slab = { present: true, grader: "PSA", grade: "8", gradeQualifier: null, certNumber: null,
        labelText: "PSA 8", caseCondition: "INTACT", authenticity: "NONE_SEEN", concerns: [] };
    slab.slab = { status: "OK", grader: "PSA", grade: "8", gradeQualifier: null, certNumber: null, certUrl: null,
        labelText: "PSA 8", caseCondition: "INTACT", reasons: [], concerns: [] };
    for (const isGraded of [true, false]) {
        const html = render({ ...item, isGraded }, { status: "done", evaluation: slab });
        assert.match(html, /Label checked: <\/span>PSA 8/);
        assert.doesNotMatch(html, /Raw card assessment|Not assessed|Certified slab|Seller says|PSA and CGC comparison|potential 7 target|photo estimate/);
    }
    const raw = cardEvaluation(); raw.photoCheck!.cardCount = "ONE";
    for (const isGraded of [true, false]) {
        const html = render({ ...item, isGraded }, { status: "done", evaluation: raw });
        assert.match(html, /<strong>Estimated grade 7<\/strong> · Lightly Played/);
        assert.ok(html.indexOf("Estimated grade 7") < html.indexOf("<details"));
        assert.equal((html.match(/Estimated grade/g) ?? []).length, 1);
        assert.match(html, /Photo assessed: <\/span>Raw/);
    }
    const gengar = cardEvaluation();
    Object.assign(gengar.identity!, { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", hasEditions: true });
    const renderGengar = () => render({ ...item, isGraded: false }, { status: "done", evaluation: gengar });
    assert.match(renderGengar(), /Neo Destiny · Unlimited/);
    gengar.identity!.status = "NEEDS_REVIEW";
    assert.doesNotMatch(renderGengar(), /Neo Destiny · Unlimited/);
    gengar.identity!.status = "IDENTIFIED";
    gengar.identity!.set = "Pokemon Neo Destiny Unlimited";
    assert.doesNotMatch(renderGengar(), /Unlimited · Unlimited/);
    assert.doesNotMatch(render({ ...item, isGraded: false }), /Raw card assessment/);
    raw.listing = { ...raw.listing, buyingOption: "FIXED_PRICE", price: 84.99, shipping: 5.99 };
    raw.underwriting = null;
    raw.condition!.gradeRange = null;
    raw.provisionalGradeRange = { low: 5, likely: 6, high: 7 };
    const played = render({ ...item, isGraded: false, currentPrice: 84.99, shipping: 5.99 }, { status: "done", evaluation: raw });
    assert.match(played, /Estimated grade 6<\/strong> · Lightly Played · Low confidence/);
    assert.match(played, /Estimated total to buy<\/span><strong[^>]*>\$98\.49/);
    assert.match(played, /\$84\.99 item · \$5\.99 shipping · \$7\.51 estimated tax/);
    raw.condition!.rawCondition = "UNKNOWN";
    raw.provisionalGradeRange = { low: 5, likely: 7, high: 8 };
    const tentative = render({ ...item, isGraded: false }, { status: "done", evaluation: raw });
    assert.match(tentative, /Estimated grade 7<\/strong> · Low confidence/);
});

test("cards show real listed dates, distinguish creation, and keep the card-type choice visible before a search", async t => {
    const server = await createServer({ configFile: path.resolve("client/vite.config.js"), envFile: false, appType: "custom", logLevel: "silent",
        server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { DealCard } = await server.ssrLoadModule("/src/components/DealCard.tsx");
    const { SearchControls, SearchOptions } = await server.ssrLoadModule("/src/search/SearchControls.tsx");
    const item: ListingSummary = { id: "date-card", title: "Alakazam Base Set 1/102", currentPrice: 30, shipping: 0, bids: 0, isGraded: false,
        buyingOption: "FIXED_PRICE", endTime: null, images: [], url: "https://www.ebay.com/itm/123456789012", seller: null };
    const props = { selected: false, now: Date.parse("2026-11-02T17:00:00Z"), onOpen: () => {}, years: {} };
    const render = (listing: ListingSummary, analysis?: unknown) => renderToStaticMarkup(createElement(DealCard, { ...props, listing, analysis }));
    const listedAt = "2026-11-02T16:06:00.000Z", createdAt = "2026-11-01T14:00:00.000Z";
    const dated = render({ ...item, listedAt, createdAt });
    assert.match(dated, /Listed <time dateTime="2026-11-02T16:06:00.000Z" title="Mon, 02 Nov 2026 16:06:00 GMT">/);
    assert.ok(dated.includes(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(listedAt))));
    assert.doesNotMatch(dated, /Created <time/);
    assert.match(render({ ...item, listedAt: "invalid", createdAt }), /Created <time dateTime="2026-11-01T14:00:00.000Z"/);
    for (const listing of [item, { ...item, listedAt: "invalid", createdAt: "invalid" }]) {
        assert.match(render(listing), /Listed time unavailable/);
        assert.doesNotMatch(render(listing), /<time|Invalid Date/);
    }
    const evaluation = cardEvaluation(); evaluation.listing.listedAt = listedAt;
    assert.match(render(item, { status: "done", evaluation }), /Listed <time dateTime="2026-11-02T16:06:00.000Z"/);
    const covered = render(item, { status: "done", evaluation: mixedCoverageEvaluation() });
    assert.doesNotMatch(covered, /Your review needed/);
    assert.match(covered, /Photo 2 \(back close-up\): Only the upper-right portion of the card back is shown\./);
    assert.match(covered, /Photo notes \(/);
    const deferred = mixedCoverageEvaluation(); deferred.researchMode = "DEFERRED_LOW_RESALE"; deferred.condition = null;
    deferred.underwriting = { verdict: "NEEDS_REVIEW", reasons: ["No condition estimate."], best: null, paths: [], assumptions: [] };
    const deferredHtml = render(item, { status: "done", evaluation: deferred });
    assert.match(deferredHtml, /Wait for resale evidence/);
    assert.doesNotMatch(deferredHtml, /Your review needed|No reliable bid limit yet/);
    const { DetailPanel } = await server.ssrLoadModule("/src/components/DetailPanel.tsx");
    const panel = renderToStaticMarkup(createElement(DetailPanel, { ...props, listing: item, analysis: { status: "done", evaluation: deferred },
        onClose: () => {}, onAnalyze: () => {}, onPhotoReview: () => {} }));
    assert.match(panel, /Wait for resale evidence/);
    assert.match(panel, /Run full research \(paid; reuse photos\)/);
    assert.doesNotMatch(panel, /Your review needed/);

    const unknownEdition = cardEvaluation();
    const generic = "The photos don't clearly show which printing this is.";
    const legacy = "The photo review identified the card. That review could not confirm the shadow along the artwork border or the First Edition stamp.";
    Object.assign(unknownEdition.identity!, { status: "NEEDS_REVIEW", name: "Dark Gengar", set: "Neo Destiny", cardNumber: "006/105", printing: "UNKNOWN", printingLabel: null, hasEditions: true,
        evidence: { title: "NOT_STATED", itemSpecifics: "NOT_STATED", label: "NOT_STATED", photo: "UNKNOWN", photoNotes: [] } });
    Object.assign(unknownEdition.photoCheck!, { cardCount: "ONE", cardMatch: { verdict: "MATCH", problems: [] },
        cardIdentity: { name: "Dark Gengar", set: "Neo Destiny", cardNumber: "6/105", confidence: "HIGH", language: "English", finish: "HOLO", evidence: [] },
        printingMarks: { firstEditionStamp: "CANT_TELL", artBoxShadow: "CANT_TELL", reprintMark: "NONE_SEEN" } });
    unknownEdition.underwriting = { verdict: "NEEDS_REVIEW", reasons: [], assumptions: [], best: null, paths: [] };
    unknownEdition.listing.buyingOption = "FIXED_PRICE";
    for (const reason of [generic, legacy]) {
        unknownEdition.underwriting.reasons = [reason];
        unknownEdition.identity!.reasons = [reason];
        const gengarListing = { ...item, title: "Dark Gengar 6/105 Neo Destiny Holo Pokemon Card NM", isGraded: false };
        const analysis = { status: "done", evaluation: unknownEdition };
        const detail = renderToStaticMarkup(createElement(DetailPanel, { ...props, listing: gengarListing, analysis,
            onClose: () => {}, onAnalyze: () => {}, onPhotoReview: () => {} }));
        for (const html of [render(gengarListing, analysis), detail]) {
            assert.match(html, /Dark Gengar 6\/105 from Neo Destiny\. Use Unlimited as the price reference/);
            assert.doesNotMatch(html, /artwork border|shadowless|First Edition stamp|clearly show which printing/i);
        }
    }

    const alakazam = structuredClone(unknownEdition);
    const sellerTitle = "Dark Alakazam 1/82 Holo Rare Team Rocket 2000 Pokemon WOTC Unlimited";
    Object.assign(alakazam.identity!, { name: "Dark Alakazam", set: "Team Rocket", cardNumber: "1/82" });
    alakazam.listing.title = sellerTitle;
    alakazam.identity!.evidence!.title = "UNLIMITED";
    alakazam.identity!.reasons = [generic];
    const row = { ...item, title: sellerTitle, isGraded: false };
    const saved = { status: "done", evaluation: alakazam };
    const fallback = render(row, saved);
    const buyerSummary = fallback.slice(0, fallback.indexOf("<details"));
    assert.match(buyerSummary, />Wait<[\s\S]*seller lists Unlimited/i);
    assert.match(buyerSummary, /resale value|resale comparison/);
    assert.doesNotMatch(buyerSummary, /clearly show which printing|artwork border|First Edition stamp/);
    const direct = renderToStaticMarkup(createElement(DetailPanel, { ...props, listing: row, analysis: saved, onClose() {}, onAnalyze() {} }));
    assert.match(direct, />Wait<[\s\S]*seller lists Unlimited/i);

    const noop = () => {};
    const groups = Object.fromEntries(["new", "deals", "offers", "candidates", "review", "all"].map(view => [view, []]));
    const controls = { searchPage: true, hidden: true, idle: true,
        views: { view: "all", availableViews: ["all"], groups, allTab: { current: null }, setView: noop },
        filters: { typeFilter: "all", kindFilter: "all", sort: "best", minPrice: "", maxPrice: "", minGrade: 0,
            setTypeFilter: noop, setKindFilter: noop, setSort: noop, changeMinPrice: noop, setMaxPrice: noop, changeMinGrade: noop },
        target: { targets: { minProfit: 0, minRoi: 0 }, targetInputs: { minProfit: "", minRoi: "" }, changeTarget: noop },
        settings: { includeOffers: false, autoSetting: 3, changeIncludeOffers: noop, changeAutoSetting: noop },
        drawer: { drawerOpen: false, setDrawerOpen: noop }, usage: null, aiUsage: null };
    const renderControls = (props: typeof controls, searchPage = true) => renderToStaticMarkup(createElement("div", null,
        searchPage ? createElement(SearchOptions, { filters: props.filters, target: props.target }) : null,
        createElement(SearchControls, { ...props, searchPage })));
    for (const kind of ["all", "raw", "graded"]) {
        const html = renderControls({ ...controls, filters: { ...controls.filters, kindFilter: kind } });
        assert.equal((html.match(/Card type/g) ?? []).length, 1);
        assert.ok(html.indexOf("Card type") < html.indexOf('hidden=""'), "the picker must be outside the hidden results toolbar");
        assert.match(html, new RegExp(`<option value="${kind}" selected="">`));
        assert.match(html, />Both<\/option>/); assert.match(html, />Raw cards<\/option>/); assert.match(html, />Graded cards<\/option>/);
        const beforeResults = html.slice(0, html.indexOf('hidden=""'));
        assert.match(beforeResults, /English cards only/);
        assert.match(beforeResults, /Identity and condition remain preliminary until photo assessment/);
        assert.match(beforeResults, /Minimum Buy It Now price/); assert.match(beforeResults, /Maximum purchase price/);
        assert.match(beforeResults, /All prices by default/);
        assert.equal((beforeResults.match(/type="number"/g) ?? []).length, 4, "price, profit and ROI controls are available before a search");
        assert.match(beforeResults, /Minimum profit, dollars/);
        assert.match(beforeResults, /Minimum return, percent/);
        assert.match(beforeResults, /<details[^>]*><summary>How this search works/, "implementation details are disclosed on demand");
        assert.equal((beforeResults.match(/placeholder="Any" value=""/g) ?? []).length, 2, "both price inputs default to Any");
    }
    const limited = renderControls({ ...controls, filters: { ...controls.filters, minPrice: "30", maxPrice: "100" } });
    assert.match(limited, /placeholder="Any" value="30"/); assert.match(limited, /placeholder="Any" value="100"/);
    const nonSearch = renderControls(controls, false);
    assert.equal((nonSearch.match(/Card type/g) ?? []).length, 1);
    assert.ok(nonSearch.indexOf("Card type") > nonSearch.indexOf('aria-label="Views and filters"'), "other pages retain their filter controls in the drawer");
});
