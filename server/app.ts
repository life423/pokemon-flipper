import "dotenv/config";
import { savedSetYears, setYears } from "./pricing/price-tracker.ts";
import { evaluationFailure } from "./analysis/failure.ts";
import { CameraInputError, gradeCameraCard } from "./analysis/camera-grade.ts";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.ts";
import { searchDeals } from "./deals/search.ts";
import { discoveryContinuations } from "./deals/search-continuation.ts";
import { evaluateBoundedListing, PriceOnlyEvidenceError } from "./analysis/bounded-evaluate.ts";
import { EbayError } from "./ebay/api.ts";
import { shippingDestinationRoutes, configuredShippingZip, withShippingDestination } from "./ebay/shipping-destination.ts";
import { ebayUsage, EbayBudgetError } from "./ebay/usage.ts";
import { recentListingTerms } from "./listings/recent-terms.ts";
import { MONEY_CONFIG } from "../shared/money/config.ts";
import { ProviderError } from "./lib/http.ts";
import { PhotoReviewError, reviewListingPhotos } from "./analysis/deeper-review.ts";
import { shortlistStore, ShortlistError, cleanSavedListing } from "./shortlist/store.ts";
import { shortlistService } from "./shortlist/service.ts";
import { REFRESH_LIMIT } from "../shared/shortlist.ts";
import { listingEvidenceKey } from "../shared/listing-evidence.ts";
import { searchHistory } from "./search/history.ts";
import { discoverNewListings } from "./deals/new-listings.ts";
import { searchFailureMessage } from "./deals/errors.ts";
import { resolveListingLink, ListingLinkError } from "./listings/resolve.ts";
import { pricingRetries, PricingRetryError } from "./deals/pricing-retries.ts";
import { localApi, validSearchRequest } from "./lib/local-api.ts";
import { aiUsageToday } from "./ai/usage.ts";
import { getBudgetContext, withAiUsageContext } from "./ai/usage-context.ts";
import { readListingFilters, readMarketplaceOrder } from "./search/listing-filters.ts";
import { assertSqlStorageReady, closeDatabase, storageBackend } from "./storage/index.ts";
import { storageFailure } from "./lib/storage-failure.ts";
import { aiSpending } from "./ai/spending.ts";
import { getPriceResearchSignal, priceResearchSummary, withPriceResearchSignal } from "./pricing/research-budget.ts";
import { dailyProviderUsage } from "./lib/provider-usage.ts";
import type { SearchSummary } from "./deals/find-deals.ts";
import type { ScreenedOverflowRow, SearchCompetition, SearchSourceCoverage, SourceDispositionRow } from "../shared/search-diagnostic.ts";
import { completeSearchDiagnostic, loadDiagnosticDiscovery, loadDiagnosticResult, saveDiagnosticDiscovery } from "./analysis/search-diagnostics.ts";
import { isSearchDiagnosticId, SearchDiagnosticInputError } from "./analysis/search-diagnostic-store.ts";
import { interpretSearchRequest, SearchPlanInputError } from "./search/search-plan.ts";
import { createSharedWork, drainSharedWork, trackSharedWork } from "./lib/shared-work.ts";
import { marketHistory } from "./pricing/price-history.ts";
import { buyerMarketPrices } from "./pricing/buyer-market-prices.ts";
import { compareCardmarket } from "./pricing/cardmarket.ts";
import { cardmarketComparisonKey } from "../shared/cardmarket.ts";
import { loadPrivateEvaluation } from "./analysis/private-evaluation.ts";
import { collectorGuideState, runCollectorGuide } from "./analysis/collector-guide.ts";
import { latestLiveCollector, LiveCollectorInputError, runLiveCollector } from "./analysis/live-collector.ts";
import { saveCollectorStrategyEvidence } from "./analysis/collector-strategy-evidence.ts";
import { BuyerReviewInputError, reviewBuyerListing } from "./analysis/wait-skip-review.ts";
import { DealHuntInputError, runSearchDealHunt, saveDealHuntInventory } from "./analysis/deal-hunt-service.ts";
import { savedFlipOwner } from "./analysis/flip-run-store.ts";
import { huntProgress } from "./analysis/deal-hunt-progress.ts";
import type { ListingSummary } from "../shared/types.ts";
import { readSniperQuote, sandboxBuyerId, sniperCapabilities, submitSandboxBid } from "./ebay/sniper.ts";
import { auctionTracker } from "./auction-tracking/service.ts";
import { startPokePriceSchedule } from "./pricing/pokeprice-movers.ts";
import { startMoversSchedule } from "./pricing/pricecharting-movers.ts";
import { createSniperScheduler } from "./sniper/scheduler.ts";
import { sniperRoutes } from "./sniper/routes.ts";
import { ebayConnectionRoutes } from "./ebay/connection-routes.ts";
import { buyerConnection } from "./ebay/buyer-connection.ts";

