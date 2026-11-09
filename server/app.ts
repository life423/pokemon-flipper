import "dotenv/config";
import { setYears } from "./pricing/price-tracker.ts";
import { evaluationFailure } from "./analysis/failure.ts";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.ts";
import { searchDeals } from "./deals/search.ts";
import { evaluateBoundedListing } from "./analysis/bounded-evaluate.ts";
import { EbayError } from "./ebay/api.ts";
import { ebayUsage, EbayBudgetError } from "./ebay/usage.ts";
import type { CurrentState } from "./analysis/types.ts";
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
import { withAiUsageContext } from "./ai/usage-context.ts";
import { readListingFilters } from "./search/listing-filters.ts";
import { assertSqlStorageReady, storageBackend } from "./storage/index.ts";
import { storageFailure } from "./lib/storage-failure.ts";
import { aiSpending } from "./ai/spending.ts";
import { priceResearchSummary, withPriceResearchSignal } from "./pricing/research-budget.ts";
import { dailyProviderUsage } from "./lib/provider-usage.ts";
import type { SearchSummary } from "./deals/find-deals.ts";
import { completeSearchDiagnostic, loadDiagnosticResult, saveDiagnosticDiscovery } from "./analysis/search-diagnostics.ts";
import { isSearchDiagnosticId, SearchDiagnosticInputError } from "./analysis/search-diagnostic-store.ts";

const app = express();

// The listing's price, bid, and end time as the page last saw them, or
// null when the request doesn't send them.
function currentState(body: unknown): CurrentState | null {
    const value = body as Partial<Record<keyof CurrentState, unknown>> | undefined;
    const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : null);

    if (!value || number(value.price) === null) return null;

    return {
        title: typeof value.title === "string" ? value.title.slice(0, 500) : undefined,
        images: Array.isArray(value.images) && value.images.length <= 24 && value.images.every((image) => typeof image === "string" && image.length <= 2048)
            ? value.images as string[] : undefined,
        price: number(value.price),
        shipping: number(value.shipping),
        bids: number(value.bids) ?? 0,
        endTime: typeof value.endTime === "string" ? value.endTime : null,
    };
}

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
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3017);
const isProduction = process.env.NODE_ENV === "production";

const searchId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : undefined;
app.use("/api", localApi);
app.use("/api", (req, _res, next) => withAiUsageContext({ searchId: searchId(req.get("X-Pokemon-Flipper-Search-Id")) }, next));
app.use("/api", (req, res, next) => {
    const stopped = new AbortController();
    const disconnect = () => { if (!res.writableEnded) stopped.abort(); };
    const release = () => { req.off("aborted", disconnect); res.off("close", disconnect); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    res.once("finish", release);
    withPriceResearchSignal(stopped.signal, next);
});
app.use("/api/listings/:id", (req, _res, next) => withAiUsageContext({ listingId: req.params.id }, next));
app.use(express.json());
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
        res.json({ ...usage, budget, pricing, providers });
    }
    catch { res.status(500).json({ error: "Search usage could not be read. Provider operations are unchanged." }); }
});

async function recordDiagnosticDiscovery(req: express.Request, summary: SearchSummary | undefined, retainedIds: Set<string>) {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!summary || !isSearchDiagnosticId(id)) return;
    await saveDiagnosticDiscovery(id, { ...summary, retainedIds: [...retainedIds] }).catch(error => {
        console.error("Completed search diagnostic could not be saved", error);
    });
}

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

app.post("/api/search-diagnostic", async (req, res) => {
    const id = req.get("X-Pokemon-Flipper-Search-Id");
    if (!isSearchDiagnosticId(id)) { res.status(400).json({ error: "A valid completed search ID is required." }); return; }
    try {
        const result = await completeSearchDiagnostic(id, req.body?.rows);
        if (res.destroyed) return;
        if (result) res.json(result);
        else res.status(404).json({ error: "This completed search is no longer available for review." });
    } catch (error) {
        if (!res.destroyed) res.status(error instanceof SearchDiagnosticInputError ? 400 : 503)
            .json({ error: error instanceof SearchDiagnosticInputError ? error.message : "The search diagnostic could not be saved." });
    }
});

