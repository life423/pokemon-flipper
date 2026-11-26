import { currentQuote } from "../../shared/fresh-listing.ts";
import { createHash } from "node:crypto";
import { auctionOpportunity, currentAuctionMarket, withinOpportunityWindow } from "../../shared/auction-opportunity.ts";
import { resultGroup } from "../../shared/analysis.ts";
import type { DealHuntAction } from "../../shared/deal-hunt.ts";
import { englishListingEligible } from "../../shared/card-language.ts";
import { CONDITION_NAMES, isRawCondition } from "../../shared/conditions.ts";
import { dollars } from "../../shared/format.ts";
import { readyForPricing } from "../../shared/identity.ts";
import { searchPhotosFitDetails } from "../../shared/listing-evidence.ts";
import { matchesListingFilters } from "../../shared/listing-filters.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import { rawBuyGuidance, savedRawPriceContext } from "../../shared/money/raw-buy-guidance.ts";
import { slabBuyGuidance } from "../../shared/money/slab-buy-guidance.ts";
import { acquisitionCost } from "../../shared/money/underwriting.ts";
import { cents } from "../../shared/money/cents.ts";
import { offerFor, offerWorthMaking, type OfferPlan } from "../../shared/money/offer.ts";
import { priceEvidenceGap } from "../../shared/money/price-evidence.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { configuredShippingZip } from "../ebay/shipping-destination.ts";
import { recheckSavedCatalogIdentity } from "../identity/saved-catalog-identity.ts";
import { baseSetLookalike, needsReleaseReading, releaseIssue } from "../../shared/base-set-release.ts";
import { needsWholeBack, observedCardKind } from "../../shared/photo-evidence.ts";
import { photoReviewStatus, planDeeperPhotos, printingReviewReasons } from "../../shared/photo-review.ts";
import { currentPriceEvidence } from "../../shared/pricing-freshness.ts";
import { SALES_ACTIVITY_DAYS } from "../../shared/sales-activity.ts";
import { evaluatedCriteriaMismatch } from "../../shared/search-criteria.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../shared/search-diagnostic.ts";
import type { Evaluation, ListingSummary, Targets } from "../../shared/types.ts";
import { buyerReviewBlock, buyerReviewFailure, isAiAuthorityHold, isBuyerReviewFailure, isBuyerWaitReason, isLegacyAiAccountingFailure, isRetiredRequestLimit, isEbayResearchHold, unconfirmedResale, type BuyerListingReview, type BuyerWaitReason } from "../../shared/wait-skip-review.ts";
import { supplementalResearch } from "../pricing/supplemental-research.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { getAiUsageContext, getBudgetContext, withAiUsageContext } from "../ai/usage-context.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { needsBaseSetFrame } from "./base-set-frame.ts";
import { evaluateBoundedListing, PriceOnlyEvidenceError } from "./bounded-evaluate.ts";
import { dealHuntCandidate, newGradingOpportunity } from "./deal-hunt-evidence.ts";
import { loadSearchReviewInventory } from "./deal-hunt-service.ts";
import { PhotoReviewError, restoreBoundedPhotoReview, reviewListingPhotos } from "./deeper-review.ts";
import { evaluationFailure } from "./failure.ts";
import { loadPrivateEvaluation } from "./private-evaluation.ts";
import { isSearchDiagnosticId } from "./search-diagnostic-store.ts";
import { loadDiagnosticDiscovery } from "./search-diagnostics.ts";
import { restoreSavedHuntSales } from "./same-set-markets.ts";
import { stampCandidate } from "./stamp-decision.ts";
import { restoreRawComparisons } from "../pricing/saved-raw-comparisons.ts";

export class BuyerReviewInputError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

const defaults = { discovery: loadDiagnosticDiscovery, inventory: loadSearchReviewInventory, snapshot: loadPrivateEvaluation,
    evaluate: evaluateBoundedListing, supplement: supplementalResearch, restoreRaw: restoreRawComparisons, deeper: reviewListingPhotos, restorePhotoReview: restoreBoundedPhotoReview, recheckIdentity: recheckSavedCatalogIdentity, restoreSales: restoreSavedHuntSales, cached: readCache, save: writeCache, now: Date.now };
type Evidence = BuyerListingReview["evidence"];
type Research = "assess" | "printing" | "deeper" | "prices" | "terms";

function freshTerms(e: Evaluation, now: number) {
    return currentQuote(e.listing.termsCheckedAt, now) && matchesShippingDestination(e);
}

