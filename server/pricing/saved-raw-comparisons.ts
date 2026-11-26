import { isRawCondition, sellerCreaseOverridesCondition } from "../../shared/conditions.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { isRawSoldPrice, unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import type { Evaluation, RawPricing } from "../../shared/types.ts";
import { createSoldConditionAcquirer } from "../ai/sold-condition.ts";
import { mergeFamily, sameCardNumber, sameSetFamily } from "../identity/card-identity.ts";
import { sameCatalogName } from "../identity/catalog-name.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { cachedPricingRecord, fetchCachedRawComps } from "./pkmnprices.ts";
import { rawPricesWithSales } from "./raw-comps.ts";

const share = createSharedWork();

// A photo check on one sold copy can price other listings in the same market.
// Rebuild only the missing condition bucket. The listing and its quote retain
// their original timestamps, even when eBay cannot refresh the purchase terms.
export async function restoreRawComparisons(e: Evaluation, now: number, signal?: AbortSignal): Promise<RawPricing | null> {
    const id = e.identity, raw = e.rawPricing, wear = e.condition?.rawCondition;
    if (!readyForPricing(id) || !id?.recordId || !isRawCondition(wear) || !raw?.variant || raw.source !== "pkmnprices" ||
        raw.printing !== id.printing || raw.finish !== id.finish || (raw.conditionEvidence !== "AI_PHOTOS" && !raw.tcgplayerComparison) ||
        e.photoCheck?.cardMatch?.verdict !== "MATCH" || e.slab || e.frontPhotoStop || e.pricingDeferred ||
        e.condition?.authenticity.concern !== "NONE_SEEN" || e.condition.creases === "SUSPECTED" ||
        sellerCreaseOverridesCondition(wear, e.listing.conditionNotes) || unsupportedVariantReason(e) ||
        raw.prices?.some(p => p.condition === wear && isRawSoldPrice(p))) return null;
    const key = JSON.stringify([id.recordId, id.name, id.set, id.cardNumber, id.language, id.printing, id.finish, raw.variant, wear]);
    const rebuilt = await share(key, async active => {
        const record = await cachedPricingRecord(String(id.recordId));
        if (!record || !sameCatalogName(record.name, id.name) || !sameSetFamily(record.setName, id.set) ||
            !sameCardNumber(record.cardNumber, id.cardNumber)) return null;
        const sold = createSoldConditionAcquirer({ condition: wear });
        const market = await rawPricesWithSales(mergeFamily([record]), id, {
            now, signal: active, requestedCondition: wear, fetchRawComps: fetchCachedRawComps,
            assessCondition: sold.read, conditionStatus: sold.status,
        });
        return market.variant === raw.variant ? market : null;
    }, signal);
    const price = rebuilt?.prices?.find(p => p.condition === wear && p.comps?.count && isRawSoldPrice(p));
    if (!price?.comps) return null;
    return { ...raw, status: "PRICED", conditionEvidence: "AI_PHOTOS", reason: undefined, evidenceNote: rebuilt?.evidenceNote,
        reviewedSoldCopies: rebuilt?.reviewedSoldCopies, sampledSoldCopies: rebuilt?.sampledSoldCopies, soldPhotoDeferred: undefined,
        sellerConditionComps: rebuilt?.sellerConditionComps,
        prices: [...(raw.prices ?? []).filter(p => p.condition !== wear), price],
        ebayComps: [...(raw.ebayComps ?? []).filter(s => s.grade !== wear), price.comps] };
}
