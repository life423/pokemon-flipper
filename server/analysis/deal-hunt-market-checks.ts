import { cardLanguageStatus } from "../../shared/card-language.ts";
import { normalizeCardNumber, sameCardNumber } from "../../shared/card-number.ts";
import { CONDITION_NAMES } from "../../shared/conditions.ts";
import type { DealHuntGoal } from "../../shared/deal-hunt.ts";
import { dollars } from "../../shared/format.ts";
import { isPrinting, readyForPricing } from "../../shared/identity.ts";
import type { ListingFilters } from "../../shared/listing-filters.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost, gradingTier, maxBid, netFromSale } from "../../shared/money/underwriting.ts";
import { affordableBidLimit } from "../../shared/auction-opportunity.ts";
import { confirmedPhotoCard, observedCardKind } from "../../shared/photo-evidence.ts";
import type { Evaluation, ListingSummary, SearchIntent, Targets } from "../../shared/types.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { matchesGallerySubset } from "../identity/screening-name.ts";
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

export function matchesHuntMarket(e: Evaluation, m: HuntMarket, pendingPrinting = false, lookingForRawGrading = false) {
    const id = e.identity;
    if (!id || !pendingPrinting && (!readyForPricing(id) || id.printing !== m.printing) || id.finish !== m.finish ||
        !(sameSetFamily(id.set, m.set) || matchesGallerySubset(id.set, id.cardNumber, m.set, m.cardNumber)) ||
        !sameCardNumber(id.cardNumber, m.cardNumber) || !sameCatalogName(id.name, m.name)) return false;
    if (m.kind === "slab") return observedCardKind(e) === "graded" && e.slab?.grader === m.grader && Number(e.slab?.grade) === m.grade;
    if (observedCardKind(e) !== "raw") return false;
    // A graded exit identifies a card worth inspecting. The new copy gets its own photo grade and sale comparisons.
    if (lookingForRawGrading && m.grader && !m.condition) return true;
    return m.condition ? e.condition?.rawCondition === m.condition : e.condition?.gradeRange?.likely === m.grade;
}

// A collector-number query can retrieve unnamed or unrelated cards. Confirm each
// alternate-query find from the actual front before crediting it to this market.
export function photoMatchesCollectorMarket(e: Evaluation, m: HuntMarket): boolean {
    const check = e.photoCheck, photo = confirmedPhotoCard(check);
    if (!check || !photo?.evidence?.some(note => note.trim()) || e.identity?.notThisCard ||
        e.condition?.authenticity?.concern === "LIKELY_FAKE" || check.slab?.authenticity === "LIKELY_FAKE" ||
        check.cardMatch?.verdict === "MISMATCH" || !matchesHuntMarket(e, m, false, true)) return false;
    const names = [photo.name, check.printedName].filter((v): v is string => !!v?.trim());
    const numbers = [photo.cardNumber, check.printedNumber].filter((v): v is string => !!v?.trim());
    if (!names.length || !names.every(name => sameCatalogName(name, m.name)) ||
        !numbers.length || !numbers.every(number => sameCardNumber(number, m.cardNumber))) return false;
    if (photo.set) {
        if (!sameSetFamily(photo.set, m.set) && !matchesGallerySubset(photo.set, photo.cardNumber, m.set, m.cardNumber)) return false;
    } else if (normalizeCardNumber(m.cardNumber)?.total == null || !numbers.some(number => normalizeCardNumber(number)?.total != null)) return false;
    if (photo.finish !== m.finish || cardLanguageStatus("", [photo.language]) !== "ENGLISH" ||
        cardLanguageStatus(e.listing.title, [e.listing.aspects?.Language, e.identity?.language]) === "OTHER") return false;
    const observedPrinting = e.identity?.evidence?.photo;
    return isPrinting(observedPrinting) ? observedPrinting === m.printing : e.identity?.hasEditions === false && m.printing === "UNLIMITED";
}

export function describeHuntMarket(m: HuntMarket) {
    const condition = m.condition ? CONDITION_NAMES[m.condition] : m.grader + " " + m.grade;
    const route = m.kind === "raw" && m.grader ? "after grading" : m.kind === "raw" ? "raw" : "slab";
    const printing = m.printing.replaceAll("_", " ").toLowerCase(), finish = m.finish.replaceAll("_", " ").toLowerCase();
    const count = m.sales60 ?? m.sales30;
    const days = m.sales60 === undefined ? 30 : 60;
    const value = m.valueBasis?.startsWith("TCGPLAYER_") ? "TCGplayer estimate" : "matched sale estimate";
    return count + (count === 1 ? " observed matching sale" : " observed matching sales") + " in " + days + " days for " + m.name + " " + m.cardNumber + " (" + m.set + ", " + printing + " " + finish + ", " +
        condition + " " + route + "), with a " + value + " of " + dollars(m.medianUsd) + "." +
        (m.valueBasis?.startsWith("TCGPLAYER_") ? " Current offers are not counted as sales." : "");
}

// A market median guides where to spend research. Each actual Buy still has to
// qualify against the copy's own verified sales, live terms and all costs.
export function marketItemLimit(m: HuntMarket, goal: DealHuntGoal, targets: Targets, shipping: number) {
    if (goal === "collect_slab") return affordableBidLimit(m.medianUsd, shipping, m.medianUsd);
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
