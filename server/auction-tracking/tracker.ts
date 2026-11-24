import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TrackedAuction, AuctionTrackingResults, AuctionTrackingStatus } from "../../shared/auction-tracking.ts";
import { nextAuctionBid, type AuctionOpportunity } from "../../shared/auction-opportunity.ts";
import { listingEvidenceKey } from "../../shared/listing-evidence.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { cents } from "../../shared/money/cents.ts";
import type { Evaluation } from "../../shared/types.ts";
import { jsonStore } from "../lib/json-store.ts";
import { withFileLease } from "../lib/file-lease.ts";
import { DATA_DIR } from "../lib/paths.ts";
import { trackSharedWork } from "../lib/shared-work.ts";
import type { ListingDetails } from "../ebay/listings.ts";
import type { Comp } from "../pricing/types.ts";

const minute = 60_000, hour = 60 * minute;
const closingChecks = [5 * minute, 6.25 * hour, 25 * hour, 73 * hour];
const statuses: AuctionTrackingStatus[] = ["OPEN", "OVER_LIMIT", "RECHECK", "AWAITING_SALE", "WITHIN_LIMIT", "ABOVE_LIMIT", "UNCONFIRMED"];
type SoldMarket = { recordId: string | number; variant: string; grader: string | null; grade: number | string | null };
type Entry = { auction: TrackedAuction; searchId: string; subject: string; market: SoldMarket | null; due: number | null; claim?: string };
type File = { version: 1; entries: Entry[] };
interface Services {
    file?: string;
    now?: () => number;
    details: (id: string, account: string, signal: AbortSignal) => Promise<ListingDetails | null>;
    sales: (market: SoldMarket, account: string, id: string, end: string, signal: AbortSignal) => Promise<Comp[]>;
}

function validFile(value: unknown): value is File {
    const file = value as File | null;
    if (file?.version !== 1 || !Array.isArray(file.entries)) return false;
    const ids = new Set<string>();
    return file.entries.every(entry => {
        const a = entry?.auction, market = entry?.market;
        if (!a || ids.has(a.listingId)) return false;
        ids.add(a.listingId);
        const link = parseListingLink(a.listingId);
        const resolved = a.status === "WITHIN_LIMIT" || a.status === "ABOVE_LIMIT";
        return link?.itemId === a.listingId && link.url === a.url && typeof entry.searchId === "string" &&
            /^[a-zA-Z0-9_-]{1,80}$/.test(entry.searchId) && typeof entry.subject === "string" && typeof a.title === "string" &&
            [a.alertedAt, a.endsAt, a.checkedAt].every(t => Number.isFinite(Date.parse(t))) &&
            [a.originalMaxBid, a.marketValue, a.initialBid].every(v => Number.isFinite(v) && v > 0) &&
            Number.isFinite(a.originalShipping) && a.originalShipping >= 0 && statuses.includes(a.status) &&
            (entry.due === null || Number.isFinite(entry.due)) &&
            (market === null || !!market && /^[a-zA-Z0-9_-]+$/.test(String(market.recordId)) && typeof market.variant === "string" &&
                !!market.variant && (market.grader === null && market.grade === null || typeof market.grader === "string" && market.grade != null)) &&
            (!resolved || entry.due === null && Number.isFinite(a.closingPrice) && a.closingPrice! > 0 &&
                (a.closingPrice! <= a.originalMaxBid) === (a.status === "WITHIN_LIMIT") && Number.isFinite(Date.parse(a.soldAt ?? "")));
    });
}

function nextCheck(end: number, now: number): number | null {
    return [-hour, -15 * minute, -2 * minute, ...closingChecks].map(offset => end + offset).find(time => time > now) ?? null;
}

function subject(title: string, images: string[], condition: string | null, notes: string[], aspects: Record<string, string>) {
    return JSON.stringify([listingEvidenceKey({ title, images }), condition, [...notes].sort(), Object.entries(aspects).sort(([a], [b]) => a.localeCompare(b))]);
}

function soldMarket(e: Evaluation): SoldMarket | null {
    const recordId = e.identity?.recordId;
    const market = e.slab ? e.slabPricing : e.rawPricing;
    if (!recordId || market?.source !== "pkmnprices" || !market.variant || e.slab && (!e.slab.grader || !e.slab.grade)) return null;
    return { recordId, variant: market.variant, grader: e.slab?.grader ?? null, grade: e.slab?.grade ?? null };
}

