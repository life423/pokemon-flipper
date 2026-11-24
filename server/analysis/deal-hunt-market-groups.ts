import { normalizeCardNumber } from "../../shared/card-number.ts";
import { setKey } from "../../shared/sets.ts";
import { canonicalCatalogName } from "../identity/catalog-name.ts";
import { auctionPhotoPriority } from "../../shared/auction-research.ts";
import type { DealHuntGoal } from "../../shared/deal-hunt.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { marketIntent, marketItemLimit, shortlistMarketCopies } from "./deal-hunt-market-checks.ts";
import { marketBrowseQuery } from "./same-set-listings.ts";
import type { HuntMarket } from "./same-set-markets.ts";

export function huntMarketCardKey(m: HuntMarket) {
    return JSON.stringify([setKey(m.set), canonicalCatalogName(m.name), normalizeCardNumber(m.cardNumber)]);
}

interface MarketGroup {
    intents: SearchIntent[];
    leads: HuntMarket[];
    ceiling: number;
    observedPurchaseTotal?: number;
}

export function groupMarketSearches(leads: HuntMarket[], goal: DealHuntGoal, targets: Targets, filters: ListingFilters,
    minGrade: number, knownIds: ReadonlySet<string> = new Set()) {
    const groups = new Map<string, MarketGroup>();
    for (const lead of leads) {
        const intent = marketIntent(lead);
        if (filters.kindFilter === "raw" && intent.graded || filters.kindFilter === "graded" && !intent.graded ||
            intent.graded && (intent.minGrade ?? 0) < minGrade) continue;
        const ceiling = Math.min(marketItemLimit(lead, goal, targets, 0), filters.maxPrice ?? Infinity);
        if (ceiling <= 0 || filters.typeFilter !== "AUCTION" && ceiling < (filters.minPrice ?? 0)) continue;
        const key = JSON.stringify([intent.graded, marketBrowseQuery(intent).toLowerCase()]);
        let group = groups.get(key);
        if (!group) {
            group = { intents: [intent], leads: [], ceiling };
            groups.set(key, group);
        }
        group.leads.push(lead);
        group.ceiling = Math.max(group.ceiling, ceiling);
        if (!group.intents.some(other => other.finish === intent.finish && other.cardNumber === intent.cardNumber)) group.intents.push(intent);
        if (goal !== "resell" || filters.typeFilter === "AUCTION") continue;
        for (const ask of lead.observedAsks ?? []) {
            if (knownIds.has(ask.listingId) || ask.potentialGrade < minGrade || ask.price < (filters.minPrice ?? 0) ||
                ask.price > marketItemLimit(lead, goal, targets, ask.shipping)) continue;
            const total = acquisitionCost(ask.price, ask.shipping, MONEY_CONFIG.buying);
            if (total <= (filters.maxPrice ?? Infinity) && total < (group.observedPurchaseTotal ?? Infinity)) group.observedPurchaseTotal = total;
        }
    }
    if (filters.typeFilter === "AUCTION") {
        // Historic BIN margins describe a different purchase format. Start with liquid
        // auction markets across distinct cards before offering more grades of one card.
        const volume = (group: MarketGroup) => Math.max(...group.leads.map(m => m.sales30));
        const ranked = [...groups.values()].sort((a, b) => volume(b) - volume(a));
        const featured = new Set<MarketGroup>();
        for (const kind of ["raw", "slab"] as const) {
            const leader = ranked.find(group => group.leads[0].kind === kind);
            if (leader) featured.add(leader);
        }
        const cards = new Set<string>();
        for (const group of [...featured, ...ranked]) {
            const card = huntMarketCardKey(group.leads[0]);
            if (!cards.has(card)) featured.add(group);
            cards.add(card);
        }
        return [...new Set([...featured, ...ranked])].slice(0, 8);
    }
    // Compare affordable, previously seen copies before truncating. Within each
    // tier, preserve the existing ranking by sale activity and historical profit.
    return [...groups.values()].sort((a, b) =>
        Number(b.observedPurchaseTotal !== undefined) - Number(a.observedPurchaseTotal !== undefined)).slice(0, 8);
}

// Acquisition costs and exit ceilings still apply to each copy individually.
// Keep every viable interpretation until an assessment identifies its condition.
export function groupMarketCopies(listings: ListingSummary[], group: MarketGroup, goal: DealHuntGoal, targets: Targets, filters: ListingFilters, now = Date.now()) {
    const copies = new Map<string, { listing: ListingSummary; leads: HuntMarket[] }>();
    for (const lead of group.leads) {
        for (const listing of shortlistMarketCopies(listings, lead, goal, targets, filters)) {
            const copy = copies.get(listing.id);
            if (copy) copy.leads.push(lead);
            else copies.set(listing.id, { listing, leads: [lead] });
        }
    }
    const delivered = ({ listing }: { listing: ListingSummary }) => listing.currentPrice! + (listing.shipping ?? 0);
    return [...copies.values()].sort((a, b) =>
        (filters.typeFilter === "AUCTION" ? auctionPhotoPriority(b.listing, now) - auctionPhotoPriority(a.listing, now) : 0) ||
        delivered(a) - delivered(b) || a.listing.id.localeCompare(b.listing.id));
}