const app = express();

// The search text from ?q=, or empty.
const searchText = (req: express.Request) => (typeof req.query.q === "string" ? req.query.q : "");
function searchTargets(req: express.Request) {
    const read = (value: unknown, fallback: number) => {
        if (typeof value !== "string" || !value.trim()) return fallback;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
    };
    return {
        minProfit: read(req.query.profit, MONEY_CONFIG.targets.minProfit),
        minRoi: read(req.query.roi, MONEY_CONFIG.targets.minRoi),
    };
}
const PORT = Number(process.env.PORT || 3017);
const SECONDARY_PORT = 3018;
const server = http.createServer(app);
// Both loopback listeners serve the same Express instance, DB pool and job scheduler.
// Custom ports (including port 0 for isolated tests) keep a single listener.
const secondaryServer = PORT === 3017 ? http.createServer(app) : null;
const shutdown = new AbortController();
const isProduction = process.env.NODE_ENV === "production";

const tracked = (handler: (req: express.Request<Record<string, string>>, res: express.Response) => Promise<void>): express.RequestHandler<Record<string, string>> =>
    (req, res) => trackSharedWork(handler(req, res));
const requestSignal = () => getPriceResearchSignal() ?? shutdown.signal;
const searchId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
app.use("/api", localApi);
app.use("/api", (_req, res, next) => {
    if (shutdown.signal.aborted) { res.status(503).json({ error: "The app is shutting down." }); return; }
    next();
});
app.use("/api", async (req, res, next) => {
    const id = searchId(req.get("X-Pokemon-Flipper-Search-Id"));
    // Continuation ownership comes from a server-saved token, including for
    // later photo/price checks. A new batch does not mint new allowances.
    const owner = await discoveryContinuations.budgetOwner(id) ?? (id ? await savedFlipOwner(id) : null);
    const header = req.get("X-Pokemon-Flipper-Watch-Budget");
    if (owner && header && header !== owner) {
        res.status(409).json({ error: "This search uses its original spending account." });
        return;
    }
    withAiUsageContext({ searchId: id, watchBudgetId: owner ?? (isSearchDiagnosticId(header) ? header : undefined) }, next);
});
app.use("/api", (req, res, next) => {
    const stopped = new AbortController();
    const disconnect = () => { if (!res.writableEnded) stopped.abort(); };
    const release = () => { req.off("aborted", disconnect); res.off("close", disconnect); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    res.once("finish", release);
    withPriceResearchSignal(AbortSignal.any([stopped.signal, shutdown.signal]), next);
});
app.use("/api/listings/:id", (req, _res, next) => withAiUsageContext({ listingId: req.params.id }, next));
// Only camera uploads need more than Express's default JSON limit.
app.post("/api/camera/grade", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/json")) { res.status(415).json({ error: "Submit front and back photos using Grade a card." }); return; }
    express.json({ limit: "13mb", inflate: false })(req, res, error => {
        if (!error) { next(); return; }
        if (error.type === "entity.too.large") res.status(413).json({ error: "These photos are too large. Choose smaller images and try again." });
        else res.status(400).json({ error: "The photo upload could not be read. Select the photos again." });
    });
}, tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const result = await gradeCameraCard(req.body, signal);
        if (!signal.aborted) res.json(result);
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CameraInputError) { res.status(400).json({ error: error.message }); return; }
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure.status === 500
            ? { error: "The photo grade could not finish. Your photos are still available to try again." }
            : failure);
    }
}));
app.use(express.json());
app.use("/api/shipping-destination", shippingDestinationRoutes());
app.use("/api", (_req, res, next) => {
    try { withShippingDestination(next); }
    catch {
        res.status(503).json({ error: "Your shipping destination could not be read. Save your ZIP code in Settings.",
            code: "STORAGE_UNAVAILABLE", retryable: false, scope: "search" });
    }
});
const auctionSniper = createSniperScheduler({
    sandboxBuyerId,
    readQuote: readSniperQuote,
    submitSandbox: submitSandboxBid,
});
app.get("/api/auction-tracking", tracked(async (_req, res) => {
    try { res.set("Cache-Control", "no-store").json(await auctionTracker.list()); }
    catch { res.status(503).json({ error: "Auction outcomes could not be read." }); }
}));
app.post("/api/auction-tracking/:id/recheck", tracked(async (req, res) => {
    try {
        if (!await auctionTracker.recheck(req.params.id)) { res.status(409).json({ error: "This auction is not due for another closing-price check." }); return; }
        res.set("Cache-Control", "no-store").json(await auctionTracker.list());
    } catch { res.status(503).json({ error: "Auction outcomes could not be refreshed." }); }
}));
app.use("/api/sniper", sniperRoutes(auctionSniper, sniperCapabilities, readSniperQuote, requestSignal));
const ebayConnection = ebayConnectionRoutes(buyerConnection, () => auctionSniper.reconcileBuyerJobs());
app.use("/api/ebay/connection", ebayConnection.api);
app.get("/ebay/connection/callback", (req, res, next) => {
    if (secondaryServer && req.socket.localPort === SECONDARY_PORT) {
        res.status(404).set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).end();
        return;
    }
    next();
});
app.use(ebayConnection.callback);
app.get("/api/storage", async (_req, res) => {
    try {
        const backend = storageBackend();
        await assertSqlStorageReady();
        res.json({ backend, ready: true });
    } catch (error) {
        res.status(503).json({ ready: false, error: storageFailure(error)?.message ?? "Saved evidence storage is unavailable." });
    }
});
app.get("/api/deals", validSearchRequest);
app.post("/api/deals/new", validSearchRequest);
app.get("/api/ai-usage", async (req, res) => {
    try {
        const id = searchId(req.query.searchId);
        const [usage, budget, pricing, providers] = await Promise.all([aiUsageToday(id), aiSpending.summary(id), priceResearchSummary(id), dailyProviderUsage()]);
        const legs = typeof req.query.legs === "string" ? req.query.legs.split(",").slice(0, 2).map(searchId) : undefined;
        const hunts = legs?.flatMap(leg => leg && huntProgress.read(id, leg) || []);
        const hunt = legs ? undefined : huntProgress.read(id, searchId(req.query.huntId) ?? id);
        res.set("Cache-Control", "no-store").json({ ...usage, budget, pricing, providers, ...(hunt && { hunt }), ...(hunts && { hunts }) });
    }
    catch { res.status(500).json({ error: "Search usage could not be read. Provider operations are unchanged." }); }
});

