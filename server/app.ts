import "dotenv/config";
import { setYears } from "./pricing/price-tracker.ts";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.ts";
import { searchWithDiscovery } from "./deals/search.ts";
import { evaluateListing } from "./analysis/evaluate.ts";
import { EbayError } from "./ebay/api.ts";
import { ebayUsage } from "./ebay/usage.ts";
import { writeOfferNote } from "./ai/offer-note.ts";
import { digDeeper } from "./deals/dig.ts";
import type { CurrentState } from "./analysis/evaluate.ts";
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
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json());

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
    res.on("close", () => controller.abort());
    try {
        const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
        const known: unknown = req.body?.knownIds ?? [];
        if (!query || query.length > 300 || !Array.isArray(known) || known.length > 500 || known.some((id) => typeof id !== "string" || id.length > 120)) throw new Error("A search and up to 500 known listing IDs are required.");
        await discoverNewListings(query, { signal: controller.signal, targets: searchTargets(req), includeOffers: req.query.offers === "1", minPrice: Math.max(0, Number(req.query.min) || 0),
            onStart: (summary) => send({ type: "start", ...summary }), onListing: (listing) => send({ type: "listing", listing }) }, known as string[]);
        send({ type: "done" });
    } catch (error) { if (!controller.signal.aborted) send({ type: "error", error: (error as Error).message }); }
    res.end();
});

// A friendly note to send with a Best Offer.
app.post("/api/offer-note", async (req, res) => {
    const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 200) : "";

    if (!title) {
        res.status(400).json({ error: "A listing title is needed" });
        return;
    }

    try {
        res.json({ note: await writeOfferNote(title) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Couldn't write a note" });
    }
});

// How much of today's eBay allowance is left.
app.get("/api/ebay-usage", async (req, res) => {
    res.json(await ebayUsage());
});

// Every listing in a search, screened for free (no AI): what each one
// is worth at its best, and whether it could clear your targets.
// Streamed as one JSON object per line, so the page fills in as listings
// are checked.
app.get("/api/deals", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);

    // A stopped search (the page closed the connection) stops the work too.
    const stopped = new AbortController();
    const seen = new Set<string>();
    res.on("close", () => stopped.abort());

    try {
        await searchWithDiscovery(searchText(req), {
            signal: stopped.signal,
            targets: searchTargets(req),
            includeOffers: req.query.offers === "1",
            maxResults: Number(req.query.max) || undefined,
            minPrice: Number(req.query.min) || 0,
            onStart: (summary) => send({ type: "start", ...summary }),
            onListing: (listing) => { seen.add(listing.id); send({ type: "listing", listing }); },
            onDiscovery: (progress) => send({ type: "discovery", ...progress }),
        });
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen]).catch((error) => console.error("Search history was not saved", error));
        send({ type: "done" });
    } catch (error) {
        await searchHistory.remember(searchText(req), Math.max(0, Number(req.query.min) || 0), [...seen]).catch((failure) => console.error("Partial search history was not saved", failure));
        console.error(error);
        if (!stopped.signal.aborted) send({ type: "error", error: searchFailureMessage(error) });
    }

    res.end();
});

// Dig deeper: the listings a plain search misses (misspelled, vague, the
// wrong category, lots), checked by photo. Streams like a search.
app.get("/api/dig", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);
    const stopped = new AbortController();
    res.on("close", () => stopped.abort());

    try {
        await digDeeper(searchText(req), {
            signal: stopped.signal,
            targets: searchTargets(req),
            includeOffers: req.query.offers === "1",
            minPrice: Number(req.query.min) || 0,
            onStart: (summary) => send({ type: "start", ...summary }),
            onListing: (listing) => send({ type: "listing", listing }),
        });
        send({ type: "done" });
    } catch (error) {
        console.error(error);
        send({ type: "error", error: error instanceof Error ? error.message : "Dig deeper failed" });
    }

    res.end();
});

// Paid unless the listing's saved answer is reused: up to three
// vision requests. ?fresh=1 ignores the saved answer.
app.post("/api/listings/:id/evaluate", async (req, res) => {
    try {
        const current = currentState(req.body);
        const evaluation = await evaluateListing(req.params.id, {
            fresh: req.query.fresh === "1",
            current,
        });
        const evidenceKey = listingEvidenceKey({ title: req.query.fresh === "1" ? evaluation.listing.title : current?.title ?? evaluation.listing.title,
            images: req.query.fresh === "1" ? evaluation.listing.photos ?? [] : current?.images ?? evaluation.listing.photos ?? [] });
        await shortlistService.remember(evaluation, evidenceKey).catch((error) => console.error("Saved evaluation was not updated", error));

        res.json(evaluation);
    } catch (error) {
        console.error(error);

        const notFound = error instanceof EbayError && error.status === 404;

        res.status(notFound ? 404 : error instanceof ProviderError ? 503 : 500).json({
            error: notFound
                ? "Listing not found or no longer available"
                : error instanceof ProviderError ? error.message : "Listing evaluation failed",
        });
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
    console.error(`Couldn't start on port ${PORT}: ${error.message}`);
    process.exit(1);
});

// This is a local app with paid API access, so don't expose it on the LAN.
server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