app.post("/api/pricing/retry", async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try { res.json(await pricingRetries.retry(req.body?.tickets, searchTargets(req), req.query.offers === "1", controller.signal)); }
    catch (error) { if (!controller.signal.aborted) res.status(error instanceof PricingRetryError ? error.status : 502).json({ error: (error as Error).message }); }
});

// Only extract a validated eBay identifier; never fetch the submitted URL.
// Resolve current terms before the client starts the existing paid analysis.
app.post("/api/listings/resolve", async (req, res) => {
    try { res.json(await resolveListingLink(req.body?.input)); }
    catch (error) {
        const missing = error instanceof EbayError && [404, 410].includes(error.status);
        res.status(error instanceof ListingLinkError ? error.status : missing ? 404 : error instanceof ProviderError || error instanceof EbayBudgetError ? 503 : 502).json({
            error: error instanceof ListingLinkError || error instanceof ProviderError || error instanceof EbayBudgetError ? error.message
                : missing ? "Listing not found or no longer available. No AI analysis was started." : "Could not load this listing from eBay. Please try again.",
            ...(error instanceof EbayBudgetError ? { retryable: false, code: "EBAY_BUDGET" } : {}) });
    }
});

app.get("/api/shortlist", async (_req, res) => {
    try { res.json({ entries: await shortlistStore.list() }); }
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
        res.status(entry ? 200 : 404).json(entry ?? { error: "This saved listing was removed." });
    } catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.delete("/api/shortlist/:id", async (req, res) => {
    try { await shortlistStore.remove(req.params.id); res.json({ removed: req.params.id }); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
});
app.post("/api/shortlist/refresh", async (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > REFRESH_LIMIT || ids.some((id) => typeof id !== "string" || id.length > 120)) {
        res.status(400).json({ error: `Select between 1 and ${REFRESH_LIMIT} saved listings.` }); return;
    }
    try { res.json(await shortlistService.refresh([...new Set(ids)] as string[])); }
    catch (error) { res.status(500).json({ error: (error as Error).message }); }
});

app.post("/api/deals/new", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);
    const controller = new AbortController();
    const retained = new Set<string>();
    let discovery: SearchSummary | undefined;
    res.on("close", () => controller.abort());
    try {
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
        const known: unknown = req.body?.knownIds ?? [];
        if (!query || query.length > 300 || !Array.isArray(known) || known.length > 500 || known.some((id) => typeof id !== "string" || id.length > 120)) throw new Error("A search and up to 500 known listing IDs are required.");
        await discoverNewListings(query, { signal: controller.signal, filters: readListingFilters(req.query), targets: searchTargets(req), includeOffers: req.query.offers === "1", automaticPhotos: req.query.autoPhotos === "1", minPrice: Math.max(0, Number(req.query.min) || 0),
            onStart: (summary) => { discovery = summary; send({ type: "start", ...summary }); },
            onListing: (listing) => { retained.add(listing.id); send({ type: "listing", listing }); } }, known as string[]);
        if (!controller.signal.aborted) await recordDiagnosticDiscovery(req, discovery, retained);
        send({ type: "done" });
    } catch (error) { if (!controller.signal.aborted) send({ type: "error", error: (error as Error).message }); }
    res.end();
});

// How much of today's eBay allowance is left.
app.get("/api/ebay-usage", async (req, res) => {
    res.json(await ebayUsage());
});