function searchCoverage(summary: SearchSummary | undefined, sourceDispositions: SourceDispositionRow[], overflowRows: ScreenedOverflowRow[]): SearchSourceCoverage {
    return {
        ...(summary?.sourceCoverage && { sourceCoverage: summary.sourceCoverage, sourceDispositions }),
        ...(overflowRows.length && { overflow: { version: 1, stage: "SCREENING", rows: overflowRows } }),
    };
}

async function recordDiagnosticDiscovery(req: express.Request, summary: SearchSummary | undefined, listings: Map<string, ListingSummary>, coverage: SearchSourceCoverage) {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!summary || summary.continuation?.blocked || !isSearchDiagnosticId(id)) return;
    const continued = typeof req.query.continuation === "string" ? await discoveryContinuations.completedRequest(req.query.continuation, id) : undefined;
    await saveDiagnosticDiscovery(id, { ...summary, ...coverage, retainedIds: [...listings.keys()] }, continued !== undefined).catch(error => {
        console.error("Completed search diagnostic could not be saved", error);
    });
    await saveDealHuntInventory(id, summary.intent, continued ? continued.filters ?? {} : readListingFilters(req.query), [...listings.values()]).catch(error => {
        console.error("Deal hunt inventory could not be saved", error instanceof Error ? error.name : "unknown error");
    });
}

app.post("/api/search-plan", tracked(async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid search ID is required." }); return; }
    const signal = requestSignal();
    try {
        const plan = await interpretSearchRequest(req.body, signal);
        if (!signal.aborted) res.set("Cache-Control", "no-store").json(plan);
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SearchPlanInputError) { res.status(error.status).json({ error: error.message }); return; }
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure.status === 500 ? { error: "Your search could not be interpreted. Please try again." } : failure);
    }
}));

