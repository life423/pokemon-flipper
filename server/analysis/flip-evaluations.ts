import { normalizeCardNumber } from "../../shared/card-number.ts";
import { cardLanguageStatus } from "../../shared/card-language.ts";
import { isRawCondition } from "../../shared/conditions.ts";
import { observedCardKind } from "../../shared/photo-evidence.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import { setKey } from "../../shared/sets.ts";
import type { Evaluation, PricedPath } from "../../shared/types.ts";
import { canonicalCatalogName } from "../identity/catalog-name.ts";
import { huntPhotoIdentityIssue } from "./deal-hunt-market-checks.ts";

function marketKey(value: Evaluation, holder: string, gradeOrWear: string) {
    const id = value.identity;
    if (!id?.name || !id.set || !id.cardNumber || !holder || !gradeOrWear) return null;
    return JSON.stringify([canonicalCatalogName(id.name), setKey(id.set), normalizeCardNumber(id.cardNumber),
        id.printing, id.finish, holder, gradeOrWear]);
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
            cardLanguageStatus(listing.title, [value.identity?.language]) !== "ENGLISH" || huntPhotoIdentityIssue(value)) return this;
        const checked = Date.parse(listing.termsCheckedAt ?? "");
        const end = listing.endTime ? Date.parse(listing.endTime) : Infinity;
        const expires = Math.min(checked + BEST_BUY_TERMS_MAX_AGE_MS, end);
        if (!Number.isFinite(expires)) return this;
        const kind = observedCardKind(value);
        const key = kind === "graded" && value.slab ? marketKey(value, value.slab.grader ?? "", String(value.slab.grade ?? "")) :
            kind === "raw" && isRawCondition(value.condition?.rawCondition) ? marketKey(value, "RAW", value.condition.rawCondition) : null;
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

    competingCopies(value: Evaluation, path: PricedPath, now: number) {
        const key = path.path === "RAW" ? marketKey(value, "RAW", path.priceCondition ?? "") :
            path.path === "GRADE" ? marketKey(value, path.grader ?? "", String(value.condition?.gradeRange?.likely ?? "")) :
            marketKey(value, value.slab?.grader ?? "", String(value.slab?.grade ?? ""));
        const copies = key ? this.copiesForMarket.get(key) : undefined;
        let count = 0, lowestDelivered: number | null = null;
        for (const [id, expires] of copies ?? []) {
            const peer = this.get(id), listing = peer?.listing;
            if (!listing || id === value.listing.id || !(Date.parse(listing.termsCheckedAt ?? "") <= now && expires > now) ||
                (listing.shippingDestination ?? null) !== (value.listing.shippingDestination ?? null)) continue;
            count++;
            if (listing.price == null || !(listing.price > 0) || listing.shipping == null || !(listing.shipping >= 0) ||
                peer?.underwriting?.shippingUnconfirmed || peer?.deeperPhotoReview?.findings.some(f => f.impact === "NEW_CONCERN")) continue;
            const amount = Math.round((listing.price + listing.shipping) * 100) / 100;
            if (Number.isFinite(amount)) lowestDelivered = Math.min(lowestDelivered ?? Infinity, amount);
        }
        return { count, lowestDelivered };
    }
}
