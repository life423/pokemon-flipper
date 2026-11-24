import { cardLanguageStatus } from "../../../shared/card-language.ts";
import { compareCardNumbers, normalizeCardNumber } from "../../../shared/card-number.ts";
import { conditionGap, isRawCondition, sellerDisclosedCreasing, type RawCondition } from "../../../shared/conditions.ts";
import { listingEvidenceKey, searchPhotosFitDetails } from "../../../shared/listing-evidence.ts";
import { parseListingLink } from "../../../shared/listing-link.ts";
import { cents } from "../../../shared/money/cents.ts";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { unsupportedVariantReason } from "../../../shared/money/price-evidence.ts";
import { acquisitionCost } from "../../../shared/money/underwriting.ts";
import { confirmedPhotoCard, observedCardKind, photoCoverage } from "../../../shared/photo-evidence.ts";
import { hasBaseSetFourthPrint } from "../../../shared/reprint-release.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import { setKey } from "../../../shared/sets.ts";
import { verifiedSlabMarketKey } from "../../../shared/slab-market.ts";
import type { BinderAppearance, Identity, ListingSummary, SearchIntent } from "../../../shared/types.ts";
import type { AnalysisState } from "../analysis-state.ts";
import { checkedTerms, eligibleAssessedListing } from "./results.ts";

// Verified side-by-side against the English card scans at images.pokemontcg.io
// for base1 (Base Set) and base4 (Base Set 2). The foil patterns differ.
const BASE_ART_PAIRS: Record<string, [number, number]> = {
    alakazam: [1, 1], blastoise: [2, 2], chansey: [3, 3], charizard: [4, 4],
    gyarados: [6, 7], mewtwo: [10, 10], ninetales: [12, 13], venusaur: [15, 18],
};

export function artworkCounterpart(id: Identity) {
    if (!id.name || !id.set || id.finish !== "HOLO" || cardLanguageStatus("", [id.language]) !== "ENGLISH") return null;
    const name = id.name.toLowerCase().trim(), pair = BASE_ART_PAIRS[name];
    const set = setKey(id.set), number = normalizeCardNumber(id.cardNumber);
    if (!pair || !number || number.numberPrefix || number.totalPrefix) return null;
    if (set === "base set" && number.number === pair[0] && number.total === 102) {
        return { name: id.name, set: "Base Set 2", number: `${pair[1]}/130` };
    }
    if (set === "base set 2" && number.number === pair[1] && number.total === 130 && id.printing === "UNLIMITED") {
        return { name: id.name, set: "Base Set", number: `${pair[0]}/102` };
    }
    return null;
}

export interface CollectorCopy {
    id: string;
    identity: Identity;
    market: string;
    total: number;
    checkedAt: string;
    evidence: string;
    sellerCondition: string | null;
    disclosures: string[];
    quality: string;
    rawCondition: RawCondition | null;
    binder?: BinderAppearance;
    front?: string;
    back?: string;
}

export function collectorCopies(listings: ListingSummary[], analyses: Record<string, AnalysisState>, intent: SearchIntent | null | undefined, now: number): CollectorCopy[] {
    const copies: CollectorCopy[] = [];
    for (const listing of listings) {
        const value = eligibleAssessedListing(listing, analyses[listing.id], intent, now);
        const id = value?.identity;
        if (!value || !id?.name || !id.set || cardLanguageStatus("", [id.language]) !== "ENGLISH" || unsupportedVariantReason(value) ||
            hasBaseSetFourthPrint(id.set, listing.title, value.slab?.labelText) || value.listing.title.trim() !== listing.title.trim() ||
            !searchPhotosFitDetails(listing.images, value.listing.photos ?? [])) continue;
        const terms = checkedTerms(listing, value, now);
        if (!terms) continue;
        const market = JSON.stringify([id.name.trim().toLowerCase(), setKey(id.set), normalizeCardNumber(id.cardNumber), id.printing, id.finish]);
        const copy = {
            id: listing.id, identity: id, market, total: acquisitionCost(terms.price, terms.shipping, MONEY_CONFIG.buying),
            checkedAt: value.listing.termsCheckedAt!, evidence: listingEvidenceKey({ title: value.listing.title, images: value.listing.photos ?? [] }),
            sellerCondition: value.listing.cardCondition ?? null, disclosures: value.listing.conditionNotes ?? [],
        };
        if (value.slab) {
            if (verifiedSlabMarketKey(value)) copies.push({ ...copy, quality: `${value.slab.grader} ${Number(value.slab.grade)}`, rawCondition: null });
            continue;
        }
        const condition = value.condition;
        if (!condition || !isRawCondition(condition.rawCondition) || observedCardKind(value) !== "raw" ||
            condition.authenticity.concern !== "NONE_SEEN" || condition.creases !== "NONE_SEEN" || sellerDisclosedCreasing(value.listing.conditionNotes)) continue;
        const observed = confirmedPhotoCard(value.photoCheck);
        const numberMatches = compareCardNumbers(id.cardNumber, observed?.cardNumber);
        if (!observed?.evidence.length || observed.name?.trim().toLowerCase() !== id.name.trim().toLowerCase() ||
            observed.set && setKey(observed.set) !== setKey(id.set) || numberMatches === false ||
            !observed.set && !(numberMatches && normalizeCardNumber(observed.cardNumber)?.total) ||
            observed.finish !== id.finish || value.photoCheck?.cardMatch?.verdict === "MISMATCH") continue;
        const coverage = photoCoverage(value.photoCheck);
        if (!coverage.clearFronts || !coverage.clearBacks) continue;
        const photo = (view: string) => {
            const side = value.photoCheck?.images.find(img => img.view === view && img.usable && !img.isStockImage && img.obscuresCondition === false);
            return side && value.listing.photos?.[side.number - 1];
        };
        copies.push({ ...copy, quality: "Raw", rawCondition: condition.rawCondition, front: photo("FRONT"), back: photo("BACK"), binder: condition.binderAppearance });
    }
    return copies.sort((a, b) => a.total - b.total || a.id.localeCompare(b.id));
}

