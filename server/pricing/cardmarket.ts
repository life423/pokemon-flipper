import type { CardmarketComparison, CardmarketOffer } from "../../shared/cardmarket.ts";
import type { Evaluation } from "../../shared/types.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { sameCardNumber } from "../../shared/card-number.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { hasSpecialSlabTitle } from "../../shared/grade-qualifier.ts";
import { unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import { observedCardKind, obscuredDisclosedWear } from "../../shared/photo-evidence.ts";
import { deeperPhotoConcerns } from "../../shared/photo-review.ts";
import { hasBaseSetFourthPrint } from "../../shared/reprint-release.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "./search-name.ts";
import { cardmarketOfferPage, cardmarketRecord } from "./pkmnprices.ts";
import { latestEuroReference } from "./euro-reference.ts";

const day = 86_400_000;
const offerLimit = 5;
// Cardmarket documents only a rough translation between US and European played grades.
const rawConditions: Partial<Record<NonNullable<Evaluation["condition"]>["rawCondition"], string>> =
    { MINT: "Mint", NEAR_MINT: "Near Mint" };
const standardVariant = /^(?:(?:1st edition|shadowless|unlimited) )?(?:normal|holo(?:foil)?|reverse holo(?:foil)?)$|^(?:1st edition|unlimited)$/i;
const variantKey = (variant: string) => variant.toLowerCase().replace(/holofoil/g, "holo").trim();

type Market = { variant: string; condition: string | null; grader: string | null; grade: string | null };
function checkedOffer(row: unknown, market: Market, value: Evaluation, now: number): CardmarketOffer | null {
    if (!row || typeof row !== "object") return null;
    const item = row as Record<string, unknown>;
    const price = item.price, quantity = item.quantity;
    const articleId = String(item.article_id ?? "");
    const age = now - Date.parse(String(item.updated_at));
    const variant = typeof item.variant === "string" ? item.variant : "";
    if (!/^\d+$/.test(articleId) || typeof price !== "number" || !Number.isFinite(price) || price <= 0 ||
        typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0 || item.language !== "EN" ||
        item.currency !== undefined && item.currency !== "EUR" || item.signed !== false || item.altered !== false ||
        !Number.isFinite(age) || age < 0 || age >= 7 * day || variantKey(variant) !== variantKey(market.variant)) return null;
    const comment = typeof item.comment === "string" ? item.comment : "";
    if (/\b(?:reprint|proxy|replica|world championships?|no symbol|missing texture)\b/i.test(comment) ||
        hasBaseSetFourthPrint(value.identity?.set, comment) ||
        value.identity?.printing !== "FIRST_EDITION" && /\b(?:1st|first) ed(?:ition)?\b/i.test(comment) ||
        value.identity?.printing === "UNLIMITED" && /\bshadowless\b/i.test(comment)) return null;
    if (market.grader) {
        if (item.graded !== true || item.grader !== market.grader || String(item.grade) !== market.grade ||
            hasSpecialSlabTitle(comment)) return null;
    } else if (item.graded !== false || item.grader != null || item.grade != null || item.condition !== market.condition) return null;

    return { articleId, priceEur: price, updatedAt: new Date(now - age).toISOString(),
        condition: typeof item.condition === "string" ? item.condition : null, variant,
        grader: market.grader, grade: market.grade,
        sellerCountry: typeof item.seller_country === "string" && /^[A-Z]{2}$/.test(item.seller_country) ? item.seller_country : null };
}

export async function compareCardmarket(value: Evaluation, {
    record = cardmarketRecord, offers = cardmarketOfferPage, fx = latestEuroReference, now = Date.now,
} = {}): Promise<CardmarketComparison> {
    const asOf = now();
    const base = { checkedAt: new Date(asOf).toISOString(), currency: "EUR", basis: "ACTIVE_ASK" } as const;
    const unavailable = (reason: string): CardmarketComparison => ({ ...base, status: "UNAVAILABLE", reason, offers: [] });
    const identity = value.identity, recordId = String(identity?.recordId ?? "");
    const kind = observedCardKind(value);
    if (!identity?.name || !identity.set || !identity.cardNumber || !readyForPricing(identity) || identity.notThisCard ||
        !/^\d+$/.test(recordId) || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish) ||
        cardLanguageStatus("", [identity.language, value.photoCheck?.cardIdentity?.language]) !== "ENGLISH" ||
        cardLanguageStatus(value.listing.title, [value.listing.aspects.Language]) === "OTHER" ||
        !kind || value.photoCheck?.cardMatch?.verdict === "MISMATCH" || unsupportedVariantReason(value) ||
        hasBaseSetFourthPrint(identity.set, value.listing.title) || deeperPhotoConcerns(value).length) {
        return unavailable("An exact, photo-assessed English printing and PKMNPrices record are needed to check Cardmarket.");
    }
    const slab = value.slab;
    if (kind === "graded" && !verifiedSlabMarketKey(value)) return unavailable("The slab needs a verified standard label and grade.");
    const condition = value.condition?.rawCondition;
    const nativeCondition = condition ? rawConditions[condition] ?? null : null;
    if (kind === "raw" && !nativeCondition) {
        return unavailable("This raw condition has no exact Cardmarket comparison. US and Cardmarket played grades use different standards.");
    }
    if (kind === "raw" && (slab || obscuredDisclosedWear(value) || value.condition?.authenticity?.concern !== "NONE_SEEN")) {
        return unavailable("The photos and disclosures need to support the raw card’s condition and authenticity.");
    }
    const card = await record(recordId);
    if (!card?.setName || String(card.id) !== recordId || !sameCatalogName(card.name, identity.name) ||
        !sameSetFamily(card.setName, identity.set) || !sameCardNumber(card.cardNumber, identity.cardNumber)) {
        return unavailable("The PKMNPrices catalog record could not confirm this exact card.");
    }
    const variants = card.variants.filter(v => v.printing === identity.printing && v.finish === identity.finish && standardVariant.test(v.name));
    if (variants.length !== 1 || identity.printing === "SHADOWLESS" && !/shadowless/i.test(variants[0]!.name)) {
        return unavailable("Cardmarket needs an unambiguous offer variant for the assessed printing and finish.");
    }
    const market: Market = { variant: variants[0]!.name, condition: kind === "raw" ? nativeCondition : null,
        grader: kind === "graded" ? slab!.grader : null, grade: kind === "graded" ? slab!.grade : null };
    const params = new URLSearchParams({ variant: market.variant, graded: String(kind === "graded"), signed: "false", altered: "false",
        sort: "price_asc", limit: String(offerLimit) });
    if (market.grader && market.grade) { params.set("grader", market.grader); params.set("grade", market.grade); }
    if (market.condition) params.set("condition", market.condition);
    const rows = await offers(recordId, params);
    const exact = new Map<string, CardmarketOffer>();
    for (const row of rows.slice(0, offerLimit)) {
        const offer = checkedOffer(row, market, value, asOf);
        if (offer) exact.set(offer.articleId, offer);
    }
    if (!exact.size) return unavailable(rows.length ? "The checked Cardmarket offers had no fresh, exact match." :
        "Cardmarket returned no active offers for the exact printing and condition or slab grade.");
    return { ...base, status: "AVAILABLE", reason: null, offers: [...exact.values()].sort((a, b) => a.priceEur - b.priceEur), fx: await fx() };
}
