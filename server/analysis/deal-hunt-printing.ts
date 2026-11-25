import { nextAuctionBid, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { printingName, readyForPricing } from "../../shared/identity.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import type { Evaluation } from "../../shared/types.ts";
import { needsBaseSetFrame } from "./base-set-frame.ts";
import { currentReleaseReading, needsReleaseReading } from "../../shared/base-set-release.ts";
import { hasFreshStampTerms, ordinaryNeoStamp, stampCandidate, STAMP_TERMS_MAX_AGE_MS } from "./stamp-decision.ts";

export function huntPrintingCheck(value: Evaluation) {
    if (needsReleaseReading(value) &&
        value.condition?.authenticity.concern === "NONE_SEEN" && !value.frontPhotoStop &&
        value.photoCheck?.images.some(p => p.view === "FRONT" && p.usable && !p.isStockImage && value.listing.photos?.[p.number - 1]))
        return "release";
    if (value.focusedPrinting || readyForPricing(value.identity)) return null;
    const stamp = stampCandidate(value);
    if (value.focusedStamp && !(value.focusedStamp.result === "CANT_TELL" && !value.focusedStamp.method &&
        stamp && ordinaryNeoStamp(value, stamp))) return null;
    if (stamp && value.photoCheck?.images.some(image => image.view === "FRONT" && image.usable &&
        !image.isStockImage && value.listing.photos?.[image.number - 1])) return "stamp";
    return needsBaseSetFrame(value) ? "frame" : null;
}

export function huntPrintingTerms(listing: Evaluation["listing"], now: number, maxDelivered?: number) {
    const age = now - Date.parse(listing.termsCheckedAt ?? "");
    const bid = listing.buyingOption === "AUCTION" && withinOpportunityWindow(listing.endTime, now) &&
        listing.availability === "ACTIVE" && age >= 0 && age < STAMP_TERMS_MAX_AGE_MS
        ? nextAuctionBid(listing, now) : null;
    const item = hasFreshStampTerms(listing, now) ? listing.price : bid;
    return item !== null && listing.shipping !== null && Number.isFinite(listing.shipping) && listing.shipping >= 0 &&
        acquisitionCost(item, listing.shipping, MONEY_CONFIG.buying) <= (maxDelivered ?? Infinity);
}

export function huntPrintingObservation(value: Evaluation) {
    const set = value.photoCheck?.cardIdentity?.set ?? value.identity?.set ?? "this set";
    const source = value.focusedStamp ?? value.focusedPrinting;
    const edition = value.identity;
    if (source && edition && readyForPricing(edition))
        return `The focused check of original photo ${source.photoNumber} and the ${set} printing rules identify ${printingName(edition.printing)}. Use the matching edition’s sales.`;
    if (source) return `Original photo ${source.photoNumber} and the available listing evidence did not settle the ${set} printing. No edition premium is supported.`;
    const release = currentReleaseReading(value);
    if (release) return `Photo ${release.photoNumber}: ${release.observation}`;
    return `No eligible original detail settled the ${set} printing under the current listing terms.`;
}