app.post("/api/deal-hunt", tracked(async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid completed search is required." }); return; }
    const signal = requestSignal();
    try {
        // An already-open tab may still submit the older standalone request shape.
        const body = req.body;
        const fresh = body?.standalone === true && body.scope === "any_card" && body.goal === "resell" &&
            (body.filters?.typeFilter ?? "FIXED_PRICE") === "FIXED_PRICE";
        const result = await runSearchDealHunt(id, fresh ? { ...body, freshListings: true,
            filters: { ...body.filters, typeFilter: "FIXED_PRICE" } } : body, signal);
        if (result.auctionOpportunity && result.report.goal !== "collect_slab" && result.report.decision === "BID" && !signal.aborted)
            await auctionTracker.remember(result.auctionOpportunity, result.evaluation, getBudgetContext().searchId ?? id);
        if (!signal.aborted) res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DealHuntInputError) { res.status(error.status).json({ error: error.message }); return; }
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure.status === 500 ? { error: "The search could not complete." } : failure);
    }
}));

app.get("/api/collector-strategy/live", tracked(async (req, res) => {
    const id = req.query.searchId;
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid saved search ID is required." }); return; }
    try { res.json({ report: await latestLiveCollector(id) }); }
    catch { res.status(503).json({ error: "The saved live comparison could not be read." }); }
}));
app.post("/api/collector-strategy/live", tracked(async (req, res) => {
    const runId = req.get("X-Pokemon-Flipper-Search-Id");
    const { sourceSearchId, maxTotal } = req.body ?? {};
    if (!isSearchDiagnosticId(runId) || !isSearchDiagnosticId(sourceSearchId) || typeof maxTotal !== "number") {
        res.status(400).json({ error: "Supply a run ID, a saved search ID and an all-in price limit." }); return;
    }
    const signal = requestSignal();
    try {
        const report = await runLiveCollector(runId, sourceSearchId, maxTotal, signal, req.body.reuseRecentListings === true);
        if (!signal.aborted) res.json({ report });
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof LiveCollectorInputError) res.status(400).json({ error: error.message });
        else {
            console.error("Live collector search stopped", error instanceof Error ? error.message : "unknown error");
            res.status(503).json({ error: searchFailureMessage(error) });
        }
    }
}));
app.get("/api/collector-strategy", tracked(async (req, res) => {
    const id = req.query.searchId;
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid saved search ID is required." }); return; }
    try { res.json(await collectorGuideState(id)); }
    catch { res.status(503).json({ error: "The saved collector guide could not be read." }); }
}));
app.post("/api/collector-strategy", tracked(async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid saved search ID is required." }); return; }
    const signal = requestSignal();
    try {
        const report = await runCollectorGuide(id, signal);
        if (signal.aborted) return;
        if (report) res.json({ available: true, report });
        else res.status(404).json({ error: "No exact-slab comparison is available for this search." });
    } catch (error) {
        if (!signal.aborted) res.status(503).json({ error: storageFailure(error)?.message ?? "The collector strategy could not finish its saved checks." });
        console.error("Collector strategy could not complete", error instanceof Error ? error.message : "unknown error");
    }
}));

app.get("/api/search-diagnostic", async (req, res) => {
    const id = req.query.searchId;
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid completed search ID is required." }); return; }
    try {
        const report = await loadDiagnosticResult(id);
        if (report) res.json(report);
        else res.status(404).json({ error: "This search has no saved review yet." });
    } catch {
        res.status(503).json({ error: "The saved search review could not be read." });
    }
});

app.post("/api/search-diagnostic", tracked(async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid completed search ID is required." }); return; }
    try {
        const result = await completeSearchDiagnostic(id, req.body?.rows, shutdown.signal);
        if (res.destroyed) return;
        if (result) res.json(result);
        else res.status(404).json({ error: "This completed search is no longer available for review." });
    } catch (error) {
        if (!res.destroyed) res.status(error instanceof SearchDiagnosticInputError ? 400 : 503)
            .json({ error: error instanceof SearchDiagnosticInputError ? error.message : "The search diagnostic could not be saved." });
    }
}));

app.post("/api/pricing/retry", tracked(async (req, res) => {
    const signal = requestSignal();
    try { res.json(await pricingRetries.retry(req.body?.tickets, searchTargets(req), req.query.offers === "1", signal)); }
    catch (error) { if (!signal.aborted) res.status(error instanceof PricingRetryError ? error.status : 502).json({ error: (error as Error).message }); }
}));