function matchesShippingDestination(e: Evaluation) {
    return (e.listing.shippingDestination ?? null) === configuredShippingZip();
}

function fitsRow(e: Evaluation, row: ListingSummary) {
    const newerDisclosure = row.termsCheckedAt && Date.parse(row.termsCheckedAt) > (Date.parse(e.listing.termsCheckedAt ?? "") || 0)
        && (row.conditionNotes != null && JSON.stringify(row.conditionNotes) !== JSON.stringify(e.listing.conditionNotes) ||
            row.cardCondition != null && row.cardCondition !== e.listing.cardCondition);
    return !newerDisclosure && e.listing.id === row.id && e.listing.title.trim() === row.title.trim() &&
        searchPhotosFitDetails(row.images, e.listing.photos ?? []) && e.listing.buyingOption === row.buyingOption;
}

function nextCheck(e: Evaluation | null, now: number): Research | null {
    if (!e) return "assess";
    if (e.listing.availability === "UNAVAILABLE" || Date.parse(e.listing.endTime ?? "") <= now) return null;
    if (!e.photoCheck) return "assess";
    const u = e.underwriting;
    if (e.identity?.notThisCard || e.frontPhotoStop === "AUTHENTICITY" || e.condition?.authenticity.concern === "LIKELY_FAKE") return null;
    if (e.deeperPhotoReview?.findings.some(f => f.impact === "NEW_CONCERN")) return null;
    if (needsReleaseReading(e) && e.condition?.authenticity.concern === "NONE_SEEN" && !e.frontPhotoStop)
        return "printing";
    if (readyForPricing(e.identity) && e.condition?.authenticity.concern !== "POSSIBLE" && e.slab?.status !== "LIKELY_FAKE" &&
        !matchesShippingDestination(e)) return "terms";
    if (e.listing.buyingOption === "AUCTION" && withinOpportunityWindow(e.listing.endTime, now) &&
        readyForPricing(e.identity) && currentPriceEvidence(e, now) && !freshTerms(e, now)) return "terms";
    if (u?.verdict === "PASS" && !priceEvidenceGap(e) && (currentPriceEvidence(e, now) || !u.best)) return null;
    if (!e.focusedPrinting && needsBaseSetFrame(e) || !e.focusedStamp && stampCandidate(e) ||
        needsWholeBack(e.photoCheck) && e.listing.photosInListing > e.photoCheck.images.length) return "printing";
    if (e.photoReviewKey && !e.deeperPhotoReview && u?.verdict === "NEEDS_REVIEW" && !e.slab &&
        readyForPricing(e.identity) && planDeeperPhotos(e.photoCheck, e.listing.photos ?? []).photos.length) return "deeper";
    if (e.condition?.authenticity.concern === "POSSIBLE" || e.slab?.status === "LIKELY_FAKE") return null;
    if (e.pricingDeferred?.identityLookupPending || readyForPricing(e.identity) && (e.pricingDeferred || !currentPriceEvidence(e, now) ||
        u?.verdict === "CANT_PRICE" && priceEvidenceGap(e))) return "prices";
    if ((u?.verdict.startsWith("BUY") || u?.shippingUnconfirmed || e.listing.availability === "UNKNOWN") && !freshTerms(e, now)) return "terms";
    return null;
}

function costText(price: number | null, shipping: number | null, format: Evaluation["listing"]["buyingOption"], lastChecked = false) {
    if (price == null || !Number.isFinite(price) || price < 0) return "";
    if (format === "AUCTION") return `The listed bid was ${dollars(price)}. `;
    return shipping == null ? `The item is ${dollars(price)} before shipping and tax. ` :
        `${lastChecked ? "The last checked purchase total was" : "The estimated purchase total is"} ${dollars(acquisitionCost(price, shipping, MONEY_CONFIG.buying))}. `;
}

const reviewedActions: ReadonlySet<DealHuntAction> = new Set(["check_listing", "inspect_photos", "check_sales", "calculate_grading"]);
function checkedResale(e: Evaluation, now: number, targets: Targets) {
    return dealHuntCandidate(e, "resell", now, undefined, targets)?.outcome(reviewedActions);
}

function offerCandidate(e: Evaluation | null, listing: ListingSummary | undefined, enabled: boolean, now: number): OfferPlan | null {
    if (!enabled || !listing || !e || e.listing.bestOffer !== true || e.listing.availability !== "ACTIVE" ||
        !freshTerms(e, now) || !currentPriceEvidence(e, now) || !observedCardKind(e) ||
        resultGroup({ ...listing, currentPrice: e.listing.price, bestOffer: true }, e, true) !== "offers") return null;
    const plan = offerFor({ ...e.listing, currentPrice: e.listing.price }, e.underwriting?.best?.maxBid);
    return offerWorthMaking(plan) ? plan : null;
}

