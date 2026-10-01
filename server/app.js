import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.js";
import { getListings } from "./ebay/listings.js";
import { findDeals } from "./deals/find-deals.js";
import { evaluateListing } from "./analysis/evaluate.js";

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json());

app.get("/api/listings", async (req, res) => {
    try {
        const search = req.query.q || "";
        const listings = await getListings(search);

        res.json(listings);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to get listings",
        });
    }
});

// Every listing in a search, screened for free (no AI): what each one
// is worth at its best, and whether it could clear your targets.
// Streamed as one JSON object per line, so the page fills in as listings
// are checked.
app.get("/api/deals", async (req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");

    const send = (message) => res.write(`${JSON.stringify(message)}\n`);

    try {
        await findDeals(req.query.q || "", {
            onStart: (count) => send({ type: "start", count }),
            onListing: (listing) => send({ type: "listing", listing }),
        });
        send({ type: "done" });
    } catch (error) {
        console.error(error);
        send({ type: "error", error: "Failed to screen listings" });
    }

    res.end();
});

// Paid unless the listing's saved answer is reused: up to three
// vision requests. ?fresh=1 ignores the saved answer.
app.post("/api/listings/:id/evaluate", async (req, res) => {
    try {
        const evaluation = await evaluateListing(req.params.id, {
            fresh: req.query.fresh === "1",
        });

        res.json(evaluation);
    } catch (error) {
        console.error(error);

        const notFound = error.status === 404;

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

server.on("error", (error) => {
    console.error(`Couldn't start on port ${PORT}: ${error.message}`);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
