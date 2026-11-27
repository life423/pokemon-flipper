import "dotenv/config";
import http from "node:http";
import path from "node:path";
import express from "express";
import { CLIENT_ROOT } from "./lib/paths.ts";
import { localApi } from "./lib/local-api.ts";
import { drainSharedWork, trackSharedWork } from "./lib/shared-work.ts";
import { assertSqlStorageReady, closeDatabase } from "./storage/index.ts";
import { shippingDestinationRoutes, withShippingDestination } from "./ebay/shipping-destination.ts";
import { readSniperQuote, sandboxBuyerId, sniperCapabilities, submitSandboxBid } from "./ebay/sniper.ts";
import { createSniperScheduler } from "./sniper/scheduler.ts";
import { sniperRoutes } from "./sniper/routes.ts";
import { ebayConnectionRoutes } from "./ebay/connection-routes.ts";
import { buyerConnection } from "./ebay/buyer-connection.ts";
const app = express();
const PORT = Number(process.env.PORT || 3017);
const SECONDARY_PORT = 3018;
const server = http.createServer(app);
const secondaryServer = PORT === 3017 ? http.createServer(app) : null;
const shutdown = new AbortController();
const isProduction = process.env.NODE_ENV === "production";
app.use("/api", localApi);
app.use("/api", (_req, res, next) => {
    if (shutdown.signal.aborted) { res.status(503).json({ error: "The app is shutting down." }); return; }
    next();
});
app.use(express.json());
app.use("/api/shipping-destination", shippingDestinationRoutes());
app.use("/api", async (_req, res, next) => {
    try { await withShippingDestination(next); }
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
app.use("/api/sniper", sniperRoutes(auctionSniper, sniperCapabilities, readSniperQuote, () => shutdown.signal));
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
    console.error("Saved evidence storage could not be initialized.");
    process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
    const address = server.address();
    console.log(`Server listening on http://localhost:${typeof address === "object" && address ? address.port : PORT}`);
    if (secondaryServer && !shutdown.signal.aborted) {
        secondaryServer.on("error", error => {
            console.error(`Secondary app port ${SECONDARY_PORT} unavailable: ${error.message}. The app remains available on port ${PORT}.`);
        });
        secondaryServer.listen(SECONDARY_PORT, "127.0.0.1", () => console.log(`Same app available on http://localhost:${SECONDARY_PORT}`));
    }
    void trackSharedWork(auctionSniper.start()).catch(() => console.error("Auction sniper could not start. Inspect its saved queue."));
});
