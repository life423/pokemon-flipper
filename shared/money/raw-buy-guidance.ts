import { cardLanguageStatus } from "../card-language.ts";
import { CONDITION_NAMES, RAW_CONDITIONS, isRawCondition, sellerCreaseOverridesCondition, type RawCondition } from "../conditions.ts";
import { dollars } from "../format.ts";
import { readyForPricing } from "../identity.ts";
import { displayedRawGrade, observedCardKind } from "../photo-evidence.ts";
import { photoReviewStatus } from "../photo-review.ts";
import { currentPriceEvidence } from "../pricing-freshness.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../search-diagnostic.ts";
import { median, soldMarketPrice } from "../sold-evidence.ts";
import type { CompSale, CompSummary, Evaluation, Targets } from "../types.ts";
import { cents } from "./cents.ts";
import { MONEY_CONFIG } from "./config.ts";
import { isRawSoldPrice, unsupportedVariantReason } from "./price-evidence.ts";
import { acquisitionCost, gradingTier, maxBid, netFromSale } from "./underwriting.ts";

export interface RawBuyGuidance {
    decision: "PASS" | "WAIT";
    headline: string;
    explanation: string;
    details: string[];
    marketEvidence?: string;
}

const day = 86_400_000;

function saleRange(prices: number[]) {
    const low = Math.min(...prices), high = Math.max(...prices);
    return low === high ? dollars(low) : `${dollars(low)}–${dollars(high)}`;
}

// Invert the existing fee calculation in whole cents, including sales tax on the fee base.
function breakEven(cost: number, kind: "raw" | "graded"): number | null {
    const required = cents(cost);
    if (!Number.isSafeInteger(required) || required <= 0) return null;
    let low = 0, high = required;
    const covers = (amount: number) => cents(netFromSale(amount / 100, kind, MONEY_CONFIG.selling)) >= required;
    while (!covers(high)) {
        if (high > Number.MAX_SAFE_INTEGER / 2) return null;
        high *= 2;
    }
    while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (covers(mid)) high = mid;
        else low = mid + 1;
    }
    return high / 100;
}

function usableRows(summary: CompSummary | null | undefined, now: number, maxDays: number): CompSale[] {
    return (summary?.sales ?? []).filter(sale => {
        const age = now - Date.parse(sale.soldAt);
        return Number.isFinite(age) && age >= 0 && age <= maxDays * day && Number.isSafeInteger(cents(sale.price)) &&
            sale.price > 0 && (sale.saleType === "fixed_price" || sale.saleType === "best_offer_accepted" || sale.saleType === "auction");
    });
}

