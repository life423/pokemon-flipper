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