// Quote the cheapest cleaner copy in this printing. A cheaper cleaner copy
// disqualifies the bargain even when a second comparator is more expensive.
export function binderFind(copies: CollectorCopy[]) {
    for (const candidate of copies) {
        if (!candidate.rawCondition || !candidate.front || !candidate.back || candidate.binder?.front !== "CLEAN" ||
            candidate.binder.back !== "WORN" || !candidate.binder.backEvidence?.trim() || !candidate.binder.frontEvidence?.trim() ||
            candidate.rawCondition === "DAMAGED") continue;
        const cleaner = copies.find(other => other.id !== candidate.id && other.market === candidate.market && other.front && other.back &&
            other.rawCondition && conditionGap(candidate.rawCondition!, other.rawCondition) < 0 &&
            other.binder?.front === "CLEAN" && other.binder.back === "CLEAN");
        if (cleaner && cents(cleaner.total) > cents(candidate.total)) {
            return { candidate, cleaner, saving: (cents(cleaner.total) - cents(candidate.total)) / 100 };
        }
    }
    return null;
}

// Refresh only the price and shipping of the original assessed copy. If the
// seller changed its photos or description, its old assessment cannot transfer.
export function refreshedCollectorQuote(original: CollectorCopy, listing: ListingSummary, now: number): CollectorCopy | null {
    const id = parseListingLink(original.id)?.itemId;
    const age = now - Date.parse(listing.termsCheckedAt ?? "");
    const { currentPrice, shipping } = listing;
    if (!id || id !== parseListingLink(listing.id)?.itemId || listing.buyingOption !== "FIXED_PRICE" ||
        listing.availability !== "ACTIVE" || listing.endTime && !(Date.parse(listing.endTime) > now) ||
        !Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS ||
        currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0 ||
        shipping === null || !Number.isFinite(shipping) || shipping < 0 || listingEvidenceKey(listing) !== original.evidence ||
        (listing.cardCondition ?? null) !== original.sellerCondition || JSON.stringify(listing.conditionNotes ?? []) !== JSON.stringify(original.disclosures)) return null;
    return { ...original, checkedAt: listing.termsCheckedAt!, total: acquisitionCost(currentPrice, shipping, MONEY_CONFIG.buying) };
}

export function comparableArtwork(anchor: CollectorCopy, copies: CollectorCopy[]) {
    const target = artworkCounterpart(anchor.identity);
    return target && copies.find(copy => copy.id !== anchor.id && copy.quality === anchor.quality && !!artworkCounterpart(copy.identity) &&
        copy.identity.name?.trim().toLowerCase() === target.name.trim().toLowerCase() && setKey(copy.identity.set!) === setKey(target.set) &&
        (!anchor.rawCondition || copy.rawCondition && conditionGap(anchor.rawCondition, copy.rawCondition) <= 0)) || null;
}

export function cheaperArtwork(anchor: CollectorCopy, copies: CollectorCopy[], now: number) {
    const age = now - Date.parse(anchor.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age >= BEST_BUY_TERMS_MAX_AGE_MS) return null;
    const copy = comparableArtwork(anchor, copies);
    return copy && cents(copy.total) < cents(anchor.total) ? copy : null;
}
