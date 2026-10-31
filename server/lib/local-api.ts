import type { RequestHandler } from "express";

// A website in another tab must not be able to spend the local app's API keys
// through a simple cross-origin GET, form or DNS-rebinding request. The marker
// is not a secret: browsers require a successful preflight to send it cross-origin.
export const localApi: RequestHandler = (req, res, next) => {
    let host: URL;
    try { host = new URL(`http://${req.get("host")}`); }
    catch { res.status(403).json({ error: "Use the local app to make this request." }); return; }
    const origin = req.get("origin");
    const trustedHost = ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname);
    const trustedOrigin = !origin || origin === `${req.protocol}://${host.host}`;
    if (!trustedHost || !trustedOrigin || req.get("sec-fetch-site") === "cross-site" || req.get("x-pokemon-flipper") !== "1") {
        res.status(403).json({ error: "This API is available through the local Pokémon Flipper app. Reload the app and try again." });
        return;
    }
    next();
};

// Validate before opening a paid search stream. Invalid values must not silently
// turn an empty/invalid request into a broad marketplace search.
export const validSearchRequest: RequestHandler = (req, res, next) => {
    const query = req.method === "POST" ? req.body?.query : req.query.q;
    const error = typeof query !== "string" || !query.trim() || query.trim().length > 300
        ? "Enter a search between 1 and 300 characters."
        : ["min", "max", "profit", "roi"].some(field => {
            const value = req.query[field];
            if (value === undefined) return false;
            return typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || field === "max" && Number(value) < 1;
        }) ? "Search limits and financial targets must be finite, nonnegative numbers." : null;
    if (error) { res.status(400).json({ error }); return; }
    next();
};
