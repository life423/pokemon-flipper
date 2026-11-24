import { sameCardNumber } from "../../shared/card-number.ts";
import { CONDITION_NAMES } from "../../shared/conditions.ts";
import type { DealHuntGoal } from "../../shared/deal-hunt.ts";
import { dollars } from "../../shared/format.ts";
import { readyForPricing } from "../../shared/identity.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost, gradingTier, maxBid, netFromSale } from "../../shared/money/underwriting.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import type { Evaluation, ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import type { HuntMarket, HuntOrigin } from "./same-set-markets.ts";

export function huntOrigin(intent: SearchIntent | undefined, evaluations: Iterable<Evaluation>): HuntOrigin | null {
    if (intent?.sets.length === 1) return { name: intent.cardName ?? "", set: intent.sets[0], cardNumber: intent.cardNumber };
    const identified = [...evaluations].map(value => value.identity).filter(id => id?.set && readyForPricing(id));
    const first = identified[0];
    if (!first?.set || identified.some(id => !sameSetFamily(id?.set, first.set))) return null;
    return { name: intent?.cardName ?? first.name ?? "", set: first.set, cardNumber: intent?.cardNumber ?? (identified.every(id => sameCardNumber(id?.cardNumber, first.cardNumber)) ? first.cardNumber : null) };
}

export function marketIntent(m: HuntMarket): SearchIntent {
    const graded = m.kind === "slab";
    return { cardName: m.name, cardNumber: m.cardNumber, sets: [m.set], printing: m.printing, finish: m.finish, graded,
        grader: graded ? m.grader : null, minGrade: graded ? m.grade : null, maxGrade: graded ? m.grade : null,
        titleWords: [], source: "rules" };
}

export function keepsSetSearchPreferences(m: HuntMarket, original?: SearchIntent) {
    if (!original) return true;
    const graded = m.kind === "slab";
    return (original.graded == null || original.graded === graded) &&
        (!original.printing || original.printing === m.printing) && (!original.finish || original.finish === m.finish) &&
        (!original.grader || graded && original.grader === m.grader) &&
        (original.minGrade == null || graded && m.grade !== null && m.grade >= original.minGrade) &&
        (original.maxGrade == null || graded && m.grade !== null && m.grade <= original.maxGrade);
}

export function matchesHuntMarket(e: Evaluation, m: HuntMarket) {
    const id = e.identity;
    if (!id || !readyForPricing(id) || id.printing !== m.printing || id.finish !== m.finish ||
        !sameSetFamily(id.set, m.set) || !sameCardNumber(id.cardNumber, m.cardNumber) || !sameCatalogName(id.name, m.name)) return false;
    if (m.kind === "slab") return observedCardKind(e) === "graded" && e.slab?.grader === m.grader && Number(e.slab?.grade) === m.grade;
    if (observedCardKind(e) !== "raw") return false;
    return m.condition ? e.condition?.rawCondition === m.condition : e.condition?.gradeRange?.likely === m.grade;
}

export function describeHuntMarket(m: HuntMarket) {
    const condition = m.condition ? CONDITION_NAMES[m.condition] : m.grader + " " + m.grade;
    const route = m.kind === "raw" && m.grader ? "after grading" : m.kind === "raw" ? "raw" : "slab";
    const printing = m.printing.replaceAll("_", " ").toLowerCase(), finish = m.finish.replaceAll("_", " ").toLowerCase();
    return m.sales30 + " matched sales in 30 days for " + m.name + " " + m.cardNumber + " (" + m.set + ", " + printing + " " + finish + ", " +
        condition + " " + route + "), with a median of " + dollars(m.medianUsd) + ".";
}

// A market median guides where to spend research. Each actual Buy still has to
// qualify against the copy's own verified sales, live terms and all costs.
export function marketItemLimit(m: HuntMarket, goal: DealHuntGoal, targets: Targets, shipping: number) {
    if (goal === "collect_slab") return m.medianUsd;
    const config = { ...MONEY_CONFIG, targets };
    let fixedCosts = 0;
    if (m.kind === "raw" && m.grader) {
        if (m.grader !== "PSA" && m.grader !== "CGC") return 0;
        const tier = gradingTier(m.grader, m.medianUsd, config.grading);
        if (!tier) return 0;
        fixedCosts = tier.fee + config.grading.shippingPerCard;
    }
    const expectedNet = netFromSale(m.medianUsd, m.condition ? "raw" : "graded", config.selling);
    return maxBid({ expectedNet, fixedCosts, shipping }, config);
}

export function shortlistMarketCopies(listings: ListingSummary[], market: HuntMarket, goal: DealHuntGoal, targets: Targets, filters: ListingFilters) {
    const delivered = (row: ListingSummary) => acquisitionCost(row.currentPrice!, row.shipping ?? 0, MONEY_CONFIG.buying);
    return listings.filter(row => row.currentPrice !== null && row.currentPrice > 0 &&
        row.currentPrice <= marketItemLimit(market, goal, targets, row.shipping ?? 0) &&
        delivered(row) <= (filters.maxPrice ?? Infinity) && (goal !== "collect_slab" || delivered(row) <= market.medianUsd))
        .sort((a, b) => delivered(a) - delivered(b) || a.id.localeCompare(b.id));
}
