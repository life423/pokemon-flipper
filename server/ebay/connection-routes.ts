import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { BuyerEnvironment } from "../../shared/ebay-connection.ts";
import { LocalDisconnectError, type buyerConnection } from "./buyer-connection.ts";
import { trackSharedWork } from "../lib/shared-work.ts";

type Connection = Pick<typeof buyerConnection, "status" | "start" | "complete" | "disconnect">;
const callbackPath = "/ebay/connection/callback";
const cookie = "pf_ebay_consent";

function environment(value: unknown): value is BuyerEnvironment {
    return value === "production" || value === "sandbox";
}

function privateResponse(res: Response) {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
}

export function ebayConnectionRoutes(connection: Connection, reconcileSandbox: () => Promise<unknown>) {
    const api = Router();
    const callback = Router();

    async function status(env?: BuyerEnvironment) {
        if (env) {
            const { configured, connected } = await connection.status(env);
            return { configured, connected };
        }
        const [production, sandbox] = await Promise.all([connection.status("production"), connection.status("sandbox")]);
        return { production, sandbox };
    }

    api.use((_req, res, next) => { privateResponse(res); next(); });
    api.get("/", async (req, res) => {
        const env = req.query.environment;
        if (env !== undefined && !environment(env)) { res.status(400).json({ error: "Unknown eBay account environment." }); return; }
        res.json(await status(env));
    });
    api.post("/start", async (req, res) => {
        const env = req.body?.environment;
        if (!environment(env)) { res.status(400).json({ error: "Choose a production or sandbox eBay account." }); return; }
        const settings = await connection.status(env);
        if (!settings.configured) { res.status(409).json({ error: "eBay sign-in is temporarily unavailable." }); return; }
        // A new attempt belongs to the browser that launched it from the protected local API.
        const browserKey = randomBytes(32).toString("hex");
        const authorizationUrl = await connection.start(env, browserKey);
        res.cookie(cookie, browserKey, { path: callbackPath, sameSite: "lax", httpOnly: true, secure: req.secure, maxAge: 10 * 60_000 });
        res.json({ authorizationUrl });
    });
    api.post("/disconnect", async (req, res) => {
        const env = req.body?.environment;
        if (!environment(env) || req.query.environment !== undefined && req.query.environment !== env) {
            res.status(400).json({ error: "Choose the eBay account to disconnect." }); return;
        }
        await trackSharedWork((async () => {
            try { await connection.disconnect(env); }
            finally { if (env === "sandbox") await reconcileSandbox(); }
        })());
        res.json(await status(req.query.environment === undefined ? undefined : env));
    });
    api.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
        if (error instanceof LocalDisconnectError) { res.status(502).json({ error: error.message }); return; }
        res.status(503).json({ error: "Could not read or update the local eBay connection. Check its status and try again." });
    });

    // eBay returns via top-level navigation. Every other account operation uses localApi.
    callback.get(callbackPath, async (req, res) => {
        privateResponse(res);
        const browserKey = /(?:^|;\s*)pf_ebay_consent=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
        const { state, code, error } = req.query;
        let outcome = "failed";
        if (browserKey && typeof state === "string" && state.length <= 256 &&
            ((typeof code === "string" && code.length > 0 && code.length <= 8192 && error === undefined) ||
                (typeof error === "string" && code === undefined))) {
            try {
                await trackSharedWork((async () => {
                    const env = await connection.complete(state, typeof code === "string" ? code : null, browserKey);
                    if (code && env === "sandbox") await reconcileSandbox();
                    outcome = code ? "connected" : error === "access_denied" ? "declined" : "failed";
                    res.clearCookie(cookie, { path: callbackPath, sameSite: "lax", httpOnly: true, secure: req.secure });
                })());
            } catch { /* Only a generic outcome travels back to the UI. */ }
        }
        res.redirect(303, `/?ebay_connection=${outcome}`);
    });
    return { api, callback };
}
