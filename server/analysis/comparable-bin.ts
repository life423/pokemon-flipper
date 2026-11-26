import { confirmedPhotoCard, observedCardKind, photoCoverage } from "../../shared/photo-evidence.ts";
import { isRawCondition } from "../../shared/conditions.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { deeperPhotoConcerns } from "../../shared/photo-review.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import type { Evaluation } from "../../shared/types.ts";
import { huntPhotoIdentityIssue } from "./deal-hunt-market-checks.ts";
import type { CompetingAsk } from "../../shared/money/competitive-resale.ts";

function conditionMarket(e: Evaluation) {
    if (huntPhotoIdentityIssue(e) || e.identity?.notThisCard || unsupportedVariantReason(e) || releaseIssue(e) ||
        e.frontPhotoStop || deeperPhotoConcerns(e).length) return null;
    if (observedCardKind(e) === "graded") return verifiedSlabMarketKey(e);
    const wear = e.condition, coverage = photoCoverage(e.photoCheck), identity = e.identity;
    if (observedCardKind(e) !== "raw" || !identity?.recordId || !isRawCondition(wear?.rawCondition) || !confirmedPhotoCard(e.photoCheck) ||
        !coverage.clearFronts || !coverage.clearBacks || !wear || !["MEDIUM", "HIGH"].includes(wear.confidence) ||
        wear.authenticity.concern !== "NONE_SEEN" || wear.creases === "SUSPECTED") return null;
    return JSON.stringify([identity.recordId, identity.printing, identity.finish, wear.rawCondition]);
}

export function lowestComparableBin(target: Evaluation, others: Iterable<Evaluation>, now: number): CompetingAsk | undefined {
    const key = conditionMarket(target), own = parseListingLink(target.listing.id);
    if (!key || !own) return;
    let best: CompetingAsk | undefined;
    for (const other of others) {
        const l = other.listing, link = parseListingLink(l.id), age = now - Date.parse(l.termsCheckedAt ?? "");
        if (!link || link.itemId.split("|")[1] === own.itemId.split("|")[1] || l.buyingOption !== "FIXED_PRICE" ||
            l.availability !== "ACTIVE" || l.endTime && !(Date.parse(l.endTime) > now) ||
            !(age >= 0 && age < BEST_BUY_TERMS_MAX_AGE_MS) || (l.shippingDestination ?? null) !== (target.listing.shippingDestination ?? null) ||
            !(l.price !== null && Number.isFinite(l.price) && l.price > 0 && l.shipping !== null && Number.isFinite(l.shipping) && l.shipping >= 0) ||
            (target.slab?.certNumber && other.slab?.certNumber === target.slab.certNumber) || conditionMarket(other) !== key) continue;
        const delivered = Math.round((l.price + l.shipping) * 100) / 100;
        if (!best || delivered < best.delivered) best = { listingId: link.itemId, delivered, checkedAt: l.termsCheckedAt! };
    }
    return best;
}