// Only extract a validated eBay identifier; never fetch the submitted URL.
// Resolve current terms before the client starts the existing paid analysis.
app.post("/api/listings/resolve", tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const listing = await resolveListingLink(req.body?.input, signal, req.body?.comparison === true);
        if (!signal.aborted) { recentListingTerms.remember(getBudgetContext().searchId, listing); res.json(listing); }
    }
    catch (error) {
        if (signal.aborted) return;
        if (error instanceof EbayBudgetError) { res.status(503).json(evaluationFailure(error)); return; }
        const missing = error instanceof EbayError && [404, 410].includes(error.status);
        res.status(error instanceof ListingLinkError ? error.status : missing ? 404 : error instanceof ProviderError || error instanceof EbayBudgetError ? 503 : 502).json({
            error: error instanceof ListingLinkError || error instanceof ProviderError || error instanceof EbayBudgetError ? error.message
                : missing ? "Listing not found or no longer available. No AI analysis was started." : "Could not load this listing from eBay. Please try again.",
        });
    }
}));

app.get("/api/shortlist", async (_req, res) => {
    try { res.json({ entries: await shortlistService.list() }); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.post("/api/shortlist", async (req, res) => {
    try { res.json(await shortlistService.save(cleanSavedListing(req.body?.listing))); }
    catch (error) { res.status(error instanceof ShortlistError ? error.status : 500).json({ error: (error as Error).message }); }
});
app.patch("/api/shortlist/:id", async (req, res) => {
    const { notes, ceiling } = req.body ?? {};
    if (typeof notes !== "string" || notes.length > 2000 || !(ceiling === null || typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0)) {
        res.status(400).json({ error: "Notes must be at most 2,000 characters and your ceiling must be a nonnegative amount or blank." }); return;
    }
    try {
        const entry = await shortlistStore.update(req.params.id, (entry) => ({ ...entry, notes, ceiling }));
        res.status(entry ? 200 : 404).json(entry ? await shortlistService.present(entry) : { error: "This saved listing was removed." });
    } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.delete("/api/shortlist/:id", async (req, res) => {
    try { await shortlistStore.remove(req.params.id); res.json({ removed: req.params.id }); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.post("/api/shortlist/refresh", tracked(async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > REFRESH_LIMIT || ids.some((id) => typeof id !== "string" || id.length > 120)) {
        res.status(400).json({ error: `Select between 1 and ${REFRESH_LIMIT} saved listings.` }); return;
    }
    try { res.json(await shortlistService.refresh([...new Set(ids)] as string[])); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
}));

app.post("/api/deals/new", tracked(async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);
    const signal = requestSignal();
    const retained = new Map<string, ListingSummary>();
    const overflowRows: ScreenedOverflowRow[] = [];
    const sourceDispositions: SourceDispositionRow[] = [];
    let discovery: SearchSummary | undefined;
    try {
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
        const known: unknown = req.body?.knownIds ?? [];
        if (!query || query.length > 300 || !Array.isArray(known) || known.length > 500 || known.some((id) => typeof id !== "string" || id.length > 120)) throw new Error("A search and up to 500 known listing IDs are required.");
        await discoverNewListings(query, { signal, filters: readListingFilters(req.query), targets: searchTargets(req), includeOffers: req.query.offers === "1", automaticPhotos: req.query.autoPhotos === "1", minPrice: Math.max(0, Number(req.query.min) || 0),
            onProgress: progress => { if (!signal.aborted) send({ type: "progress", ...progress }); },
            onStart: (summary) => { discovery = summary; send({ type: "start", ...summary }); },
            onScreenedOverflow: row => { overflowRows.push(row); },
            onSourceDisposition: row => { sourceDispositions.push(row); },
            onListing: (listing) => { recentListingTerms.remember(getBudgetContext().searchId, listing); retained.set(listing.id, listing); send({ type: "listing", listing }); } }, known as string[], req.body?.gradingWatch === true);
        const coverage = searchCoverage(discovery, sourceDispositions, overflowRows);
        if (!signal.aborted) await recordDiagnosticDiscovery(req, discovery, retained, coverage);
        if (!signal.aborted) send({ type: "done", ...coverage });
    } catch (error) { if (!signal.aborted) send({ type: "error", error: (error as Error).message }); }
    res.end();
}));

// How much of today's eBay allowance is left.
app.get("/api/ebay-usage", async (req, res) => {
    res.json(await ebayUsage({ cachedOnly: req.query.cachedOnly === "1" }));
});

// Current search pipeline: newest inventory, optional cheaper BINs, and sold evidence.
// Full photo assessments are requested separately within the same search budget.
app.get("/api/deals", tracked(async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);

    // A stopped search (the page closed the connection) stops the work too.
    const signal = requestSignal();
    const seen = new Map<string, ListingSummary>();
    const overflowRows: ScreenedOverflowRow[] = [];
    const sourceDispositions: SourceDispositionRow[] = [];
    let discovery: SearchSummary | undefined;
    let competition: SearchCompetition | undefined;

    try {
        await searchDeals(searchText(req), {
            ...(typeof req.query.continuation === "string" && { continuation: req.query.continuation }),
            signal,
            filters: readListingFilters(req.query),
            marketplaceOrder: readMarketplaceOrder(req.query.order),
            targets: searchTargets(req),
            includeOffers: req.query.offers === "1",
            automaticPhotos: req.query.autoPhotos === "1",
            minPrice: Number(req.query.min) || 0,
            onProgress: progress => { if (!signal.aborted) send({ type: "progress", ...progress }); },
            onStart: (summary) => { discovery = summary; send({ type: "start", ...summary }); },
            onScreenedOverflow: row => { overflowRows.push(row); },
            onSourceDisposition: row => { sourceDispositions.push(row); },
            onCompetition: reference => { competition = reference; },
            onCollectorEvidence: async evidence => {
                const id = req.get("X-Pokemon-Flipper-Search-Id");
                if (isSearchDiagnosticId(id)) await saveCollectorStrategyEvidence(id, evidence);
            },
            onListing: (listing) => { recentListingTerms.remember(getBudgetContext().searchId, listing); seen.set(listing.id, listing); send({ type: "listing", listing }); },
        });
        const coverage = searchCoverage(discovery, sourceDispositions, overflowRows);
        if (!signal.aborted) await recordDiagnosticDiscovery(req, discovery, seen, coverage);
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen.keys()], readListingFilters(req.query)).catch((error) => console.error("Search history was not saved", error));
        if (!signal.aborted) send({ type: "done", ...coverage, ...(competition && { competition }) });
    } catch (error) {
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen.keys()], readListingFilters(req.query)).catch((failure) => console.error("Partial search history was not saved", failure));
        console.error(error);
        if (!signal.aborted) {
            const failure = evaluationFailure(error);
            send({ type: "error", error: searchFailureMessage(error), ...(failure.code && { code: failure.code }),
                retryable: failure.retryable, ...(failure.scope && { scope: failure.scope }) });
        }
    }

    res.end();
}));