function checkedOffer(e: Evaluation, plan: OfferPlan, targets: Targets, now: number): BuyerListingReview["offer"] {
    const hypothetical = retargetEvaluation({ ...e, listing: { ...e.listing, price: plan.offer } }, targets);
    const purchase = checkedResale(hypothetical, now, targets)?.verifiedPurchase;
    if (!purchase) return;
    // The route cleared at the opening price and its receipt already accounts
    // for the matched resale evidence and any one-grade-lower limit.
    const maxItemPrice = Math.min(plan.walkAway, purchase.maxItemPrice);
    return { opening: plan.offer, maxItemPrice, verifiedPurchase: { ...purchase, maxItemPrice } };
}

function verdict(e: Evaluation, now: number, targets: Targets): Pick<BuyerListingReview, "decision" | "reason" | "waitReason" | "verifiedPurchase"> {
    const u = e.underwriting, best = u?.best, l = e.listing;
    const purchase = costText(l.price, matchesShippingDestination(e) ? l.shipping : null, l.buyingOption, !freshTerms(e, now));
    const wait = (reason: string, waitReason?: BuyerWaitReason) => ({ decision: "WAIT" as const, reason: purchase + reason,
        ...(waitReason && { waitReason }) });
    const skip = (reason: string) => ({ decision: "SKIP" as const, reason });
    if (l.availability === "UNAVAILABLE" || Date.parse(l.endTime ?? "") <= now) return skip("This listing has ended.");
    if (e.identity?.notThisCard) return skip(e.identity.notThisCard);
    if (e.frontPhotoStop === "AUTHENTICITY" || e.condition?.authenticity.concern === "LIKELY_FAKE")
        return skip(e.condition?.authenticity.reasons[0] ?? "The photo assessment found signs of a possible counterfeit.");
    if (!matchesShippingDestination(e)) return wait("A current shipping quote is needed for this destination.", "SHIPPING_UNCONFIRMED");
    if (e.photoCheck && u?.verdict === "PASS" && best && !priceEvidenceGap(e) && currentPriceEvidence(e, now)) {
        const margin = best.profit < 0 ? `a ${dollars(-best.profit)} loss` : `${dollars(best.profit)} profit, below your targets`;
        const result = `${purchase}${best.label} projects ${margin} after purchase and resale costs.`;
        const wear = best.priceCondition;
        if (best.path === "RAW" && isRawCondition(wear) && e.rawPricing?.conditionEvidence === "AI_PHOTOS") {
            const comp = e.rawPricing.prices?.find(p => p.condition === wear && p.price === best.salePrice)?.comps;
            if (comp?.count && comp.grader === "RAW" && comp.grade === wear && comp.sales.some(s => s.photoCondition === wear && s.conditionEvidence?.length)) {
                const label = CONDITION_NAMES[wear];
                const basis = comp.count === 1 ? `One photo-checked ${label} copy sold for ${dollars(best.salePrice)}.`
                    : `The ${dollars(best.salePrice)} resale estimate uses ${comp.count} photo-checked ${label} sales.`;
                const limit = best.maxBid > 0 ? ` Your maximum item price for this return is ${dollars(best.maxBid)} before shipping and tax.` : "";
                return skip(`${result} ${basis}${limit}`);
            }
        }
        return skip(result);
    }
    if (u?.shippingUnconfirmed || l.buyingOption === "FIXED_PRICE" && l.shipping == null)
        return wait("eBay supplied no shipping quote. A delivery charge could erase the resale margin.", "SHIPPING_UNCONFIRMED");
    if (!e.photoCheck || !observedCardKind(e)) {
        const usable = e.photoCheck?.images.filter(p => p.usable && !p.isStockImage).length ?? 0;
        const issue = e.photoCheck?.cardCount === "MULTIPLE" ? "The photos show multiple cards." : usable
            ? "The checked views did not establish whether this copy is raw or slabbed." : "None of the checked views establishes this specific copy.";
        return wait(`${l.photosAnalyzed} of ${l.photosInListing} listing photos checked. ${issue}`, "PHOTO_EVIDENCE_INCONSISTENT");
    }
    const finding = e.deeperPhotoReview?.findings.find(f => f.impact === "NEW_CONCERN");
    if (finding) return wait(finding.observation, "MATERIAL_REVIEW");
    const release = releaseIssue(e);
    if (release) return wait(release, "IDENTITY_UNRESOLVED");
    if (u?.verdict.startsWith("BUY")) {
        if (!freshTerms(e, now) || l.availability !== "ACTIVE") {
            const saved = savedRawPriceContext(e, now, targets);
            const reason = "eBay has not confirmed a current price, shipping quote and availability together.";
            return { decision: "WAIT", reason: [saved, reason].filter(Boolean).join(" ") };
        }
        if (!currentPriceEvidence(e, now)) return wait("The last resale estimate is too old or lacks a matching completed sale for this copy.", "PRICE_EVIDENCE_UNAVAILABLE");
        if (l.buyingOption === "AUCTION") {
            const market = currentAuctionMarket(e, now);
            return market && l.price != null && cents(l.price) >= cents(market.price)
                ? skip(`The current auction price of ${dollars(l.price)} already meets or exceeds the ${dollars(market.price)} matched ${market.label} market value.`)
                : wait("The checked sales do not establish that this auction is below the market value of the card as listed.", "PRICE_EVIDENCE_UNAVAILABLE");
        }
        const result = checkedResale(e, now, targets);
        if (result && result.decision !== "BID") return { decision: result.decision, reason: purchase + result.reason,
            ...(result.verifiedPurchase && { verifiedPurchase: result.verifiedPurchase }) };
    }
    const id = e.identity;
    if (!readyForPricing(id)) return wait(unconfirmedResale(e, now), "IDENTITY_UNRESOLVED");
    if (e.slab) {
        if (e.slab.status === "LIKELY_FAKE") return skip(e.slab.reasons[0] ?? "The slab check found signs of a counterfeit holder.");
        if (e.slab.status !== "OK") return wait(e.slab.concerns?.[0] ?? "The label did not verify the grading company and numeric grade.", "SLAB_LABEL_UNRESOLVED");
        const reference = slabBuyGuidance(e, now);
        if (reference) return { decision: "WAIT", reason: `${reference.grade}: ${reference.explanation} ${reference.evidence}`, waitReason: "PRICE_EVIDENCE_UNAVAILABLE" };
        return wait(`The label reads ${e.slab.grader} ${e.slab.grade}. The checked prices do not establish a profitable resale at this grade for the ${id?.printingLabel ?? id?.printing} copy.`, "PRICE_EVIDENCE_UNAVAILABLE");
    }
    if (e.condition?.authenticity.concern === "POSSIBLE") return wait(e.condition.authenticity.reasons[0] ?? "The photo assessment flagged the card’s authenticity.", "MATERIAL_REVIEW");
    if (e.condition?.creases === "SUSPECTED") return wait("The photos show a possible crease. That would change the raw resale condition and grading value.", "MATERIAL_REVIEW");
    const reason = printingReviewReasons(e, u?.reasons ?? [])[0];
    const wear = e.condition?.rawCondition;
    if (isRawCondition(wear) && (u?.verdict === "CANT_PRICE" || e.pricingDeferred || !u?.best)) {
        if (e.pricingDeferred) return wait(e.pricingDeferred.note, "PRICING_DEFERRED");
        const advice = rawBuyGuidance(e, now, targets);
        if (advice) return advice.decision === "PASS" ? skip(purchase + advice.explanation) : wait(advice.explanation, "PRICE_EVIDENCE_UNAVAILABLE");
        const prices = e.rawPricing?.prices ?? [];
        const match = prices.find(p => p.condition === wear && p.basis === "EBAY_SOLD");
        const other = prices.find(p => p.condition !== wear && p.basis === "EBAY_SOLD");
        if (!match) return wait(`The photos place this copy at ${CONDITION_NAMES[wear]}. The checked prices include no matched raw sale at that condition for this printing.` +
            (other && isRawCondition(other.condition) ? ` The ${dollars(other.price)} comparison is for ${CONDITION_NAMES[other.condition]}.` : ""), "PRICE_EVIDENCE_UNAVAILABLE");
        return wait(`The matched ${CONDITION_NAMES[wear]} raw resale estimate is ${dollars(match.price)}. ${reason ?? "The grading and resale estimates do not support the purchase at this price."}`);
    }
    if (!e.condition || e.condition.rawCondition === "UNKNOWN") {
        const side = photoReviewStatus(e).reasons.find(note => /whole[- ](front|back)|overview|obscur|glare/i.test(note));
        return wait(`${l.photosAnalyzed} of ${l.photosInListing} photos checked. ${side ?? "The photos do not show enough surface and edge detail to match a resale condition."}`, "PHOTO_EVIDENCE_INCONSISTENT");
    }
    return wait(reason ?? photoReviewStatus(e).reasons[0] ?? "The checked photos and sale prices do not establish a positive return after costs.");
}