// Only the recorded auction transaction establishes its closing price. eBay
// unavailable responses, listing removal and a last-seen bid cannot do that.
export function matchingClose(sales: Comp[], auction: Pick<TrackedAuction, "listingId" | "endsAt">, now: number) {
    const end = Date.parse(auction.endsAt);
    const candidates = sales.filter(sale => {
        if (sale.sale_type !== "auction" || sale.currency !== "USD" || parseListingLink(sale.listing_url)?.itemId !== auction.listingId ||
            !Number.isFinite(sale.price) || sale.price <= 0 || cents(sale.price) / 100 !== sale.price) return false;
        const sold = Date.parse(sale.sold_at);
        // Providers may give only a calendar date, including in marketplace time.
        if (/^\d{4}-\d{2}-\d{2}$/.test(sale.sold_at)) {
            const days = ["UTC", "America/Los_Angeles"].map(timeZone => new Intl.DateTimeFormat("en-CA", { timeZone,
                year: "numeric", month: "2-digit", day: "2-digit" }).format(end));
            return days.includes(sale.sold_at);
        }
        return Number.isFinite(sold) && sold <= now && Math.abs(sold - end) <= 30 * minute;
    });
    if (new Set(candidates.map(s => s.price)).size !== 1) return null;
    return candidates[0];
}