async function originalListingSearch(itemId: string, saved: Awaited<ReturnType<typeof loadPrivateEvaluation>>, requested?: string) {
    if (!saved) return undefined;
    if (isSearchDiagnosticId(saved.searchId)) return saved.searchId;
    if (!isSearchDiagnosticId(requested)) return undefined;
    const discovery = await loadDiagnosticDiscovery(requested);
    return discovery?.discovery.retainedIds.includes(itemId) ? requested : undefined;
}

async function evidenceOwner(account: string, saved: NonNullable<Awaited<ReturnType<typeof loadPrivateEvaluation>>>) {
    return saved.budgetOwner ?? await discoveryContinuations.budgetOwner(account) ?? await savedFlipOwner(account) ?? account;
}

app.post("/api/listings/:id/buyer-review", tracked(async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id) || typeof req.body?.allowResearch !== "boolean") {
        res.status(400).json({ error: "A completed search and its research setting are required." });
        return;
    }
    const signal = requestSignal();
    try {
        const result = await reviewBuyerListing(id, req.params.id, searchTargets(req), req.query.offers !== "0", req.body.allowResearch, signal);
        if (req.body.allowResearch && result.auctionOpportunity && !signal.aborted)
            await auctionTracker.remember(result.auctionOpportunity, result.evaluation, getBudgetContext().searchId ?? id);
        if (!signal.aborted) res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof BuyerReviewInputError) { res.status(error.status).json({ error: error.message }); return; }
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure.status === 500 ? { error: "The buyer review could not read or save the listing evidence." } : failure);
    }
}));

