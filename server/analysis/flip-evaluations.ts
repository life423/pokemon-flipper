import { normalizeCardNumber } from "../../shared/card-number.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { isRawCondition } from "../../shared/conditions.ts";
import { releaseIssue } from "../../shared/base-set-release.ts";
import { parseListingLink } from "../../shared/listing-link.ts";
import { deeperPhotoConcerns } from "../../shared/photo-review.ts";
import { unsupportedVariantReason } from "../../shared/money/price-evidence.ts";
import type { ComparableAsk } from "../../shared/money/relist-estimate.ts";
import { verifiedSlabMarketKey } from "../../shared/slab-market.ts";
import { observedCardKind, photoCoverage } from "../../shared/photo-evidence.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { setKey } from "../../shared/sets.ts";
import type { Evaluation, PricedPath } from "../../shared/types.ts";
import { canonicalCatalogName } from "../identity/catalog-name.ts";
import { huntPhotoIdentityIssue } from "./deal-hunt-market-checks.ts";

export function verifiedCopyMarket(value: Evaluation) {
    if (value.identity?.notThisCard || huntPhotoIdentityIssue(value) || releaseIssue(value) || unsupportedVariantReason(value) ||
        value.frontPhotoStop || deeperPhotoConcerns(value).length) return null;
    const kind = observedCardKind(value);
    if (kind === "graded") return verifiedSlabMarketKey(value);
    const condition = value.condition, coverage = photoCoverage(value.photoCheck);
    if (kind !== "raw" || !value.identity?.recordId || !isRawCondition(condition?.rawCondition) ||
        !coverage.clearFronts || !coverage.clearBacks || !condition || !["HIGH", "MEDIUM"].includes(condition.confidence) ||
        condition.authenticity.concern !== "NONE_SEEN" || condition.creases === "SUSPECTED") return null;
    const id = value.identity;
    if (!id.name || !id.set || !id.cardNumber) return null;
    return JSON.stringify([id.recordId, canonicalCatalogName(id.name), setKey(id.set), normalizeCardNumber(id.cardNumber),
        id.printing, id.finish, "RAW", condition.rawCondition]);
}

// The research queue already stores accepted copies. Index them as they change
// so describing competition does not rescan the queue or fetch more listings.
export class FlipEvaluations extends Map<string, Evaluation> {
    private readonly marketForCopy = new Map<string, string>();
    private readonly copiesForMarket = new Map<string, Map<string, number>>();

    override set(id: string, value: Evaluation): this {
        this.delete(id);
        super.set(id, value);
        const listing = value.listing;
        if (listing.buyingOption !== "FIXED_PRICE" || listing.availability !== "ACTIVE" || value.identity?.notThisCard ||
            value.condition?.authenticity?.concern === "LIKELY_FAKE" || value.photoCheck?.slab?.authenticity === "LIKELY_FAKE" ||
            cardLanguageStatus(listing.title, [value.identity?.language]) !== "ENGLISH") return this;
        const checked = Date.parse(listing.termsCheckedAt ?? "");
        const end = listing.endTime ? Date.parse(listing.endTime) : Infinity;
        const expires = Math.min(checked + BEST_BUY_TERMS_MAX_AGE_MS, end);
        if (!Number.isFinite(expires)) return this;
        const key = verifiedCopyMarket(value);
        if (key) {
            this.marketForCopy.set(id, key);
            const copies = this.copiesForMarket.get(key) ?? new Map<string, number>();
            copies.set(id, expires);
            this.copiesForMarket.set(key, copies);
        }
        return this;
    }

    override delete(id: string): boolean {
        const key = this.marketForCopy.get(id);
        if (key) {
            const copies = this.copiesForMarket.get(key)!;
            copies.delete(id);
            if (!copies.size) this.copiesForMarket.delete(key);
            this.marketForCopy.delete(id);
        }
        return super.delete(id);
    }

    override clear(): void {
        super.clear();
        this.marketForCopy.clear();
        this.copiesForMarket.clear();
    }

    competingCopies(value: Evaluation, path: PricedPath | null, now: number) {
        const key = path?.path === "GRADE" || path?.path === "RAW" && path.priceCondition !== value.condition?.rawCondition
            ? null : verifiedCopyMarket(value);
        const own = parseListingLink(value.listing.id)?.itemId.split("|")[1];
        let cheapest: ComparableAsk | null = null;
        const distinct = new Set<string>();
        for (const [id, expires] of key && own ? this.copiesForMarket.get(key) ?? [] : []) {
            const peer = this.get(id), listing = peer?.listing;
            const item = parseListingLink(id)?.itemId.split("|")[1];
            if (!listing || !item || item === own || !(Date.parse(listing.termsCheckedAt ?? "") <= now && expires > now) ||
                (listing.shippingDestination ?? null) !== (value.listing.shippingDestination ?? null) ||
                value.slab?.certNumber && peer?.slab?.certNumber === value.slab.certNumber) continue;
            distinct.add(item);
            if (listing.price == null || !(listing.price > 0) || listing.shipping == null || !(listing.shipping >= 0) ||
                peer?.underwriting?.shippingUnconfirmed) continue;
            const delivered = Math.round((listing.price + listing.shipping) * 100) / 100;
            if (Number.isFinite(delivered) && (!cheapest || delivered < cheapest.delivered)) {
                cheapest = { delivered, listingId: id, checkedAt: listing.termsCheckedAt!, validUntil: expires,
                    destination: listing.shippingDestination ?? null };
            }
        }
        return { count: distinct.size, cheapest };
    }
}
