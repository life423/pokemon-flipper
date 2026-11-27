import { Router, type ErrorRequestHandler, type Request, type Response } from "express";
import { parseListingLink } from "../../shared/listing-link.ts";
import { withinReminderWindow } from "../../shared/sniper.ts";
import { cents } from "../../shared/money.ts";
import { DEFAULT_SNIPER_LEAD_SECONDS, type SniperCapabilities, type SniperMode, type SniperQuote } from "../../shared/sniper.ts";
import { EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { ProviderError } from "../lib/http.ts";
import { trackSharedWork } from "../lib/shared-work.ts";
import { SniperError, type createSniperScheduler } from "./scheduler.ts";

function auctionId(input: unknown, mode: SniperMode) {
    if (typeof input !== "string" || input.length > 8192) throw new SniperError("Paste an eBay auction link.", 400);
    // Require an explicit sandbox URL for test bids. Never move an item between marketplaces.
    const value = input.trim();
    const isId = /^(?:\d{9,15}|v1\|\d{9,15}\|0)$/.test(value);
    let source: URL | undefined;
    if (!isId) {
        try { source = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); }
        catch { throw new SniperError("Paste a valid eBay auction link.", 400); }
    }
    const sandboxUrl = !!source && ["sandbox.ebay.com", "www.sandbox.ebay.com"].includes(source.hostname);
    if (sandboxUrl !== (mode === "sandbox")) throw new SniperError("Use an auction link from the selected eBay marketplace.", 400);
    if (source && !sandboxUrl && !["ebay.com", "www.ebay.com", "m.ebay.com"].includes(source.hostname)) throw new SniperError("Use a US eBay listing link.", 400);
    const link = parseListingLink(source?.href ?? value);
    if (!link || !link.itemId.endsWith("|0")) throw new SniperError("Paste a single eBay auction item link.", 400);
    return link.itemId;
}

export function sniperRoutes(
    scheduler: Pick<ReturnType<typeof createSniperScheduler>, "list" | "arm" | "cancel" | "reconcileBuyerJobs">,
    capabilities: () => Promise<SniperCapabilities> | SniperCapabilities,
    readQuote: (id: string, mode: SniperMode, signal?: AbortSignal, searchId?: string) => Promise<SniperQuote>,
    signal: () => AbortSignal,
) {
    const router = Router();
    router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
    router.get("/", async (req, res) => {
        const jobs = await scheduler.list();
        if (req.query.mode === "reminder") {
            res.json({ jobs: jobs.filter(job => job.mode === "reminder") });
            return;
        }
        res.json({ jobs, capabilities: await capabilities() });
    });
    async function previewOrArm(req: Request, res: Response) {
        const { url, maxBid, title, endTime, shipping, searchId, buyerConnectionId } = req.body ?? {};
        const mode: unknown = req.body?.mode;
        if (mode !== "reminder" && mode !== "sandbox") throw new SniperError("Choose an auction reminder or a sandbox test bid.", 400);
        if (mode === "sandbox" && !(await capabilities()).sandbox) throw new SniperError("eBay Sandbox bidding credentials are required.", 409);
        if (searchId !== undefined && (typeof searchId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(searchId))) throw new SniperError("Invalid search ID.", 400);
        const id = auctionId(url, mode);
        const arm = req.path === "/";
        const leadSeconds = req.body.leadSeconds ?? DEFAULT_SNIPER_LEAD_SECONDS[mode];
        if (arm && (typeof maxBid !== "number" || maxBid <= 0 || cents(maxBid) / 100 !== maxBid ||
            !Number.isInteger(leadSeconds) || leadSeconds < 3 || leadSeconds > 600 ||
            typeof title !== "string" || !title.trim() || typeof endTime !== "string" || !Number.isFinite(Date.parse(endTime)) ||
            (shipping !== null && !(Number.isFinite(shipping) && shipping >= 0)))) {
            throw new SniperError("Preview the auction and enter a positive maximum bid in dollars and cents.", 400);
        }
        const requestSignal = signal();
        let quote: SniperQuote;
        try { quote = await readQuote(id, mode, requestSignal, searchId); }
        catch (error) {
            if (mode === "sandbox") await scheduler.reconcileBuyerJobs();
            throw error;
        }
        requestSignal.throwIfAborted();
        if (quote.itemId !== id || !withinReminderWindow({ buyingOption: "AUCTION", endTime: quote.endTime })) {
            throw new SniperError("Choose an active auction ending within the next 12 hours.", 409);
        }
        if (!arm) { res.json({ quote }); return; }
        if (mode === "sandbox" && (!quote.buyerConnectionId || buyerConnectionId !== quote.buyerConnectionId)) {
            throw new SniperError("The sandbox buyer connection changed. Preview the auction again.", 409);
        }
        if (quote.title !== title || Date.parse(quote.endTime) !== Date.parse(endTime) || quote.shipping !== shipping) {
            throw new SniperError("The auction title, end time or shipping changed. Preview it again before scheduling.", 409);
        }
        const job = await scheduler.arm({ mode, quote, maxBid, leadSeconds, searchId });
        res.status(201).json({ job });
    }
    router.post(["/", "/preview"], (req, res) => trackSharedWork(previewOrArm(req, res)));
    router.delete("/:id", async (req, res) => { res.json({ job: await trackSharedWork(scheduler.cancel(req.params.id)) }); });
    const onError: ErrorRequestHandler = (err, _req, res, next) => {
        if (res.headersSent) { next(err); return; }
        if (err instanceof SniperError && err.status < 500) { res.status(err.status).json({ error: err.message, code: "AUCTION_INPUT" }); return; }
        if (err instanceof EbayBudgetError) { res.status(err.reason === "QUOTA" ? 429 : 503).json({ error: "Auction details are temporarily unavailable. Try again later." }); return; }
        if (err instanceof EbayError || err instanceof ProviderError) { res.status(502).json({ error: "eBay could not confirm the auction details." }); return; }
        res.status(503).json({ error: "Auction sniper is unavailable. Check the queue before trying again." });
    };
    router.use(onError);
    return router;
}