const stopReason = {
    OUTSIDE_AUCTION_WINDOW: "Only live auctions with less than 10 hours remaining qualify.",
    NO_IMAGES: "The seller supplied no photos to identify or assess this copy.",
    UNAVAILABLE: "The listing is no longer available.",
    JUNK: "The listing was screened out as an ineligible card listing.",
    CRITERIA_MISMATCH: "The listing differs from the requested card or printing.",
    SCREEN_DROPPED: "The exact slab sale comparisons did not support the asking price.",
    UNSUPPORTED_TEXTURE: "The photos cannot verify the surface variant needed for a matching price.",
    INVALID_PRICE: "There is no valid purchase price to compare with resale.",
    PRICE_ABOVE_CEILING: "The asking price exceeds the app’s supported automatic research range.",
    PRICING_CONFIG: "A required pricing source is unavailable for this search.",
    PRICING_CREDITS: "The pricing source has no remaining allowance for this search.",
} as const;

export function createBuyerListingReviewer(overrides: Partial<typeof defaults> = {}) {
    const deps = { ...defaults, ...overrides }, share = createSharedWork();
    return (searchId: string, listingId: string, targets: Targets, offers: boolean, allowResearch: boolean, signal: AbortSignal): Promise<BuyerListingReview> => {
        if (!isSearchDiagnosticId(searchId) || !/^[\w|-]{1,120}$/.test(listingId)) throw new BuyerReviewInputError("A completed search and retained listing are required.");
        return share(JSON.stringify([searchId, listingId, targets, offers, allowResearch]), async active => {
            const discovery = await deps.discovery(searchId);
            if (!discovery?.discovery.retainedIds.includes(listingId)) throw new BuyerReviewInputError("This listing does not belong to the completed search.", 409);
            const [inventory, snapshot] = await Promise.all([deps.inventory(searchId), deps.snapshot(listingId)]);
            active.throwIfAborted();
            const row = inventory?.rows.find(r => r.listing.id === listingId), listing = row?.listing;
            const source = snapshot && (listing ? fitsRow(snapshot.evaluation, listing) : snapshot.searchId === searchId) ? snapshot : null;
            const restored = source && await deps.restorePhotoReview(source.evaluation, source.searchId, deps.cached);
            const original = restored && await deps.recheckIdentity(restored);
            let e = original && retargetEvaluation(original, targets, listing);
            const response = (decision: BuyerListingReview["decision"], reason: string, evidence: Evidence, waitReason?: BuyerWaitReason): BuyerListingReview =>
                ({ listingId, decision, reason, evidence, evaluation: e, ...(decision === "WAIT" && waitReason && { waitReason }) });
            if (!listing && !e) return response("WAIT", "This older search has no saved listing photos or purchase terms for this copy.", "listing");
            const now = deps.now();
            if (listing) {
                if (listing.match && listing.match !== "UNCONFIRMED_CRITERIA" || !englishListingEligible(listing, e)) return response("SKIP", "This listing falls outside the card or language searched.", "listing");
                if (listing.availability === "UNAVAILABLE" || Date.parse(listing.endTime ?? "") <= now) return response("SKIP", "This listing has ended.", "listing");
                const block = buyerReviewBlock(listing, now);
                const stored = row!.block === "OUTSIDE_AUCTION_WINDOW" ? null : row!.block;
                const reason = [block, stored].find(code => code && Object.hasOwn(stopReason, code)) as keyof typeof stopReason | undefined;
                if (reason && (!e || !["PRICING_CONFIG", "PRICING_CREDITS", "SCREEN_DROPPED"].includes(reason))) {
                    const result = response(["UNAVAILABLE", "JUNK", "UNSUPPORTED_TEXTURE", "SCREEN_DROPPED", "CRITERIA_MISMATCH"].includes(reason) ? "SKIP" : "WAIT",
                        reason === "SCREEN_DROPPED" && row!.screenReason ? row!.screenReason : stopReason[reason], "listing",
                        isBuyerWaitReason(reason) ? reason : undefined);
                    return reason === "PRICING_CONFIG" || reason === "PRICING_CREDITS"
                        ? { ...result, unavailable: true, failure: buyerReviewFailure(reason, false) } : result;
                }
                if (inventory && !matchesListingFilters(listing, inventory.filters, e, inventory.intent.graded)) return response("SKIP", "This copy falls outside the search’s price or card-type filters.", "listing");
            }
            const mismatch = () => e && inventory && evaluatedCriteriaMismatch(e, inventory.intent);
            if (mismatch()) return response("SKIP", "The assessed printing, finish, or grade falls outside this search.", "saved");
            if (e?.underwriting?.verdict === "CANT_PRICE" && observedCardKind(e) === "raw") {
                const raw = await deps.restoreRaw(e, now, active);
                active.throwIfAborted();
                if (raw) e = retargetEvaluation({ ...e, rawPricing: raw }, targets);
            }
            const savedDecision = () => {
                if (!e) return response("WAIT", `${listing ? costText(listing.currentPrice, listing.shipping, listing.buyingOption) : ""}${listing?.images.length ?? 0} listing photos are available. No completed assessment ties this copy to a matched resale price.`, "listing");
                const checkedAt = deps.now();
                const opportunity = matchesShippingDestination(e) ? auctionOpportunity(e, targets, checkedAt, inventory?.filters.maxPrice) : null;
                if (opportunity) return { ...response(opportunity.status === "PASS" ? "SKIP" : "WAIT", opportunity.reason, "saved"), auctionOpportunity: opportunity };
                const gradingOpportunity = newGradingOpportunity(e, checkedAt, targets, {
                    listedAt: e.listing.listedAt ?? listing?.listedAt, createdAt: e.listing.createdAt ?? listing?.createdAt,
                });
                if (gradingOpportunity) {
                    const { grader, likely, lower, delivered, gradingCosts } = gradingOpportunity;
                    const days = likely.sales60 === undefined ? 30 : SALES_ACTIVITY_DAYS;
                    const sales = likely.sales60 ?? likely.sales30;
                    const reason = `Buy at ${dollars(delivered)} delivered. Grading and submission shipping add ${dollars(gradingCosts)}. ${grader} ${likely.grade} projects ${dollars(likely.profit)} profit after all costs, with ${sales} matching ${sales === 1 ? "sale" : "sales"} in the last ${days} days. One grade lower projects ${dollars(lower.profit)} profit.`;
                    return { ...response("BUY", reason, "saved"), gradingOpportunity, verifiedPurchase: gradingOpportunity.verifiedPurchase };
                }
                const checked = verdict(e, checkedAt, targets);
                const plan = checked.decision === "SKIP" ? offerCandidate(e, listing, offers, checkedAt) : null;
                const offer = plan && checkedOffer(e, plan, targets, checkedAt);
                if (offer) return { ...response("WAIT", checked.reason, "saved"), offer };
                return { ...response(checked.decision, checked.reason, "saved", checked.waitReason), ...(checked.verifiedPurchase && { verifiedPurchase: checked.verifiedPurchase }) };
            };
            const withSavedPrices = (action: Research, unavailable: BuyerListingReview): BuyerListingReview => {
                if (!e || action !== "terms" && action !== "prices") return unavailable;
                const context = savedRawPriceContext(e, deps.now(), targets);
                if (!context) return unavailable;
                const { price, shipping, termsCheckedAt } = e.listing;
                const hasQuote = matchesShippingDestination(e) && price != null && Number.isFinite(price) && price > 0 && shipping != null && Number.isFinite(shipping) && shipping >= 0 &&
                    Date.parse(termsCheckedAt ?? "") <= deps.now();
                const quote = hasQuote ? `Last checked purchase total ${dollars(acquisitionCost(price!, shipping!, MONEY_CONFIG.buying))}, including shipping and estimated tax. ` : "";
                return { ...unavailable, evidence: "saved", reason: quote + context + " " + unavailable.reason };
            };
            const account = source && isSearchDiagnosticId(source.searchId) ? source.searchId : searchId;
            const usage = getAiUsageContext();
            const ownsResearch = (usage.watchBudgetId ?? account) === (getBudgetContext().searchId ?? searchId);
            const tried = new Set<Research>(), receipts = new Set<string>();
            const attemptKey = (action: Research, value: Evaluation | null) => {
                const evidence: unknown[] = [action, targets, offers, listing, value?.answeredAt,
                    value?.photoReviewKey, value?.focusedPrinting, value?.focusedStamp, value?.pricesCheckedAt, value?.pricingVersion,
                    value?.deeperPhotoReview?.reviewedAt, value?.listing.termsCheckedAt,
                    ...(original !== restored ? [value?.identity?.status, value?.identity?.name, value?.identity?.set, value?.identity?.cardNumber,
                        value?.identity?.recordId, value?.identity?.printing, value?.identity?.finish, value?.identity?.notThisCard] : [])];
                // A previous-destination review receipt cannot suppress refresh
                // for a newly selected ZIP. Keep other receipt keys compatible.
                if (action === "terms" && value && !matchesShippingDestination(value)) evidence.push(configuredShippingZip());
                if (value && baseSetLookalike(value)) evidence.push("anniversary-mark-v1", value.releaseMark ?? null);
                const hash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
                return `private-buyer-review:${action === "prices" ? "v3" : "v2"}:${searchId}:${listingId}:${hash}`;
            };
            type Receipt = Omit<BuyerListingReview, "evaluation"> & { recheckAt?: number };
            const remember = async (result: BuyerListingReview, recheckAt?: number) => {
                const { evaluation: _, ...receipt } = result;
                for (const key of receipts) await deps.save(key, { ...receipt, ...(recheckAt !== undefined && { recheckAt }) });
                return result;
            };
            let evidence: Evidence = e ? "saved" : "listing";
            while (allowResearch) {
                active.throwIfAborted();
                const action = nextCheck(e, deps.now());
                // Another step is warranted only when the last one resolved its gap
                // and the evidence now points to a different, material check.
                if (!action || tried.has(action)) break;
                const key = attemptKey(action, e);
                const prior = await deps.cached<Receipt>(key, action === "terms" ? BEST_BUY_TERMS_MAX_AGE_MS / 3600000 : 6);
                if (prior) {
                    if (prior.listingId !== listingId || !["BUY", "WAIT", "SKIP"].includes(prior.decision) ||
                        !["listing", "photos", "prices", "saved"].includes(prior.evidence) || typeof prior.reason !== "string" || !prior.reason.trim() ||
                        prior.failure !== undefined && !isBuyerReviewFailure(prior.failure) ||
                        prior.waitReason !== undefined && (prior.decision !== "WAIT" || !isBuyerWaitReason(prior.waitReason)) ||
                        prior.retryAt !== undefined && (!Number.isSafeInteger(prior.retryAt) || prior.retryAt < 0) ||
                        prior.recheckAt !== undefined && (!Number.isSafeInteger(prior.recheckAt) || prior.recheckAt < 0) ||
                        prior.failure?.retryable && (prior.decision !== "WAIT" || !prior.unavailable || prior.retryAt === undefined)) {
                        throw new StorageUnavailableError("The saved buyer decision could not be verified.");
                    }
                    const cooldown = prior.retryAt ?? prior.recheckAt;
                    if ((!cooldown || cooldown > deps.now()) && !isRetiredRequestLimit(prior.failure, prior.reason) && !isEbayResearchHold(prior.failure) &&
                        !isAiAuthorityHold(prior.failure) && !isLegacyAiAccountingFailure(prior.failure?.code, prior.reason)) {
                        if (prior.unavailable) return withSavedPrices(action, { ...response("WAIT", prior.reason, evidence, prior.waitReason), unavailable: true,
                            failure: prior.failure ?? buyerReviewFailure(undefined, false),
                            ...(prior.failure?.retryable && { retryAt: prior.retryAt }) });
                        if (e) break;
                        if (prior.decision === "BUY" || prior.offer) return response("WAIT", "The evaluated copy and its current purchase terms are no longer available together.", "listing");
                        return response(prior.decision, prior.reason, "saved", prior.waitReason);
                    }
                }
                active.throwIfAborted();
                tried.add(action);
                receipts.add(key);
                evidence = action === "prices" ? "prices" : action === "terms" ? "listing" : "photos";
                try {
                    if (action === "deeper" && e?.photoReviewKey) {
                        const deeper = await withAiUsageContext({ searchId: account, listingId }, () => deps.deeper(listingId, e!.photoReviewKey!, active));
                        e = retargetEvaluation({ ...e, deeperPhotoReview: deeper }, targets, listing);
                    } else {
                        const refreshed = await withAiUsageContext({ searchId: account, listingId }, () => deps.evaluate(listingId, {
                            targets, includeOffers: offers, signal: active, automatic: true, typeFilter: inventory?.filters.typeFilter, priceOnly: action === "prices", verifySoldCondition: action === "prices",
                        }));
                        if (listing && !fitsRow(refreshed, listing)) {
                            e = null;
                            return remember(response("WAIT", "The listing or its gallery changed since the search. The earlier evidence cannot support this copy.", "listing"));
                        }
                        const samePhotoReview = action === "prices" && e?.deeperPhotoReview && refreshed.photoReviewKey === e.photoReviewKey;
                        e = retargetEvaluation(samePhotoReview && !refreshed.deeperPhotoReview
                            ? { ...refreshed, deeperPhotoReview: e!.deeperPhotoReview } : refreshed, targets);
                    }
                    active.throwIfAborted();
                } catch (error) {
                    active.throwIfAborted();
                    if (error instanceof PriceOnlyEvidenceError || error instanceof PhotoReviewError && error.status === 409) {
                        e = null;
                        return remember(response("WAIT", "The listing evidence changed during research. Its earlier assessment cannot support a purchase.", "listing"));
                    }
                    const failure = evaluationFailure(error);
                    if (failure.status === 404 || failure.code === "OTHER_LANGUAGE") { e = null; return remember(response("SKIP", failure.error, "listing")); }
                    if (failure.status === 500 && !failure.code && !failure.retryable) throw error;
                    const stop = response("WAIT", failure.error, e ? "saved" : "listing");
                    if (failure.status === 503 || failure.code === "AI_EVIDENCE_HELD") {
                        const scoped = failure.code === "AI_BUDGET" || failure.code === "PRICE_RESEARCH_BUDGET" || failure.code === "PRICE_RESEARCH_UNAVAILABLE";
                        const typed = buyerReviewFailure(failure.code, failure.retryable === true,
                            scoped && !ownsResearch ? "listing" : failure.scope);
                        const unavailable: BuyerListingReview = { ...stop, unavailable: true, failure: typed,
                            ...(typed.retryable && { retryAt: deps.now() + Math.max(failure.retryAfterMs ?? 30000, 3000) }) };
                        // A storage outage can prevent writing any receipt. Respond
                        // with its actual reason, and use a cooldown for other providers.
                        if (failure.code === "STORAGE_UNAVAILABLE" || isEbayResearchHold(typed) || isAiAuthorityHold(typed))
                            return withSavedPrices(action, unavailable);
                        // Store only the provider limitation. Rebuild the comparison from current saved evidence on replay.
                        // Credits/access or an explicit pause can be repaired by
                        // the owner. Permit a later explicit check without asking
                        // the browser to retry these holds automatically.
                        const manualRecheck = !typed.retryable && !["AI_BUDGET", "AI_EVIDENCE_HELD", "PRICE_RESEARCH_BUDGET"].includes(typed.code)
                            ? deps.now() + 30000 : undefined;
                        await remember(unavailable, manualRecheck);
                        return withSavedPrices(action, unavailable);
                    }
                    return remember(stop);
                }
                receipts.add(attemptKey(action, e));
                if (mismatch()) return remember(response("SKIP", "The assessed printing, finish, or grade falls outside this search.", evidence));
                if (e?.pricingDeferred) {
                    // This assessment just hit its price allowance. Do not ask the
                    // same account for another price check during the same review.
                    receipts.add(attemptKey("prices", e));
                    break;
                }
            }
            // Older private assessments kept the raw sales but predate condition-specific
            // references. An offline replay can recover those from the already-paid product and web caches.
            if (!allowResearch && e?.underwriting?.verdict === "CANT_PRICE" && observedCardKind(e) === "raw" &&
                (!e.trackerRawReference || !e.webPriceResearch?.market)) {
                const saved = await deps.supplement(e, { cacheOnly: true, now: deps.now(), signal: active });
                active.throwIfAborted();
                e = { ...e, ...saved };
            }
            if (e && (e.underwriting?.verdict.startsWith("BUY") || offerCandidate(e, listing, offers, deps.now()))) {
                await deps.restoreSales([e], "resell", deps.now(), active);
                active.throwIfAborted();
            }
            const result = { ...savedDecision(), evidence };
            if (result.decision === "WAIT" && !result.offer && e?.pricingDeferred) {
                const note = e.pricingDeferred.note;
                const reason = result.reason.includes(note) ? result.reason : `${result.reason} ${note}`;
                return remember({ ...result, unavailable: true, reason, failure: buyerReviewFailure("PRICE_RESEARCH_BUDGET", false,
                    tried.size && ownsResearch ? "search" : "listing") });
            }
            return remember(result);
        }, signal);
    };
}

export const reviewBuyerListing = createBuyerListingReviewer();
