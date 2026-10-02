import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.ts";
import { findDeals } from "./deals/find-deals.ts";
import { evaluateListing } from "./analysis/evaluate.ts";
import { EbayError } from "./ebay/api.ts";
import { ebayUsage, EbayBudgetError } from "./ebay/usage.ts";
import { writeOfferNote } from "./ai/offer-note.ts";
import { digDeeper } from "./deals/dig.ts";
import type { CurrentState } from "./analysis/evaluate.ts";

const app = express();

// The listing's price, bid, and end time as the page last saw them, or
// null when the request doesn't send them.
function currentState(body: unknown): CurrentState | null {
    const value = body as Partial<Record<keyof CurrentState, unknown>> | undefined;
    const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : null);

    if (!value || number(value.price) === null) return null;

    return {
        price: number(value.price),
        shipping: number(value.shipping),
        bids: number(value.bids) ?? 0,
        endTime: typeof value.endTime === "string" ? value.endTime : null,
    };
}

// The search text from ?q=, or empty.
const searchText = (req: express.Request) => (typeof req.query.q === "string" ? req.query.q : "");
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json());

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

    try {
        await findDeals(searchText(req), {
            maxResults: Number(req.query.max) || undefined,
            minPrice: Number(req.query.min) || 0,
            onStart: (summary) => send({ type: "start", ...summary }),
            onListing: (listing) => send({ type: "listing", listing }),
        });
        send({ type: "done" });
    } catch (error) {
        console.error(error);
        send({ type: "error", error: error instanceof EbayBudgetError ? error.message : "Failed to screen listings" });
    }

    res.end();
});

// Dig deeper: the listings a plain search misses (misspelled, vague, the
// wrong category, lots), checked by photo. Streams like a search.
app.get("/api/dig", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message: object) => res.write(`${JSON.stringify(message)}\n`);

    try {
        await digDeeper(searchText(req), {
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
        const evaluation = await evaluateListing(req.params.id, {
            fresh: req.query.fresh === "1",
            current: currentState(req.body),
        });

        res.json(evaluation);
    } catch (error) {
        console.error(error);

        const notFound = error instanceof EbayError && error.status === 404;

        res.status(notFound ? 404 : 500).json({
            error: notFound
                ? "Listing not found or no longer available"
                : "Listing evaluation failed",
        });
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

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