// Current search pipeline: newest inventory, optional cheaper BINs, and sold evidence.
// Full photo assessments are requested separately within the same search budget.
app.get("/api/deals", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);

    // A stopped search (the page closed the connection) stops the work too.
    const stopped = new AbortController();
    const seen = new Set<string>();
    let discovery: SearchSummary | undefined;
    res.on("close", () => stopped.abort());

    try {
        await searchDeals(searchText(req), {
            signal: stopped.signal,
            filters: readListingFilters(req.query),
            targets: searchTargets(req),
            includeOffers: req.query.offers === "1",
            automaticPhotos: req.query.autoPhotos === "1",
            minPrice: Number(req.query.min) || 0,
            onStart: (summary) => { discovery = summary; send({ type: "start", ...summary }); },
            onListing: (listing) => { seen.add(listing.id); send({ type: "listing", listing }); },
        });
        if (!stopped.signal.aborted) await recordDiagnosticDiscovery(req, discovery, seen);
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen], readListingFilters(req.query)).catch((error) => console.error("Search history was not saved", error));
        send({ type: "done" });
    } catch (error) {
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen], readListingFilters(req.query)).catch((failure) => console.error("Partial search history was not saved", failure));
        console.error(error);
        if (!stopped.signal.aborted) send({ type: "error", error: searchFailureMessage(error) });
    }

    res.end();
});

// The evaluator bounds visual work and reuses saved evidence.
// Refreshing current terms never discards unchanged paid photo evidence.
app.post("/api/listings/:id/evaluate", async (req, res) => {
    const stopped = new AbortController();
    const disconnect = () => { if (!res.writableEnded) stopped.abort(); };
    req.on("aborted", disconnect);
    res.on("close", disconnect);
    try {
        const current = currentState(req.body);
        const evaluation = await evaluateBoundedListing(req.params.id, {
            automatic: req.query.auto === "1",
            includeOffers: req.query.offers !== "0",
            targets: searchTargets(req),
            current: req.query.refreshTerms === "1" || req.query.fresh === "1" ? null : current,
            signal: stopped.signal,
        });
        stopped.signal.throwIfAborted();
        const evidenceKey = listingEvidenceKey({ title: req.query.fresh === "1" ? evaluation.listing.title : current?.title ?? evaluation.listing.title,
            images: req.query.fresh === "1" ? evaluation.listing.photos ?? [] : current?.images ?? evaluation.listing.photos ?? [] });
        await shortlistService.remember(evaluation, evidenceKey).catch((error) => console.error("Saved evaluation was not updated", error));

        if (!stopped.signal.aborted) res.json(evaluation);
    } catch (error) {
        if (stopped.signal.aborted) return;
        console.error(error);

        const failure = evaluationFailure(error);
        res.status(failure.status).json(failure);
    } finally {
        req.off("aborted", disconnect);
        res.off("close", disconnect);
    }
});

// Optional focused photo review: cached details, one paid request on first use.
app.post("/api/listings/:id/photo-review", async (req, res) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) {
        res.status(400).json({ error: "A current saved photo assessment is required." });
        return;
    }
    try {
        const review = await reviewListingPhotos(req.params.id, key);
        await shortlistService.rememberReview(req.params.id, review).catch((error) => console.error("Saved photo review was not updated", error));
        res.json(review);
    } catch (error) {
        res.status(error instanceof PhotoReviewError ? error.status : error instanceof ProviderError ? 503 : 502)
            .json({ error: error instanceof PhotoReviewError || error instanceof ProviderError ? error.message : "The deeper photo review failed. Your previous assessment is unchanged." });
    }
});

// Each set's release year, for the cards' subtitles. Saved for a month.
app.get("/api/set-years", async (req, res) => {
    try {
        res.json(await setYears());
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
        server: { middlewareMode: true, hmr: { server } },
        appType: "spa",
    });

    app.use(vite.middlewares);
}

// Ctrl+C, or tsx restarting the server after an edit: close every open
// connection (an open browser tab keeps a live-reload one) and exit right
// away, instead of waiting on them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
        server.closeAllConnections();
        process.exit(0);
    });
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
});
