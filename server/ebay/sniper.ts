import { withShippingDestination } from "./shipping-destination.ts";
import { createHash } from "node:crypto";
import type { SniperCapabilities, SniperMode, SniperQuote } from "../../shared/sniper.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { money } from "../../shared/money.ts";
import { withProviderContext } from "../lib/provider-context.ts";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { configuredShippingZip, getApplicationToken } from "./api.ts";
import { buyerConnection } from "./buyer-connection.ts";
import { auctionBidTerms, getListingDetails, quotedShipping } from "./listings.ts";

const SANDBOX = "https://api.sandbox.ebay.com";
const OFFER = "/buy/offer/v1_beta/bidding/";

export class SandboxBidRejected extends ProviderError { readonly definiteRejection = true; }

function manualBuyerId(token: string) {
    return "manual-" + createHash("sha256").update(token).digest("hex");
}

export async function sandboxBuyerId(): Promise<string | null> {
    const hasBrowse = process.env.EBAY_SANDBOX_APP_ACCESS_TOKEN?.trim() ||
        (process.env.EBAY_SANDBOX_CLIENT_ID?.trim() && process.env.EBAY_SANDBOX_CLIENT_SECRET?.trim());
    if (!hasBrowse) return null;
    const linked = await buyerConnection.connectionId("sandbox");
    if (linked || process.env.EBAY_SANDBOX_RUNAME?.trim()) return linked;
    const manual = process.env.EBAY_SANDBOX_USER_ACCESS_TOKEN?.trim();
    return manual ? manualBuyerId(manual) : null;
}

export async function sniperCapabilities(): Promise<SniperCapabilities> {
    try { return { sandbox: Boolean(await sandboxBuyerId()) }; }
    catch { return { sandbox: false }; }
}

async function sandboxUserToken(expected: string | undefined) {
    if (!expected) throw new SandboxBidRejected("The auction preview has no sandbox buyer.");
    if (!expected.startsWith("manual-")) return buyerConnection.accessToken("sandbox", expected);
    const token = process.env.EBAY_SANDBOX_USER_ACCESS_TOKEN?.trim();
    if (!token || manualBuyerId(token) !== expected) throw new SandboxBidRejected("The sandbox buyer connection changed.");
    return token;
}

function singleAuction(itemId: string) {
    const link = parseListingLink(itemId);
    if (!link || link.itemId !== itemId || !itemId.endsWith("|0")) throw new ProviderError("Choose a single eBay auction listing.");
    return link;
}

