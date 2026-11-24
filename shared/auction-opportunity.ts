import { withinOpportunityWindow } from "./auction-window.ts";
import { cardLanguageStatus } from "./card-language.ts";
import { CONDITION_NAMES, isRawCondition, sellerCreaseOverridesCondition, type RawCondition } from "./conditions.ts";
import { finishClaim } from "./finish.ts";
import { dollars } from "./format.ts";
import { readyForPricing } from "./identity.ts";
import { hasSpecialSlabTitle } from "./grade-qualifier.ts";
import { parseListingLink } from "./listing-link.ts";
import { cents } from "./money/cents.ts";
import { MONEY_CONFIG } from "./money/config.ts";
import { isRawSoldPrice, isUsableRawPrice, unsupportedVariantReason } from "./money/price-evidence.ts";
import { acquisitionCost, maxBid } from "./money/underwriting.ts";
import { observedCardKind, photoCoverage } from "./photo-evidence.ts";
import { currentPriceEvidence, maxPriceEvidenceAge } from "./pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "./search-diagnostic.ts";
import { verifiedSlabMarketKey } from "./slab-market.ts";
import { soldMarketPrice } from "./sold-evidence.ts";
import { observedSalesActivity, SALES_ACTIVITY_MS } from "./sales-activity.ts";
import type { CompSummary, Evaluation, Grader, PathKind, Targets } from "./types.ts";

const day = 86_400_000;
export { withinOpportunityWindow, AUCTION_OPPORTUNITY_HOURS } from "./auction-window.ts";

type BidListing = Pick<Evaluation["listing"], "auctionQuote" | "bids" | "price">;
function currentQuote(checkedAt: string | undefined, now: number) {
    const age = now - Date.parse(checkedAt ?? "");
    return age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS;
}

export function nextAuctionBid(listing: BidListing, now: number): number | null {
    const { auctionQuote, bids, price } = listing;
    const next = auctionQuote?.minimumBid;
    if (!auctionQuote || !currentQuote(auctionQuote.checkedAt, now) || next == null || !Number.isFinite(next) || next <= 0 ||
        price === null || !Number.isInteger(bids) || bids < 0 ||
        (bids > 0 ? auctionQuote.currentBid !== price || next <= price : auctionQuote.currentBid !== null || next < price)) return null;
    return next;
}

interface GradeOutcome { grader: Grader; likelyGrade: number; lowerGrade: number; likelyProfit: number; lowerProfit: number; gradingCosts: number }
export interface AuctionOpportunity {
    listingId: string; endsAt: string; checkedAt: string; validUntil: number;
    status: "BID" | "PASS" | "WATCH"; currentPrice: number; marketValue: number; sales30: number; sales60?: number; sampleSize: number;
    marketLabel: string; nextBid: number | null; nextTotal: number | null; maxBid: number | null; profitAtNext: number | null;
    route: string | null; routeKind: PathKind | null; exitSales30: number; exitSales60?: number; grading: GradeOutcome | null; reason: string;
}

function matchesFinish(variant: string | undefined, finish: string | undefined) {
    if (!variant) return false;
    const claim = finishClaim(variant);
    return (claim === "NOT_STATED" ? "NON_HOLO" : claim) === finish;
}

function marketSales(summary: CompSummary | undefined, now: number, condition?: RawCondition) {
    if (!summary?.count || !summary.sales?.length) return null;
    const price = soldMarketPrice(summary);
    if (price === null) return null;
    const distinct = new Map<string, { at: number; price: number }>();
    for (const sale of summary.sales) {
        const at = Date.parse(sale.soldAt), age = now - at;
        const id = parseListingLink(sale.url)?.itemId.split("|")[1];
        if (!id || !["auction", "fixed_price", "best_offer_accepted"].includes(sale.saleType ?? "") ||
            !(Number.isFinite(sale.price) && sale.price > 0) || ("currency" in sale && sale.currency !== "USD") ||
            (!condition && hasSpecialSlabTitle(sale.title)) || !(age >= 0 && age <= (summary.windowDays === 180 ? 180 : 90) * day) ||
            condition && (sale.photoCondition !== condition || !sale.conditionEvidence?.length)) return null;
        const previous = distinct.get(id);
        if (previous && (previous.at !== at || previous.price !== sale.price)) return null;
        distinct.set(id, { at, price: sale.price });
    }
    const activity = observedSalesActivity((summary.activitySales ?? summary.sales).filter(sale => !condition ||
        sale.photoCondition === condition && Boolean(sale.conditionEvidence?.length)), now,
        { maxDays: summary.windowDays === 180 ? 180 : 90, slab: !condition });
    const recent = activity.observations.map(s => s.at).filter(at => now - at <= SALES_ACTIVITY_MS);
    return distinct.size ? { price, count: distinct.size, recent, sales30: recent.filter(at => now - at <= 30 * day).length,
        saleIds: new Set(distinct.keys()) } : null;
}