// The evaluator bounds visual work and reuses saved evidence.
// Refreshing current terms never discards unchanged paid photo evidence.
app.post("/api/listings/:id/evaluate", tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const priceOnly = req.query.priceOnly === "1";
        const addedPhotosOnly = req.query.addedPhotosOnly === "1";
        let account = searchId(req.get("X-Pokemon-Flipper-Search-Id"));
        let owner = getBudgetContext().searchId;
        if (priceOnly || addedPhotosOnly) {
            const saved = await loadPrivateEvaluation(req.params.id);
            account = await originalListingSearch(req.params.id, saved, account);
            if (!account) {
                res.status(409).json({ error: "The original search account could not be found for this saved assessment.", retryable: false });
                return;
            }
            owner = await evidenceOwner(account, saved!);
        }
        signal.throwIfAborted();
        const options = {
            automatic: req.query.auto === "1",
            typeFilter: readListingFilters(req.query).typeFilter,
            includeOffers: req.query.offers !== "0",
            targets: searchTargets(req),
            current: priceOnly || req.query.refreshTerms === "1" || req.query.fresh === "1" ? null : recentListingTerms.read(owner, req.params.id, configuredShippingZip()),
            priceOnly, addedPhotosOnly,
            signal,
        };
        const evaluation = await withAiUsageContext({ searchId: account, watchBudgetId: owner }, () => evaluateBoundedListing(req.params.id, options));
        signal.throwIfAborted();
        const evidenceKey = listingEvidenceKey({ title: options.current?.title ?? evaluation.listing.title,
            images: options.current?.images ?? evaluation.listing.photos ?? [] });
        const remembered = shortlistService.remember(evaluation, evidenceKey);
        if (addedPhotosOnly) await remembered;
        else await remembered.catch((error) => console.error("Saved evaluation was not updated", error));

        if (!signal.aborted) res.json(evaluation);
    } catch (error) {
        if (signal.aborted) return;
        if (error instanceof PriceOnlyEvidenceError) {
            res.status(409).json({ error: error.message, retryable: false });
            return;
        }
        console.error(error);

        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure);
    }
}));

const shareMarketPrices = createSharedWork();
app.post("/api/listings/:id/market-prices", tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const saved = await loadPrivateEvaluation(req.params.id);
        const account = await originalListingSearch(req.params.id, saved, req.get("X-Pokemon-Flipper-Search-Id"));
        if (!saved || !account || typeof req.body?.market !== "string") {
            res.status(409).json({ error: "Open the current listing assessment to compare sources." }); return;
        }
        const owner = await evidenceOwner(account, saved);
        const market: string = req.body.market;
        const result = await shareMarketPrices(JSON.stringify([owner, account, req.params.id, market]), active =>
            withAiUsageContext({ searchId: account, watchBudgetId: owner, listingId: req.params.id }, () =>
                withPriceResearchSignal(active, () => buyerMarketPrices(saved.evaluation, market, active))), signal);
        if (signal.aborted) return;
        if (!result) { res.status(409).json({ error: "This price comparison has expired or the assessment changed." }); return; }
        res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
        if (signal.aborted) return;
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure);
    }
}));

app.post("/api/listings/:id/price-history", tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const saved = await loadPrivateEvaluation(req.params.id);
        const account = await originalListingSearch(req.params.id, saved, req.get("X-Pokemon-Flipper-Search-Id"));
        if (!saved || !account || req.body?.market !== cardmarketComparisonKey(saved.evaluation)) {
            res.status(409).json({ error: "Open the current photo assessment to check price history." });
            return;
        }
        signal.throwIfAborted();
        const result = await withAiUsageContext({ searchId: account, watchBudgetId: await evidenceOwner(account, saved), listingId: req.params.id }, () => marketHistory(saved.evaluation));
        if (!signal.aborted) res.json(result);
    } catch (error) {
        if (signal.aborted) return;
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure);
    }
}));

app.post("/api/listings/:id/cardmarket", tracked(async (req, res) => {
    const signal = requestSignal();
    try {
        const saved = await loadPrivateEvaluation(req.params.id);
        const account = await originalListingSearch(req.params.id, saved, req.get("X-Pokemon-Flipper-Search-Id"));
        if (!saved || !account) {
            res.status(409).json({ error: "A photo assessment tied to its original search is required for Cardmarket research." });
            return;
        }
        if (req.body?.market !== cardmarketComparisonKey(saved.evaluation)) {
            res.status(409).json({ error: "This card’s assessment changed. Reopen its current analysis to check Cardmarket." });
            return;
        }
        signal.throwIfAborted();
        const comparison = await withAiUsageContext({ searchId: account, watchBudgetId: await evidenceOwner(account, saved), listingId: req.params.id },
            () => compareCardmarket(saved.evaluation));
        if (!signal.aborted) res.json(comparison);
    } catch (error) {
        if (signal.aborted) return;
        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure);
    }
}));