async function sandboxRequest(path: string, api: "browse" | "offer", init: RequestInit, buyerId?: string) {
    init.signal?.throwIfAborted();
    requireLiveProvider("EBAY");
    let token: string;
    if (api === "browse") token = process.env.EBAY_SANDBOX_APP_ACCESS_TOKEN?.trim() || await getApplicationToken("sandbox");
    else {
        try {
            token = await sandboxUserToken(buyerId);
            if (await sandboxBuyerId() !== buyerId) throw new SandboxBidRejected("The sandbox buyer connection changed.");
        } catch {
            throw new SandboxBidRejected("The sandbox buyer connection could not be confirmed.");
        }
    }
    init.signal?.throwIfAborted();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" };
    if (init.method === "POST") headers["Content-Type"] = "application/json";
    const zip = configuredShippingZip();
    if (api === "browse" && zip) headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=${encodeURIComponent(`country=US,zip=${zip}`)}`;
    const result = await fetchJson(SANDBOX + path, { ...init, headers, redirect: "error", cache: "no-store" }, { service: "eBay Sandbox" });
    if (api === "offer" && buyerId && !buyerId.startsWith("manual-") && result.response.status === 401) {
        await buyerConnection.invalidate("sandbox", buyerId);
    }
    return result;
}

function sandboxError(response: Response) {
    if (response.status === 401 || response.status === 403) return "eBay Sandbox authorization failed. Check the token expiry and API scopes.";
    if (response.status === 429) return "The eBay Sandbox request allowance has been reached.";
    return `eBay Sandbox returned HTTP ${response.status}.`;
}

async function sandboxQuote(itemId: string, url: string, signal?: AbortSignal, expectedBuyerId?: string): Promise<SniperQuote> {
    const buyerId = expectedBuyerId ?? await sandboxBuyerId();
    if (!buyerId) throw new ProviderError("Connect an eBay Sandbox buyer before previewing a test bid.");
    const id = encodeURIComponent(itemId);
    const activity = await sandboxRequest(OFFER + id, "offer", { signal }, buyerId);
    // getBidding is a per-buyer resource. A first bid has no record yet.
    const noActivity = activity.response.status === 404 && activity.body?.errors?.length === 1 && activity.body.errors[0]?.errorId === 120033;
    if (!noActivity && !activity.response.ok) throw new ProviderError(sandboxError(activity.response));
    if (!noActivity && (activity.body?.itemId !== itemId || activity.body.auctionStatus !== "ACTIVE" || typeof activity.body.highBidder !== "boolean")) {
        throw new ProviderError("eBay Sandbox could not confirm the active auction and the buyer's bidding status.");
    }

    const { response, body } = await sandboxRequest(`/buy/browse/v1/item/${id}`, "browse", { signal });
    if (!response.ok) throw new ProviderError(sandboxError(response));
    if (body?.itemId !== itemId || body.listingMarketplaceId !== "EBAY_US" || !Array.isArray(body.buyingOptions) || !body.buyingOptions.includes("AUCTION") ||
        body.itemGroupType || body.estimatedAvailabilities?.some((entry: { estimatedAvailabilityStatus?: string }) => entry.estimatedAvailabilityStatus === "OUT_OF_STOCK") ||
        typeof body.title !== "string" || !body.title.trim() || !(Date.parse(body.itemEndDate) > Date.now())) {
        throw new ProviderError("eBay Sandbox could not confirm an active US auction for this item.");
    }
    return {
        itemId, url, buyerConnectionId: buyerId, title: body.title, endTime: new Date(body.itemEndDate).toISOString(), checkedAt: new Date().toISOString(),
        ...auctionBidTerms(body), shipping: quotedShipping(body), highBidder: !noActivity && activity.body.highBidder,
    };
}

async function readSniperQuoteAtDestination(itemId: string, mode: SniperMode, signal?: AbortSignal, searchId?: string, buyerId?: string): Promise<SniperQuote> {
    const link = singleAuction(itemId);
    if (mode === "sandbox") return sandboxQuote(itemId, link.url.replace("www.ebay.com", "www.sandbox.ebay.com"), signal, buyerId);
    if (mode !== "reminder") throw new ProviderError("Unknown auction mode.");
    const details = await withProviderContext({ searchId: searchId ?? `sniper-${itemId.split("|")[1]}`, listingId: itemId },
        () => getListingDetails(itemId, { maxAgeHours: 0, keepReserve: true, signal }));
    if (details.id !== itemId || details.buyingOption !== "AUCTION" || details.itemGroupType || details.availability === "UNAVAILABLE" ||
        !details.title?.trim() || !details.retrievedAt || !details.endTime || !(Date.parse(details.endTime) > Date.now())) throw new ProviderError("eBay could not confirm this listing as an active auction.");
    return {
        itemId, url: link.url, title: details.title, endTime: new Date(details.endTime).toISOString(), checkedAt: details.retrievedAt,
        currentBid: details.auctionBids?.currentBid ?? null, minimumBid: details.auctionBids?.minimumBid ?? null, shipping: details.shipping,
    };
}

async function submitSandboxBidAtDestination(itemId: string, maxBid: number, signal: AbortSignal | undefined, buyerId: string): Promise<string> {
    singleAuction(itemId);
    if (maxBid <= 0 || money(maxBid) !== maxBid) throw new SandboxBidRejected("Enter a positive USD maximum in dollars and cents.");
    // Single POST. A timeout, missing receipt or ambiguous response must
    // leave the job uncertain: eBay could already have accepted the bid.
    const { response, body } = await sandboxRequest(OFFER + encodeURIComponent(itemId) + "/place_proxy_bid", "offer", {
        method: "POST", signal, body: JSON.stringify({ maxAmount: { currency: "USD", value: maxBid.toFixed(2) } }),
    }, buyerId);
    if ([400, 401, 403, 404, 409, 429].includes(response.status)) throw new SandboxBidRejected(sandboxError(response));
    if (!response.ok || typeof body?.proxyBidId !== "string" || !body.proxyBidId.trim()) throw new ProviderError("The sandbox bid receipt could not be confirmed.");
    return body.proxyBidId;
}

export function readSniperQuote(...args: Parameters<typeof readSniperQuoteAtDestination>): Promise<SniperQuote> {
    return withShippingDestination(() => readSniperQuoteAtDestination(...args));
}

export function submitSandboxBid(...args: Parameters<typeof submitSandboxBidAtDestination>): Promise<string> {
    return withShippingDestination(() => submitSandboxBidAtDestination(...args));
}