// An item URL and a day/price fingerprint recognize repeated evidence, including
// a marketplace transaction reprinted on another site. Count collisions once.
function distinctSales<T>(rows: T[], fact: (row: T) => { url: string | null; soldAt: string; price: number }, seen = new Set<string>()) {
    return rows.filter(row => {
        const sale = fact(row);
        const item = sale.url?.match(/(?:^|\.)ebay\.com\/itm\/(?:[^/?#]+\/)?(\d{9,15})(?:[/?#]|$)/i)?.[1];
        const url = sale.url && (item ? `ebay:${item}` : sale.url.split(/[?#]/)[0]);
        const keys = [`day:${sale.soldAt.slice(0, 10)}:${cents(sale.price)}`, ...(url ? [url] : [])];
        const repeat = keys.some(key => seen.has(key));
        keys.forEach(key => seen.add(key));
        return !repeat;
    });
}

function rawComparisons(value: Evaluation, condition: RawCondition, now: number) {
    const raw = value.rawPricing, sold = raw?.sellerConditionComps;
    const exact = sold?.grader === "RAW" && sold.grade === condition
        ? usableRows(sold, now, 90).filter(sale => sale.sellerCondition === condition && (!sale.photoCondition || sale.photoCondition === condition)) : [];
    // The nearest cleaner bucket helps judge the price as a shopper. It never sets an exact-condition resale value.
    for (const cleaner of RAW_CONDITIONS.slice(0, RAW_CONDITIONS.indexOf(condition)).reverse()) {
        const summary = raw?.ebayComps?.find(s => s.grader === "RAW" && s.grade === cleaner);
        const checked = usableRows(summary, now, 90).filter(sale => sale.photoCondition === cleaner && sale.conditionEvidence?.length);
        if (checked.length) return { exact, cleaner, other: checked, photos: true };
        const claimed = raw?.cleanerSellerConditionComps;
        if (claimed?.grade === cleaner && claimed.grader === "RAW") {
            const rows = usableRows(claimed, now, 90).filter(sale => sale.sellerCondition === cleaner && (!sale.photoCondition || sale.photoCondition === cleaner));
            if (rows.length) return { exact, cleaner, other: rows, photos: false };
        }
    }
    return { exact, cleaner: null, other: [], photos: false };
}

function gradedComparisons(value: Evaluation, cost: number, now: number) {
    const details: string[] = [];
    const grade = displayedRawGrade(value)?.range;
    let plausibleProfit = false, hasLikelyGrade = false;
    for (const grader of ["PSA", "CGC"] as const) {
        const pricing = value.gradedPricing?.[grader];
        if (!grade?.likely || !pricing || pricing.source !== "pkmnprices" || pricing.printing !== value.identity?.printing ||
            !pricing.variant || pricing.variant !== value.rawPricing?.variant) continue;
        const byGrade = new Map<number, CompSummary>();
        for (const summary of [...(pricing.byGrade ?? []), ...(pricing.referenceByGrade ?? []), pricing.referenceGradeComps]) {
            const number = Number(summary?.grade);
            if (!summary || summary.grader !== grader || !Number.isInteger(number) || number < grade.low || number > grade.high ||
                !usableRows(summary, now, summary.windowDays === 180 ? 180 : 90).length || soldMarketPrice(summary) === null) continue;
            byGrade.set(number, summary);
        }
        if (!byGrade.size) continue;
        const sales = [...byGrade.values()].flatMap(s => usableRows(s, now, s.windowDays === 180 ? 180 : 90));
        const high = Math.max(...sales.map(s => s.price));
        const tier = gradingTier(grader, high, MONEY_CONFIG.grading);
        if (!tier) continue;
        const expenses = (cents(tier.fee) + cents(MONEY_CONFIG.grading.shippingPerCard)) / 100;
        const needed = breakEven(cost + expenses, "graded");
        if (needed === null) continue;
        plausibleProfit ||= high >= needed;
        const central = byGrade.get(grade.likely);
        if (central) {
            hasLikelyGrade = true;
            const rows = usableRows(central, now, central.windowDays === 180 ? 180 : 90);
            details.push(`${grader} ${grade.likely}: ${rows.length} matched ${rows.length === 1 ? "sale" : "sales"} at ${saleRange(rows.map(s => s.price))}. Grading and two-way shipping add ${dollars(expenses)}. The slab would need to sell for ${dollars(needed)} to break even.`);
        }
        if (byGrade.size > 1) {
            const grades = [...byGrade.keys()].sort((a, b) => a - b);
            details.push(`Across checked ${grader} grades ${grades.join(", ")}, the highest observed sale was ${dollars(high)}.`);
        }
    }
    const tracker = value.trackerPriceReference, market = tracker?.gradedMarket;
    if (market && tracker?.printingLabel === value.rawPricing?.variant && market.grader === "PSA" && Number(market.grade) === grade?.likely &&
        market.priceUsd > 0 && Number.isSafeInteger(cents(market.priceUsd)) && market.reportedSales > 0 &&
        now >= Date.parse(market.lastSaleAt) && now - Date.parse(market.lastSaleAt) <= (market.statistic === "7_DAY_MEDIAN" ? 7 : 90) * day) {
        const tier = gradingTier("PSA", market.priceUsd, MONEY_CONFIG.grading);
        if (tier) {
            const expenses = (cents(tier.fee) + cents(MONEY_CONFIG.grading.shippingPerCard)) / 100;
            const required = breakEven(cost + expenses, "graded");
            if (required !== null) {
                plausibleProfit ||= market.priceUsd >= required;
                details.push(`If graded PSA ${market.grade}, Pokémon Price Tracker reports a ${market.statistic === "7_DAY_MEDIAN" ? "7-day" : "historical"} median of ${dollars(market.priceUsd)}. Grading and shipping add ${dollars(expenses)}. Slab resale needs ${dollars(required)} to break even.`);
            }
        }
    }
    return { details, hasLikelyGrade, plausibleProfit };
}

function eligibleRawCopy(evaluation: Evaluation, now: number): boolean {
    const { listing, identity, condition } = evaluation;
    if (listing.buyingOption !== "FIXED_PRICE" ||
        listing.availability !== "ACTIVE" || listing.endTime && !(Date.parse(listing.endTime) > now) ||
        !identity?.name || !readyForPricing(identity) || identity.notThisCard || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish) ||
        cardLanguageStatus(listing.title, [identity.language, listing.aspects.Language, evaluation.photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        evaluation.slab || observedCardKind(evaluation) !== "raw" || evaluation.photoCheck?.cardMatch?.verdict !== "MATCH" ||
        !condition || !isRawCondition(condition.rawCondition) || condition.authenticity.concern !== "NONE_SEEN" ||
        evaluation.pricingDeferred || evaluation.frontPhotoStop || evaluation.deeperPhotoReview?.findings.some(f => f.impact === "NEW_CONCERN") ||
        sellerCreaseOverridesCondition(condition.rawCondition, listing.conditionNotes) || unsupportedVariantReason(evaluation) ||
        photoReviewStatus(evaluation).needsYourReview) return false;
    return true;
}

// Price refresh failures can still leave a verified sale or a conditional estimate
// from an earlier check. Cite only retained transactions inside their sale window.
export function savedRawPriceContext(evaluation: Evaluation, now: number, targets: Targets): string | null {
    if (!eligibleRawCopy(evaluation, now)) return null;
    const raw = evaluation.rawPricing, wear = evaluation.condition!.rawCondition;
    let sellerEvidence: string | null = null;
    const asOf = Date.parse(evaluation.pricesCheckedAt ?? "");
    if (isRawCondition(wear) && asOf <= now && currentPriceEvidence(evaluation, asOf) &&
        raw?.source === "pkmnprices" && raw.printing === evaluation.identity!.printing && raw.finish === evaluation.identity!.finish &&
        raw.conditionEvidence === "AI_PHOTOS" && raw.variant) {
        const point = raw.prices?.find(p => p.condition === wear && isRawSoldPrice(p));
        const summary = point?.comps ?? raw.ebayComps?.find(s => s.grader === "RAW" && s.grade === wear);
        if (summary?.grader === "RAW" && summary.grade === wear) {
            const dated = distinctSales(usableRows(summary, now, 90).filter(s => s.photoCondition === wear && s.conditionEvidence?.length), s => s);
            if (dated.length) {
                const newest = dated.map(s => s.soldAt.slice(0, 10)).sort().at(-1);
                return `PKMNPrices recorded ${dated.length} photo-checked ${CONDITION_NAMES[wear]} ${dated.length === 1 ? "sale" : "sales"} at ${saleRange(dated.map(s => s.price))}. Latest sale ${newest}.`;
            }
        }
        // A missing destination quote prevents a ceiling, but the sales themselves still have a price.
        const seller = distinctSales(rawComparisons(evaluation, wear, now).exact, s => s);
        if (seller.length) sellerEvidence = `PKMNPrices recorded ${seller.length} seller-described ${CONDITION_NAMES[wear]} ${seller.length === 1 ? "sale" : "sales"} at ${saleRange(seller.map(s => s.price))}.`;
    }
    return rawBuyGuidance(evaluation, now, targets, true)?.marketEvidence ?? sellerEvidence;
}

export function rawPriceReferences(evaluation: Evaluation, now: number, rawCondition: RawCondition, identity: NonNullable<Evaluation["identity"]>) {
    const recent = (date: string | null | undefined, days: number) => {
        const age = now - Date.parse(date ?? "");
        return age >= 0 && age <= days * day;
    };
    const web = evaluation.webPriceResearch, scope = web?.market;
    const scopedWeb = scope && scope.cardName === identity.name && scope.setName === identity.set &&
        scope.cardNumber === identity.cardNumber && scope.finish === identity.finish && scope.language === identity.language &&
        scope.printingLabel === (identity.printingLabel || identity.printing.replaceAll("_", " ")) &&
        scope.grader === "RAW" && scope.grade === CONDITION_NAMES[rawCondition] && recent(web?.checkedAt, 7);
    const tracker = evaluation.trackerRawReference;
    const tracked = tracker && tracker.source === "TCGPLAYER_MARKET" && tracker.recordId === String(identity.recordId) &&
        tracker.printing === identity.printing && tracker.finish === identity.finish && recent(tracker.updatedAt, 7) &&
        tracker.priceUsd > 0 && Number.isSafeInteger(cents(tracker.priceUsd)) ? tracker : null;
    return { web, scopedWeb, tracked, recent };
}

// Decision support for incomplete raw valuations. It never promotes an unconfirmed route to Deals or computes a raw loss from a worse copy.
export function rawBuyGuidance(evaluation: Evaluation, now = Date.now(), targets: Targets = MONEY_CONFIG.targets, allowSavedMarket = false): RawBuyGuidance | null {
    if (evaluation.underwriting?.verdict !== "CANT_PRICE" || !eligibleRawCopy(evaluation, now)) return null;
    const { listing, identity, condition, rawPricing: raw } = evaluation;
    if (!identity || !condition || !isRawCondition(condition.rawCondition)) return null;
    const wait = (explanation: string, details: string[] = [], marketEvidence?: string): RawBuyGuidance =>
        ({ decision: "WAIT", headline: "Wait at this price", explanation, details, ...(marketEvidence && { marketEvidence }) });
    const quoteAge = now - Date.parse(listing.termsCheckedAt ?? "");
    if (!Number.isFinite(quoteAge) || quoteAge < 0 || listing.price === null || !Number.isFinite(listing.price) || listing.price <= 0 ||
        listing.shipping === null || !Number.isFinite(listing.shipping) || listing.shipping < 0) {
        return wait("A confirmed item price and destination shipping quote are needed to calculate the purchase total.");
    }
    const rawCondition = condition.rawCondition;
    const asOf = Date.parse(evaluation.pricesCheckedAt ?? "");
    const native = !!raw && (currentPriceEvidence(evaluation, now) || allowSavedMarket && asOf <= now && currentPriceEvidence(evaluation, asOf)) && raw.conditionEvidence === "AI_PHOTOS" &&
        raw.source === "pkmnprices" && raw.printing === identity.printing && raw.finish === identity.finish && !!raw.variant;
    if (native && raw?.prices?.some(price => price.condition === rawCondition && isRawSoldPrice(price))) return null;
    const { web, scopedWeb, tracked, recent } = rawPriceReferences(evaluation, now, rawCondition, identity);
    if (!native && !scopedWeb && !tracked) return wait("Current matching sold evidence is missing for this printing and condition.");
    const cost = acquisitionCost(listing.price, listing.shipping, MONEY_CONFIG.buying);
    const needed = breakEven(cost, "raw");
    if (needed === null) return null;
    const comparisons = native ? rawComparisons(evaluation, rawCondition, now) : { exact: [], cleaner: null, other: [], photos: false };
    const seen = new Set<string>();
    const exact = distinctSales(comparisons.exact, sale => sale, seen);
    const cited = distinctSales(scopedWeb ? web!.observations.filter(row => row.kind === "SOLD" && row.priceUsd > 0 &&
        Number.isSafeInteger(cents(row.priceUsd)) && row.url && recent(row.date, 90)) : [],
        row => ({ url: row.url, soldAt: row.date!, price: row.priceUsd }), seen);
    const { cleaner, photos } = comparisons;
    const other = distinctSales(comparisons.other, sale => sale, seen);
    const prices = [...exact.map(s => s.price), ...cited.map(s => s.priceUsd)];
    const { details: graded, plausibleProfit, hasLikelyGrade } = native ? gradedComparisons(evaluation, cost, now)
        : { details: [], plausibleProfit: false, hasLikelyGrade: false };
    const checked = quoteAge >= BEST_BUY_TERMS_MAX_AGE_MS ? "Last checked" : "Estimated";
    const details = [`${checked} purchase total ${dollars(cost)}, including shipping and tax. Raw resale needs ${dollars(needed)} to break even after selling fees and postage.`];
    if (exact.length) {
        const fixed = exact.filter(sale => sale.saleType === "fixed_price");
        details.push(`${exact.length} ${exact.length === 1 ? "sale" : "sales"} described by sellers as ${CONDITION_NAMES[rawCondition]} closed at ${saleRange(exact.map(s => s.price))}.${fixed.length ? ` Buy It Now: ${saleRange(fixed.map(s => s.price))}.` : ""}`);
    }
    if (cleaner && other.length) details.push(`${other.length} cleaner ${CONDITION_NAMES[cleaner]} ${other.length === 1 ? "copy" : "copies"} ${photos ? "checked from sold photos" : "described by sellers"} sold at ${saleRange(other.map(s => s.price))}.`);
    if (cited.length) details.push(`${cited.length} additional cited ${cited.length === 1 ? "sale" : "sales"} described as ${CONDITION_NAMES[rawCondition]} closed at ${saleRange(cited.map(s => s.priceUsd))}.`);
    if (tracked) details.push(`Pokémon Price Tracker reports a TCGplayer market estimate of ${dollars(tracked.priceUsd)} for ${CONDITION_NAMES[tracked.condition]} on ${tracked.updatedAt.slice(0, 10)}.`);
    const miss = `An exact photo-confirmed ${CONDITION_NAMES[rawCondition]} resale value is still missing.`;
    const basis = prices.length ? median(prices) : tracked?.condition === rawCondition ? tracked.priceUsd : null;
    let comparison = "";
    if (basis !== null) {
        const label = exact.length && cited.length ? "PKMNPrices and cited web sales" : cited.length ? "Cited web sales" : "PKMNPrices sold listings";
        const evidence = prices.length ? `${label} show ${prices.length} seller-described ${CONDITION_NAMES[rawCondition]} ${prices.length === 1 ? "sale" : "sales"} at ${saleRange(prices)}.`
            : `Pokémon Price Tracker reports a ${dollars(basis)} TCGplayer market estimate for ${CONDITION_NAMES[rawCondition]}.`;
        const proceeds = netFromSale(basis, "raw", MONEY_CONFIG.selling);
        const itemLimit = maxBid({ expectedNet: proceeds, fixedCosts: 0, shipping: listing.shipping }, { ...MONEY_CONFIG, targets });
        const ceiling = itemLimit > 0 ? acquisitionCost(itemLimit, listing.shipping, MONEY_CONFIG.buying) : 0;
        const assumption = prices.length > 1 ? `At the ${dollars(basis)} median` : `At ${dollars(basis)} resale`;
        comparison = `${evidence} ${assumption}, ${ceiling ? `your raw-flip limit is ${dollars(ceiling)} all-in` : "even a zero item price leaves too little after shipping to meet your targets"}.`;
        details.push(`${assumption}, raw resale leaves ${dollars(proceeds)} after fees and postage. The limit assumes this copy sells at that price.`);
    }
    details.push(...graded);
    const allBelow = (amounts: number[]) => amounts.length > 0 && amounts.every(price => price < needed);
    if (prices.length >= 2 && allBelow(prices) && cleaner && allBelow(other.map(s => s.price)) && !plausibleProfit &&
        (photos && hasLikelyGrade || !photos && prices.length >= 3 && other.length >= 2) &&
        !(tracked?.condition === rawCondition && tracked.priceUsd >= needed)) {
        return { decision: "PASS", headline: `Pass at ${dollars(cost)} all-in`, marketEvidence: comparison, explanation:
            `${comparison} Raw resale needs ${dollars(needed)} to break even. Even the cleaner ${CONDITION_NAMES[cleaner]} comparisons sold below that.`, details: [...details, miss] };
    }
    if (comparison) return wait(`${comparison} ${plausibleProfit ? "Grading could cover the purchase at a plausible grade, but the margin depends on that outcome." : `Raw resale needs ${dollars(needed)} to break even at the asking price.`}`, [...details, miss], comparison);
    if (tracked) {
        const reference = `Pokémon Price Tracker quotes ${dollars(tracked.priceUsd)} for a cleaner ${CONDITION_NAMES[tracked.condition]} copy. This ${CONDITION_NAMES[rawCondition]} copy needs ${dollars(needed)} at resale to break even.`;
        return wait(reference, [...details, miss], reference);
    }
    if (plausibleProfit) return wait("A sale at a plausible grade could cover costs, but the evidence is too thin to buy for that outcome.", details);
    return wait(miss, details);
}