function asListedMarket(e: Evaluation, now: number) {
    const id = e.identity;
    if (!id?.name || !readyForPricing(id) || id.notThisCard || unsupportedVariantReason(e) ||
        cardLanguageStatus(e.listing.title, [id.language, e.photoCheck?.cardIdentity?.language, e.listing.aspects.Language]) !== "ENGLISH") return null;
    if (observedCardKind(e) === "graded") {
        const p = e.slabPricing, slab = e.slab;
        if (!slab || !verifiedSlabMarketKey(e) || p?.status !== "PRICED" || p.printing !== id.printing ||
            !matchesFinish(p.variant, id.finish) || p.summary?.grader !== slab.grader ||
            p.grader !== slab.grader || String(p.grade) !== slab.grade || String(p.summary?.grade) !== slab.grade) return null;
        const market = marketSales(p.summary, now);
        return market && { ...market, label: slab.grader + " " + slab.grade, kind: "GRADED_RESALE" as const };
    }
    const wear = e.condition?.rawCondition, p = e.rawPricing;
    if (observedCardKind(e) !== "raw" || !isRawCondition(wear) || !e.condition || e.slab ||
        e.condition.authenticity.concern !== "NONE_SEEN" || e.condition.creases === "SUSPECTED" ||
        sellerCreaseOverridesCondition(wear, e.listing.conditionNotes) || p?.printing !== id.printing ||
        p?.status !== "PRICED" ||
        !matchesFinish(p.variant, id.finish) || p.finish && p.finish !== id.finish) return null;
    const row = p.prices?.find(row => row.condition === wear && isUsableRawPrice(row));
    if (row?.basis?.startsWith("TCGPLAYER_")) {
        const physical = row.comps ?? p.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear && s.count > 0);
        const seller = p.sellerConditionComps;
        const summary = seller?.grader === "RAW" && seller.grade === wear && seller.count > 0 ? seller
            : physical?.grader === "RAW" && physical.grade === wear ? physical : undefined;
        const activity = observedSalesActivity((summary?.activitySales ?? summary?.sales)?.filter(sale => summary !== physical ||
            sale.photoCondition === wear && Boolean(sale.conditionEvidence?.length)) ?? [], now);
        return { price: row.price, count: activity.observations.length, recent: activity.observations
            .filter(sale => now - sale.at <= SALES_ACTIVITY_MS).map(sale => sale.at), sales30: activity.sales30,
            saleIds: new Set(activity.observations.map(sale => sale.id)), label: CONDITION_NAMES[wear] + " raw", kind: "RAW" as const };
    }
    if (!row || !isRawSoldPrice(row) || p.conditionEvidence !== "AI_PHOTOS") return null;
    const summary = row?.comps ?? p.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear);
    const market = summary?.grader === "RAW" && summary.grade === wear ? marketSales(summary, now, wear) : null;
    return market && market.price === row?.price ? { ...market, label: CONDITION_NAMES[wear] + " raw", kind: "RAW" as const } : null;
}

type Market = NonNullable<ReturnType<typeof asListedMarket>>;
function resaleRoutes(e: Evaluation, market: Market, targets: Targets, nextTotal: number, now: number) {
    const shipping = e.listing.shipping!, config = { ...MONEY_CONFIG, targets };
    interface Route { label: string; kind: PathKind; max: number; profit: number; recent: number[]; expires: number; grading: GradeOutcome | null }
    const routes: Route[] = [];
    for (const path of e.underwriting?.paths ?? []) {
        if (path.status !== "PRICED" || path.shipping !== shipping) continue;
        const cost = nextTotal + path.fixedCosts;
        const limit = (net: number, inner = config) => maxBid({ expectedNet: net, fixedCosts: path.fixedCosts, shipping }, inner);
        const profit = (net: number) => (cents(net) - cents(cost)) / 100;
        if (path.path === market.kind && path.salePrice === market.price &&
            (path.path !== "RAW" || path.priceCondition === e.condition?.rawCondition)) {
            routes.push({label: path.label, kind: path.path, max: limit(path.expectedNet), profit: profit(path.expectedNet),
                recent: market.recent, expires: Infinity, grading: null});
            continue;
        }
        const grade = e.condition?.gradeRange?.likely;
        if (path.path !== "GRADE" || market.kind !== "RAW" || !path.grader || !grade || !e.photoCheck) continue;
        const coverage = photoCoverage(e.photoCheck);
        const p = e.gradedPricing?.[path.grader];
        if (!coverage.fronts || !coverage.backs || p?.status !== "PRICED" || p.printing !== e.identity?.printing ||
            !matchesFinish(p.variant, e.identity?.finish) || p.grader && p.grader !== path.grader) continue;
        const at = (g: number) => {
            const sales = marketSales(p.byGrade?.find(s => s.grader === path.grader && Number(s.grade) === g), now);
            const outcome = path.outlook?.find(o => o.grade === g && o.filledFrom === null && o.price === sales?.price);
            return sales && outcome ? { ...sales, net: outcome.net } : null;
        };
        const likely = at(grade), lower = at(grade - 1);
        if (!likely || !lower || [...likely.saleIds].some(id => lower.saleIds.has(id) || market.saleIds.has(id)) ||
            [...lower.saleIds].some(id => market.saleIds.has(id))) continue;
        const ceiling = Math.min(limit(path.expectedNet), limit(likely.net), limit(lower.net, { ...config, targets: { minProfit: 0, minRoi: 0 } }));
        routes.push({ label: path.label, kind: path.path, max: ceiling, profit: profit(path.expectedNet), recent: likely.recent, expires: Infinity,
            grading: { grader: path.grader, likelyGrade: grade, lowerGrade: grade - 1, gradingCosts: path.fixedCosts,
                likelyProfit: profit(likely.net), lowerProfit: profit(lower.net) } });
    }
    return routes;
}