export function createAuctionTracker(deps: Services) {
    const now = deps.now ?? Date.now, file = deps.file ?? join(DATA_DIR, "auction-outcomes.json");
    const store = jsonStore<File>(file, () => ({ version: 1, entries: [] }), validFile);
    const change = <T>(edit: (saved: File) => T) => withFileLease(file, () => store.change(edit), {
        timeoutError: () => new Error("Auction outcomes could not be saved while another operation was in progress."),
    });
    let timer: NodeJS.Timeout | undefined, running: Promise<void> | null = null;
    const abort = new AbortController();

    async function remember(opp: AuctionOpportunity | undefined | null, e: Evaluation | null, searchId: string) {
        const link = parseListingLink(opp?.listingId), time = now();
        if (!opp || opp.status !== "BID" || !e || !link || link.itemId !== e.listing.id || e.listing.buyingOption !== "AUCTION" ||
            !Number.isFinite(opp.maxBid) || !(opp.maxBid! > 0) || opp.nextBid === null || e.listing.shipping === null ||
            !(opp.validUntil > time) || !(Date.parse(opp.endsAt) > time) || !searchId) return;
        const ceiling = opp.maxBid!;
        await change(saved => {
            // Repeated reviews or changed targets cannot rewrite the bid ceiling the first buyer alert used.
            if (saved.entries.some(entry => entry.auction.listingId === link.itemId)) return;
            const auction: TrackedAuction = { listingId: link.itemId, title: e.listing.title, url: link.url, alertedAt: new Date(time).toISOString(),
                endsAt: opp.endsAt, originalMaxBid: ceiling, marketValue: opp.marketValue, initialBid: opp.currentPrice,
                checkedAt: opp.checkedAt, nextBid: opp.nextBid, shipping: e.listing.shipping, originalShipping: e.listing.shipping!,
                status: "OPEN", note: "The next bid was within the original limit at the last check." };
            saved.entries.push({ auction, searchId, market: soldMarket(e),
                subject: subject(e.listing.title, e.listing.photos ?? [], e.listing.cardCondition, e.listing.conditionNotes, e.listing.aspects),
                due: nextCheck(Date.parse(opp.endsAt), time) });
        });
    }

    async function list(): Promise<AuctionTrackingResults> {
        const time = now();
        const auctions = (await store.read()).entries.map(({ auction }) => {
            if (["OPEN", "OVER_LIMIT", "RECHECK"].includes(auction.status) && Date.parse(auction.endsAt) <= time)
                return { ...auction, status: "AWAITING_SALE" as const, note: "The auction ended. Looking for a reported sale." };
            return auction;
        }).sort((a, b) => Date.parse(b.alertedAt) - Date.parse(a.alertedAt));
        return { auctions, withinLimit: auctions.filter(a => a.status === "WITHIN_LIMIT").length,
            confirmed: auctions.filter(a => a.status === "WITHIN_LIMIT" || a.status === "ABOVE_LIMIT").length,
            awaiting: auctions.filter(a => Date.parse(a.endsAt) <= time && (a.status === "AWAITING_SALE" || a.status === "UNCONFIRMED")).length };
    }

    async function refresh(entry: Entry) {
        const a = { ...entry.auction }, time = now(), end = Date.parse(a.endsAt);
        let due = nextCheck(end, time);
        delete a.recheckAfter;
        try {
            if (time >= end) {
                if (time < end + closingChecks[0]) return { auction: a, due: end + closingChecks[0] };
                const sales = entry.market ? await deps.sales(entry.market, entry.searchId, a.listingId, a.endsAt, abort.signal) : [];
                const sold = matchingClose(sales, a, time);
                if (sold) {
                    a.status = sold.price <= a.originalMaxBid ? "WITHIN_LIMIT" : "ABOVE_LIMIT";
                    a.closingPrice = sold.price; a.soldAt = sold.sold_at; a.saleUrl = a.url; due = null;
                    a.note = "Matched a completed USD auction sale for this eBay item.";
                } else {
                    if (!entry.market) due = null;
                    a.status = due ? "AWAITING_SALE" : "UNCONFIRMED";
                    a.note = "A completed sale for this eBay item has not been reported.";
                }
                a.checkedAt = new Date(time).toISOString();
            } else {
                const current = await deps.details(a.listingId, entry.searchId, abort.signal);
                if (!current || current.id !== a.listingId || current.buyingOption !== "AUCTION" || current.availability === "UNAVAILABLE") {
                    a.nextBid = null; a.status = "RECHECK"; a.note = "The listing is unavailable. Its closing price is unconfirmed.";
                    due = end + closingChecks[0];
                } else if (entry.subject !== subject(current.title, current.images, current.cardCondition, current.conditionNotes, current.aspects)) {
                    a.status = "UNCONFIRMED"; a.note = "The listing evidence changed after the alert. The original comparison was retired.";
                    a.nextBid = null; due = null;
                } else {
                    const ends = Date.parse(current.endTime ?? "");
                    if (Number.isFinite(ends) && ends > time) { a.endsAt = current.endTime!; due = nextCheck(ends, time); }
                    a.nextBid = nextAuctionBid({ price: current.price, bids: current.bids, auctionQuote: current.auctionBids && current.retrievedAt
                        ? { ...current.auctionBids, checkedAt: current.retrievedAt } : undefined }, time);
                    a.shipping = current.shipping;
                    if (current.retrievedAt) {
                        const observation = { checkedAt: current.retrievedAt, currentBid: current.auctionBids?.currentBid ?? null,
                            minimumBid: a.nextBid, shipping: current.shipping };
                        const history = a.bidHistory ?? [];
                        if (!history.some(previous => previous.checkedAt === observation.checkedAt))
                            a.bidHistory = [...history, observation];
                    }
                    if (current.availability !== "ACTIVE" || a.nextBid === null || a.shipping !== a.originalShipping || ends <= time || !Number.isFinite(ends)) {
                        a.status = "RECHECK"; a.note = "Current terms need a new bid calculation.";
                    } else if (current.price === null || current.price >= a.marketValue) {
                        a.status = "RECHECK"; a.note = "The auction price no longer meets the original below-market test.";
                    } else if (a.nextBid > a.originalMaxBid) {
                        a.status = "OVER_LIMIT"; a.note = "The next bid exceeds the original limit.";
                    } else {
                        a.status = "OPEN"; a.note = "The next bid was within the original limit at the last check.";
                    }
                }
                a.checkedAt = current?.retrievedAt ?? new Date(time).toISOString();
            }
        } catch (error) {
            if (abort.signal.aborted) throw error;
            a.checkedAt = new Date(time).toISOString();
            a.status = time < end ? "RECHECK" : due ? "AWAITING_SALE" : "UNCONFIRMED";
            a.note = time < end ? "The latest eBay quote could not be refreshed." : "The closing sale lookup could not be completed.";
        }
        if (time >= end && a.status === "UNCONFIRMED" && entry.market) a.recheckAfter = new Date(time + 6 * hour).toISOString();
        return { auction: a, due };
    }

    async function tick() {
        if (running || abort.signal.aborted) return running;
        running = (async () => {
            const time = now();
            if (!(await store.read()).entries.some(e => e.due !== null && e.due <= time)) return;
            const batch = await change(saved => {
                const due = saved.entries.filter(e => e.due !== null && e.due <= time).sort((a, b) => a.due! - b.due!).slice(0, 3);
                for (const e of due) { e.claim = randomUUID(); e.due = time + 5 * minute; }
                return due;
            });
            for (const entry of batch) {
                abort.signal.throwIfAborted();
                const updated = await refresh(entry);
                await change(saved => {
                    const row = saved.entries.find(e => e.auction.listingId === entry.auction.listingId && e.claim === entry.claim);
                    if (row) { Object.assign(row, updated); delete row.claim; }
                });
            }
        })().finally(() => { running = null; });
        return running;
    }
    async function recheck(listingId: string) {
        const accepted = await change(saved => {
            const row = saved.entries.find(e => e.auction.listingId === listingId);
            if (!row || row.due !== null || row.auction.status !== "UNCONFIRMED" || !row.market ||
                !(Date.parse(row.auction.recheckAfter ?? "") <= now())) return false;
            row.due = now();
            row.auction.status = "AWAITING_SALE";
            row.auction.note = "Checking for a newly reported auction sale.";
            delete row.auction.recheckAfter;
            return true;
        });
        if (accepted) await tick();
        return accepted;
    }
    function start() {
        if (timer) return;
        const run = () => { void trackSharedWork(tick()).catch(() => { if (!abort.signal.aborted) console.error("Auction outcomes could not be refreshed."); }); };
        timer = setInterval(run, 30_000); timer.unref(); run();
    }
    return { remember, list, tick, recheck, start, stop() { clearInterval(timer); abort.abort(); } };
}
