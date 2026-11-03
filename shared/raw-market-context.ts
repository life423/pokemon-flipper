import { cardLanguageStatus } from "./card-language.ts";
import { sellerConditionClues } from "./raw-condition-claim.ts";
import { usableSoldReference, soldReferenceScope } from "./sold-evidence.ts";
import { cents } from "./money/cents.ts";
import { setKey } from "./sets.ts";
import type { ListingSummary } from "./types.ts";

export interface RawMarketContext {
    scope: string;
    median: number;
    deliveredAsking: number;
    askingToSoldMedian: number;
    caution: "UNUSUALLY_LOW" | "SELLER_DAMAGE" | "SELLER_CONDITION_CONFLICT" | null;
}

// Research order only. Unspecified sold-copy condition cannot establish the
// live card's resale value, profit, safe bid or potential PSA/CGC grade.
export function rawMarketContext(listing: ListingSummary, now = Date.now()): RawMarketContext | null {
    const evidence = listing.screen?.soldEvidence;
    const price = listing.currentPrice, shipping = listing.shipping;
    if (listing.isGraded || listing.buyingOption !== "FIXED_PRICE" || listing.match || listing.availability === "UNAVAILABLE" ||
        listing.screen?.status === "DROPPED" || listing.screen?.junk || cardLanguageStatus(listing.title) === "OTHER" ||
        listing.screen?.priceAnomaly && !listing.screen.priceAnomaly.photoChecked ||
        !evidence?.exactScope || evidence.status !== "AVAILABLE" || !evidence.references.length ||
        price === null || !Number.isFinite(price) || price <= 0 || shipping === null || !Number.isFinite(shipping) || shipping < 0) return null;
    // An unusable second market must not disappear and make the remaining
    // cheaper printing or finish look uniquely applicable.
    if (new Set(evidence.references.map(soldReferenceScope)).size !== 1) return null;
    const references = evidence.references.filter(reference => reference.condition === null && usableSoldReference(reference, false) &&
        reference.summary.windowDays! <= 90);
    if (references.length !== 1) return null;
    const reference = references[0];
    const normalizeName = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    const numberKey = (value: string) => value.toUpperCase().replace(/[#\s]/g, "").replace(/\d+/g, digits => digits.replace(/^0+(?=\d)/, ""));
    const claimed = listing.screen?.card;
    if (claimed?.name && normalizeName(claimed.name) !== normalizeName(reference.name) ||
        claimed?.set && setKey(claimed.set) !== setKey(reference.set) ||
        claimed?.cardNumber && numberKey(claimed.cardNumber) !== numberKey(reference.cardNumber) ||
        claimed?.printing && claimed.printing !== "UNKNOWN" && claimed.printing !== reference.printing ||
        listing.listedAttributes?.finish && listing.listedAttributes.finish !== reference.finish) return null;
    const newest = Date.parse(reference.summary.newestSale ?? "");
    if (!Number.isFinite(newest) || newest > now || now - newest > 90 * 86_400_000) return null;
    const deliveredCents = cents(price) + cents(shipping), medianCents = cents(reference.summary.median!);
    if (!Number.isSafeInteger(deliveredCents) || deliveredCents <= 0 || !Number.isSafeInteger(medianCents) || medianCents <= 0) return null;
    const condition = sellerConditionClues(listing);
    return { scope: soldReferenceScope(reference), median: reference.summary.median!, deliveredAsking: deliveredCents / 100,
        askingToSoldMedian: deliveredCents / medianCents,
        // The same twenty-percent scale used by preliminary anomaly research:
        // an implausibly tiny ask remains inspectable but earns no ratio boost.
        caution: deliveredCents < medianCents * 0.2 ? "UNUSUALLY_LOW"
            : condition.severe ? "SELLER_DAMAGE" : condition.conflict ? "SELLER_CONDITION_CONFLICT" : null };
}
