import type { Evaluation } from "../../shared/types.ts";
import { readTitleByRules } from "../ai/title-reader.ts";
import { lookupCachedCards } from "../pricing/pkmnprices.ts";
import { canRecheckCatalogIdentity, confirmedNumberedSellerName, identifyCard, readyForPricing } from "./card-identity.ts";

// Rebuild a derived identity from retained physical observations and the
// existing exact catalog only. This never requests a new photo or price.
export async function recheckSavedCatalogIdentity(value: Evaluation, lookupCards = lookupCachedCards): Promise<Evaluation> {
    const photos = value.photoCheck;
    if (!photos || readyForPricing(value.identity) || value.frontPhotoStop === "AUTHENTICITY" ||
        value.condition?.authenticity.concern === "LIKELY_FAKE" || value.slab?.status === "LIKELY_FAKE" ||
        value.deeperPhotoReview?.findings.some(finding => finding.impact === "NEW_CONCERN") ||
        !canRecheckCatalogIdentity(value.listing, photos, readTitleByRules)) return value;

    const { identity, card, corroboratedClaimsAwaitCatalog, sellerClaimsCorrected } = await identifyCard(value.listing, photos, { lookupCards, readTitle: readTitleByRules });
    const replacesFalseRejection = value.identity?.notThisCard && (corroboratedClaimsAwaitCatalog || sellerClaimsCorrected ||
        value.identity.notThisCard === "the photos show " + photos.cardIdentity?.name + " #" + photos.cardIdentity?.cardNumber +
            " from " + photos.cardIdentity?.set && confirmedNumberedSellerName(value.listing, photos));
    if (identity.notThisCard || !replacesFalseRejection && (!card || !readyForPricing(identity))) return value;
    return { ...value, identity, pricesCheckedAt: undefined, rawPricing: null, gradedPricing: null, slabPricing: null,
        trackerRawReference: undefined, trackerPriceReference: undefined, webPriceResearch: undefined, supplementalPriceNote: undefined,
        pricingDeferred: undefined, marketActivity: undefined, underwriting: null, rating: null };
}