// Optional focused photo review: cached details, one paid request on first use.
app.post("/api/listings/:id/photo-review", tracked(async (req, res) => {
    const signal = requestSignal();
    const key = req.body?.key;
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
        res.status(400).json({ error: "A current saved photo assessment is required." });
        return;
    }
    try {
        const review = await reviewListingPhotos(req.params.id, key, signal);
        await shortlistService.rememberReview(req.params.id, review).catch((error) => console.error("Saved photo review was not updated", error));
        if (!signal.aborted) res.json(review);
    } catch (error) {
        if (signal.aborted) return;
        res.status(error instanceof PhotoReviewError ? error.status : error instanceof ProviderError ? 503 : 502)
            .json({ error: error instanceof PhotoReviewError || error instanceof ProviderError ? error.message : "The deeper photo review failed. Your previous assessment is unchanged." });
    }
}));

// Each set's release year, for the cards' subtitles. Saved for a month.
app.get("/api/set-years", async (req, res) => {
    try {
        res.json(req.query.cachedOnly === "1" ? await savedSetYears() : await setYears());
    } catch (error) {
        console.error(error);
        res.json({});
    }
});

// Anything else under /api is a mistake, not a page.
app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
});

if (isProduction) {
    // The built React client (npm run build).
    const dist = path.join(CLIENT_ROOT, "dist");

    app.use(express.static(dist));
    app.get(/.*/, (req, res) => {
        res.sendFile(path.join(dist, "index.html"));
    });
} else {
    // The React client, served by Vite inside this server, with hot
    // reload on the same port.
    const { createServer } = await import("vite");

    const vite = await createServer({
        configFile: path.join(CLIENT_ROOT, "vite.config.js"),
        // Load the config with Node itself. Vite otherwise bundles it to a
        // temporary file and deletes it, and node --watch restarts the
        // server every time that happens.
        configLoader: "native",
        // Keep the server log on screen.
        clearScreen: false,
        server: { middlewareMode: true, hmr: { server, ...(secondaryServer ? { clientPort: PORT } : {}) } },
        appType: "spa",
    });

    app.use(vite.middlewares);
}

async function stopServer() {
    if (shutdown.signal.aborted) return;
    shutdown.abort();
    auctionSniper.stop();
    auctionTracker.stop();
    server.close();
    if (secondaryServer?.listening) secondaryServer.close();
    const timeoutMs = 120_000;
    const { complete, pending } = await drainSharedWork({ timeoutMs });
    if (!complete) console.error(`Shutdown timed out with ${pending} unfinished operations. Unresolved provider claims were retained.`);
    server.closeAllConnections();
    secondaryServer?.closeAllConnections();
    if (complete) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([closeDatabase(), new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); })]);
        } catch { console.error("Saved evidence storage did not close cleanly."); }
        finally { clearTimeout(timer); }
    }
    process.exit(complete ? 0 : 1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => { void stopServer(); });
}

server.on("error", (error) => {
    console.error(`Couldn't start on port ${PORT}: ${error.message}. Use the existing app instance or choose another PORT; no other process was stopped.`);
    process.exit(1);
});

// This is a local app with paid API access, so don't expose it on the LAN.
try { await assertSqlStorageReady(); }
catch (error) {
    console.error(storageFailure(error)?.message ?? "Saved evidence storage could not be initialized.");
    process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    if (secondaryServer && !shutdown.signal.aborted) {
        secondaryServer.on("error", error => {
            console.error(`Secondary app port ${SECONDARY_PORT} unavailable: ${error.message}. The app remains available on port ${PORT}.`);
        });
        secondaryServer.listen(SECONDARY_PORT, "127.0.0.1", () => console.log(`Same app available on http://localhost:${SECONDARY_PORT}`));
    }
    auctionTracker.start();
    if (process.env.POKEPRICE_MOVERS_DAILY === "true") startPokePriceSchedule(shutdown.signal);
    if (process.env.PRICECHARTING_MOVERS_DAILY === "true") startMoversSchedule(shutdown.signal);
    void trackSharedWork(auctionSniper.start()).catch(() => console.error("Auction sniper could not start. Inspect its saved queue."));
});