// Compare the rounded, tax-inclusive purchase in whole cents, including bids exactly at the cap.
export function affordableBidLimit(limit: number, shipping: number, budget: number) {
    let low = 0, high = cents(limit);
    while (low < high) {
        const middle = low + Math.ceil((high - low) / 2);
        if (cents(acquisitionCost(middle / 100, shipping, MONEY_CONFIG.buying)) <= cents(budget)) low = middle;
        else high = middle - 1;
    }
    return low / 100;
}

export function currentAuctionMarket(e: Evaluation, now: number) {
    const l = e.listing, price = l.price;
    if (l.buyingOption !== "AUCTION" || l.availability !== "ACTIVE" || !withinOpportunityWindow(l.endTime, now) ||
        !currentQuote(l.termsCheckedAt, now) || price == null || !Number.isFinite(price) || price <= 0 || !currentPriceEvidence(e, now) ||
        e.frontPhotoStop === "AUTHENTICITY" || e.deeperPhotoReview?.findings.some(f => f.impact === "NEW_CONCERN")) return null;
    return asListedMarket(e, now);
}

export function auctionOpportunity(e: Evaluation, targets: Targets, now = Date.now(), maxDelivered?: number): AuctionOpportunity | null {
    const market = currentAuctionMarket(e, now), l = e.listing, price = l.price;
    if (!market || price == null || cents(price) >= cents(market.price)) return null;
    const next = nextAuctionBid(l, now), shipping = l.shipping;
    const costAt = (bid: number) => shipping !== null && Number.isFinite(shipping) && shipping >= 0
        ? acquisitionCost(bid, shipping, MONEY_CONFIG.buying) : null;
    const total = next == null ? null : costAt(next);
    // A missing next bid still allows delivery and resale costs to establish a ceiling.
    const basis = total ?? costAt(price);
    const routes = basis == null ? [] : resaleRoutes(e, market, targets, basis, now);
    if (maxDelivered != null && shipping !== null) {
        for (const route of routes) route.max = affordableBidLimit(route.max, shipping, maxDelivered);
    }
    const eligible = routes.filter(r => e.underwriting?.verdict.startsWith("BUY") && next !== null && next <= r.max);
    const route = eligible.sort((a,b) => b.profit - a.profit)[0] ?? routes.sort((a,b) => b.max - a.max)[0];
    const status = eligible.length ? "BID" : route && next !== null && !routes.some(r => r.max >= next) ? "PASS" : "WATCH";
    let reason: string;
    if (status === "BID") reason = `Bid up to ${dollars(route.max)} before shipping and tax. ${route.label} projects ${dollars(route.profit)} profit after costs if you win at ${dollars(next)}.`;
    else if (status === "PASS") reason = `Pass at the next bid of ${dollars(next)}. ${route.max > 0 ? `Your item-bid limit is ${dollars(route.max)}.` : "No positive bid meets your resale targets."}`;
    else if (next === null) reason = (route && route.max > 0 ? `The estimated item-bid ceiling is ${dollars(route.max)}. ` : "") +
        "Watch for a fresh minimum bid from eBay before bidding.";
    else if (total === null) reason = "Wait for a destination shipping quote to calculate the delivered cost.";
    else if (route) reason = "Wait. The condition or resale checks for this copy do not support a bid.";
    else reason = "Wait. The sale comparisons establish the card’s market value, but the available evidence does not support a profitable bid limit.";
    const validity = [Date.parse(l.endTime!), Date.parse(l.termsCheckedAt!) + BEST_BUY_TERMS_MAX_AGE_MS,
        Date.parse(e.pricesCheckedAt!) + maxPriceEvidenceAge(e)];
    if (next !== null) validity.push(Date.parse(l.auctionQuote!.checkedAt) + BEST_BUY_TERMS_MAX_AGE_MS);
    if (status === "BID") validity.push(route.expires);
    return { listingId: l.id, endsAt: l.endTime!, checkedAt: l.termsCheckedAt!, validUntil: Math.min(...validity), status, currentPrice: price,
        marketValue: market.price, marketLabel: market.label, sampleSize: market.count, sales30: market.sales30, sales60: market.recent.length,
        nextBid: next, nextTotal: total, maxBid: route?.max ?? null, profitAtNext: total == null ? null : route?.profit ?? null,
        route: route?.label ?? null, routeKind: route?.kind ?? null,
        exitSales30: route?.recent.filter(at => now - at <= 30 * day).length ?? 0, exitSales60: route?.recent.length ?? 0,
        grading: total == null ? null : route?.grading ?? null, reason };
}
