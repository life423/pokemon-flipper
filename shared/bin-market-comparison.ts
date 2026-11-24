import { BEST_BUY_TERMS_MAX_AGE_MS } from "./search-diagnostic.ts";
import { parseListingLink } from "./listing-link.ts";
import { setKey } from "./sets.ts";
import { compareCardNumbers } from "./card-number.ts";
import { finishClaim } from "./finish.ts";
import { cardLanguageStatus } from "./card-language.ts";
import { listingDisclosesCardCrease } from "./ebay-condition-notes.ts";
import { cents, money } from "./money/cents.ts";
import { sellerConditionClues } from "./raw-condition-claim.ts";
import { hasExactSoldScope, median, soldReferenceScope, usableSoldReference } from "./sold-evidence.ts";
import type { Evaluation, ListingSummary, Screen, ScreeningSoldReference } from "./types.ts";

type Comparison = NonNullable<Screen["marketComparison"]>;

function delivered(listing: Pick<ListingSummary, "currentPrice" | "shipping">) {
    const { currentPrice, shipping } = listing;
    if (currentPrice == null || shipping == null || !(currentPrice > 0) || !(shipping >= 0)) return null;
    const total = cents(currentPrice) + cents(shipping);
    return Number.isSafeInteger(total) && total > 0 ? total / 100 : null;
}

function referenceFor(listing: ListingSummary) {
    const screen = listing.screen, evidence = screen?.soldEvidence;
    if (listing.buyingOption !== "FIXED_PRICE" || listing.match || screen?.junk || listing.availability && listing.availability !== "ACTIVE" ||
        cardLanguageStatus(listing.title) === "OTHER" || screen?.priceAnomaly && !screen.priceAnomaly.photoChecked ||
        evidence?.status !== "AVAILABLE" || !hasExactSoldScope(evidence, screen?.card?.printing)) return null;
    const ref = evidence.references[0], card = screen?.card, attributes = listing.listedAttributes;
    if (card?.set && setKey(card.set) !== setKey(ref.set) ||
        card?.cardNumber && compareCardNumbers(card.cardNumber, ref.cardNumber) === false ||
        attributes?.finish && attributes.finish !== ref.finish ||
        listing.isGraded && (attributes?.grader && attributes.grader.toUpperCase() !== ref.grader ||
            attributes?.grade != null && attributes.grade !== Number(ref.grade))) return null;
    const seller = listing.isGraded ? null : sellerConditionClues(listing);
    if (seller?.conflict || seller?.ambiguous) return null;
    const condition = !listing.isGraded && listingDisclosesCardCrease(listing) ? "DAMAGED" : seller?.claim ?? null;
    return evidence.references.find(ref => ref.condition === condition && usableSoldReference(ref, listing.isGraded)) ?? null;
}

function itemKey(id: string) {
    return parseListingLink(id)?.itemId.split("|")[1] ?? id;
}

function recentSalePrices(reference: ScreeningSoldReference, asOf: number) {
    const distinct = new Map<string, number>();
    for (const sale of reference.summary.sales ?? []) {
        const age = asOf - Date.parse(sale.soldAt);
        if (!(age >= 0 && age <= 90 * 86_400_000) || !Number.isFinite(sale.price) || sale.price <= 0 ||
            !sale.saleType || !["fixed_price", "auction", "best_offer_accepted"].includes(sale.saleType)) continue;
        const key = sale.url && itemKey(sale.url.split(/[?#]/)[0]) || JSON.stringify([sale.title, sale.soldAt, sale.price]);
        distinct.set(key, sale.price);
    }
    return [...distinct.values()];
}

// Compare only the screened inventory in this search. Overpriced listings can
// establish the asking market, but do not re-enter the results or the photo queue.
export function addBinMarketComparisons(rows: ListingSummary[], excludedByPrice: ListingSummary[], asOf: number): ListingSummary[] {
    const groups = new Map<string, { asks: Map<string, number>; asOf: number }>();
    const markets = new Map<string, { key: string; reference: ScreeningSoldReference; item: string }>();
    for (const row of [...rows, ...excludedByPrice]) {
        const price = delivered(row), reference = referenceFor(row);
        if (price === null || !reference) continue;
        const key = JSON.stringify([soldReferenceScope(reference), reference.condition]);
        // A resumed Browse page can predate this search. Never extend the
        // checked prices' lifetime by attaching the newer search timestamp.
        const checkedAt = Date.parse(row.termsCheckedAt ?? "");
        if (!Number.isFinite(checkedAt) || asOf - checkedAt >= BEST_BUY_TERMS_MAX_AGE_MS) continue;
        const group = groups.get(key) ?? { asks: new Map<string, number>(), asOf };
        const item = itemKey(row.id);
        group.asks.set(item, price);
        group.asOf = Math.min(group.asOf, checkedAt);
        groups.set(key, group);
        markets.set(row.id, { key, reference, item });
    }
    function compare(row: ListingSummary): Comparison | undefined {
        const market = markets.get(row.id);
        if (!market) return;
        const group = groups.get(market.key)!;
        const { asks } = group;
        if (asks.size < 4) return;
        const price = delivered(row)!;
        const peers = [...asks].filter(([id]) => id !== market.item).map(([, amount]) => amount);
        const otherAskMedian = median(peers);
        if (price >= otherAskMedian) return;
        if (market.reference.summary.count < 3) return;
        const sales = recentSalePrices(market.reference, asOf);
        if (sales.length < 3) return;
        const soldMedian = median(sales);
        if (price >= soldMedian) return;
        const lowerMedian = Math.min(otherAskMedian, soldMedian);
        const discountPercent = Math.floor((lowerMedian - price) * 1000 / lowerMedian) / 10;
        if (discountPercent <= 0) return;
        return { delivered: price, otherAskMedian: money(otherAskMedian), otherAskCount: peers.length,
            soldMedian: money(soldMedian), soldCount: sales.length, discountPercent,
            scope: soldReferenceScope(market.reference), condition: market.reference.condition, asOf: new Date(group.asOf).toISOString() };
    }
    return rows.map(row => {
        const comparison = compare(row);
        if (!row.screen || !comparison && !row.screen.marketComparison) return row;
        const screen = { ...row.screen };
        if (comparison) screen.marketComparison = comparison;
        else delete screen.marketComparison;
        return { ...row, screen };
    });
}

export function currentBinComparison(listing: ListingSummary, evaluation?: Evaluation | null, now = Date.now()) {
    const comparison = listing.screen?.marketComparison;
    if (!comparison || delivered(listing) !== comparison.delivered) return null;
    const age = now - Date.parse(comparison.asOf);
    if (!Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS) return null;
    const ref = referenceFor(listing);
    if (!ref || soldReferenceScope(ref) !== comparison.scope || ref.condition !== comparison.condition) return null;
    if (evaluation) {
        const { identity, listing: current, slab, condition } = evaluation;
        if (current.availability !== "ACTIVE" || current.buyingOption !== "FIXED_PRICE" ||
            delivered({ currentPrice: current.price, shipping: current.shipping }) !== comparison.delivered ||
            identity?.status !== "IDENTIFIED" || identity.notThisCard || identity.printing !== ref.printing ||
            finishClaim(identity.finish) !== ref.finish || setKey(identity.set ?? "") !== setKey(ref.set) ||
            compareCardNumbers(identity.cardNumber, ref.cardNumber) !== true ||
            (listing.isGraded ? slab?.status !== "OK" || slab.grader !== ref.grader || Number(slab.grade) !== Number(ref.grade)
                : slab || comparison.condition && condition?.rawCondition !== comparison.condition)) return null;
    }
    return comparison;
}
