import { auctionDecision } from "../../../shared/card-presentation.ts";
import { searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import { withinAutomaticAuctionWindow } from "../../../shared/listing-filters.ts";
import { cents } from "../../../shared/money/cents.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { currentPriceEvidence } from "../../../shared/pricing-freshness.ts";
import { nextAuctionBid } from "../../../shared/auction-opportunity.ts";
import { verifiedSlabMarketKey } from "../../../shared/slab-market.ts";
import type { ListingSummary, SearchIntent, Targets } from "../../../shared/types.ts";
import type { AnalysisState } from "../analysis-state.ts";
import { eligibleAssessedListing, checkedTerms } from "./results.ts";

export const COMPETING_AUCTION_MINUTES = 15;

interface Auction {
    listing: ListingSummary;
    ends: number;
    next: number | null;
    nextTotal: number | null;
    shipping: number | null;
    limit: number | null;
}

interface BuyNow { listing: ListingSummary; deliveredCents: number; total: number }

function compareGroup(auctions: Auction[], bin: BuyNow | null) {
    const rows = auctions.map(auction => {
        const { shipping, limit, next, nextTotal } = auction;
        const binLimit = bin && shipping !== null ? Math.max(0, bin.deliveredCents - cents(shipping)) / 100 : null;
        const ceiling = limit !== null && binLimit !== null ? Math.min(limit, binLimit) : limit;
        const status = ceiling === null || next === null || nextTotal === null ? "CHECK" :
            next > ceiling || bin && nextTotal >= bin.total ? "PASS" : "WITHIN";
        return { ...auction, ceiling, status };
    });
    const preferred = rows.filter(row => row.status === "WITHIN")
        .sort((a, b) => a.nextTotal! - b.nextTotal! || a.ends - b.ends)[0];
    return { rows, preferredId: preferred?.listing.id ?? null, bin };
}

export function competingAuctions(listings: ListingSummary[], analyses: Record<string, AnalysisState>,
    intent: SearchIntent | null | undefined, targets: Targets, now: number) {
    const groups = new Map<string, { label: string; auctions: Auction[]; bin: BuyNow | null }>();
    const seenIds = new Set<string>();
    const certCounts = new Map<string, number>();
    const copies = listings.flatMap(listing => {
        if (seenIds.has(listing.id) || !withinAutomaticAuctionWindow(listing, now)) return [];
        seenIds.add(listing.id);
        const value = eligibleAssessedListing(listing, analyses[listing.id], intent, now, listing.buyingOption);
        if (!value?.identity || !value.slab || listing.title.trim() !== value.listing.title.trim() ||
            !searchPhotosFitDetails(listing.images, value.listing.photos ?? [])) return [];
        const market = verifiedSlabMarketKey(value);
        if (!market) return [];
        const cert = value.slab.certNumber?.trim();
        const certKey = cert ? JSON.stringify([value.slab.grader, cert]) : null;
        if (certKey) certCounts.set(certKey, (certCounts.get(certKey) ?? 0) + 1);
        return [{ listing, value, market, certKey }];
    });
    for (const { listing, value, market, certKey } of copies) {
        if (certKey && certCounts.get(certKey)! > 1) continue;
        const { identity, slab } = value;
        const label = [identity!.name, identity!.cardNumber, identity!.set, identity!.printing.replaceAll("_", " ").toLowerCase(),
            identity!.finish.replaceAll("_", " ").toLowerCase(), slab!.grader + " " + slab!.grade].join(" · ");
        const group = groups.get(market) ?? { label, auctions: [], bin: null };
        groups.set(market, group);
        const terms = checkedTerms(listing, value, now);
        if (listing.buyingOption === "FIXED_PRICE") {
            if (!terms) continue;
            const deliveredCents = cents(terms.price) + cents(terms.shipping);
            if (!group.bin || deliveredCents < group.bin.deliveredCents) {
                group.bin = { listing, deliveredCents, total: acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying) };
            }
            continue;
        }
        const ends = Date.parse(listing.endTime!);
        if (ends !== Date.parse(value.listing.endTime ?? "")) continue;
        const sales = value.slabPricing?.summary;
        const decision = auctionDecision(value, targets, now);
        const verdict = value.underwriting?.verdict;
        const state = analyses[listing.id];
        const canPrice = state?.status === "done" && !state.pricingExpired && currentPriceEvidence(value, now);
        const limit = terms && canPrice && (verdict === "BUY_GRADED" || verdict === "PASS") && !value.underwriting?.shippingUnconfirmed && !decision.provisional && !priceEvidenceGap(value) &&
            sales && sales.count > 0 && sales.grader === slab!.grader && Number(sales.grade) === Number(slab!.grade) &&
            value.underwriting?.best?.path === "GRADED_RESALE" ? decision.ceiling : null;
        const next = nextAuctionBid(value.listing, now);
        group.auctions.push({ listing, ends, next, nextTotal: next !== null && terms ? acquisitionCost(next, terms.shipping, MONEY_CONFIG.buying) : null,
            shipping: terms?.shipping ?? null, limit });
    }
    const clusters = [];
    for (const { label, auctions, bin } of groups.values()) {
        auctions.sort((a, b) => a.ends - b.ends || a.listing.id.localeCompare(b.listing.id));
        for (let i = 0; i < auctions.length;) {
            let end = i + 1;
            while (end < auctions.length && auctions[end].ends - auctions[i].ends <= COMPETING_AUCTION_MINUTES * 60_000) end++;
            if (end - i >= 2) clusters.push({ label, ...compareGroup(auctions.slice(i, end), bin) });
            i = end;
        }
    }
    return clusters.sort((a, b) => a.rows[0].ends - b.rows[0].ends);
}
