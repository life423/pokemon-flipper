import { useEffect, useReducer, useRef } from "react";
import { BUYER_REVIEW_MAX_ATTEMPTS, buyerReviewFailure, buyerReviewRetryAt, isLegacyAiAccountingFailure, isRetiredRequestLimit, type BuyerListingReview, type BuyerReviewFailure } from "../../../shared/wait-skip-review.ts";
import { listingEvidenceKey } from "../../../shared/listing-evidence.ts";
import { BOUNDED_AUTO_CONCURRENCY } from "../../../shared/research-policy.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import { applyVerifiedPurchase } from "../../../shared/money/verified-purchase.ts";
import { ApiRequestError, reviewBuyerListing } from "../api";
import type { Evaluation, ListingSummary, Targets } from "../types";
import type { AnalysisBlockCode } from "./presentation";

type Decision = Pick<BuyerListingReview, "decision" | "reason" | "waitReason" | "offer" | "gradingOpportunity" | "auctionOpportunity" | "failure" | "verifiedPurchase"> & { unavailable?: true; expiredQuote?: true };
type Completed = { key: string; transitionFrom?: string; decision: Decision; unavailable: boolean; validUntil?: number; retryAt?: number; attempts: number };
export type BuyerReviewCheckpoint = [string, Omit<Completed, "transitionFrom">][];
const evidence = (row: ListingSummary) => [listingEvidenceKey(row), row.currentPrice, row.shipping, row.availability,
    row.buyingOption, row.bestOffer, row.bids, row.endTime, row.cardCondition, row.conditionNotes, row.termsCheckedAt, row.seller];
interface Options {
    auctionUpdates: ReadonlyMap<string, number>;
    searchId: string | null;
    owners: ReadonlyMap<string, string>;
    enabled: boolean;
    ready: boolean;
    allowResearch: boolean;
    targets: Targets;
    offers: boolean;
    now: number;
    listings: ListingSummary[];
    evaluations: ReadonlyMap<string, Evaluation>;
    queue: ListingSummary[];
    busy: ReadonlySet<string>;
    onResult: (listing: ListingSummary, result: BuyerListingReview, owner: string) => { listing: ListingSummary; evaluation: Evaluation | undefined };
    onGlobalHold: (code: AnalysisBlockCode, message: string) => void;
}
export function buyerReviewGlobalHold(failure: BuyerReviewFailure | undefined, reason = ""): AnalysisBlockCode | null {
    if (!failure || failure.retryable || failure.scope === "listing") return null;
    if (isLegacyAiAccountingFailure(failure.code, reason)) return "AI_ACCOUNTING";
    switch (failure.code) {
        case "AI_CREDITS": case "AI_PAUSED": case "AI_BUDGET": case "AI_ACCOUNTING": case "AI_INPUT_PREFLIGHT": case "STORAGE_UNAVAILABLE":
        case "PRICE_RESEARCH_BUDGET": case "PRICE_RESEARCH_UNAVAILABLE":
        case "EBAY_DAILY_BUDGET": case "EBAY_BUDGET_ACCOUNTING": case "EBAY_AUTH":
            return failure.code;
        default: return null;
    }
}

function reviewKey(options: Options, row: ListingSummary, evaluation = options.evaluations.get(row.id)) {
    return JSON.stringify([options.owners.get(row.id), options.targets.minProfit, options.targets.minRoi,
        options.offers, options.allowResearch, ...evidence(row),
        evaluation?.answeredAt, evaluation?.pricesCheckedAt, evaluation?.pricingVersion, evaluation?.photoReviewKey,
        evaluation?.deeperPhotoReview?.reviewedAt, evaluation?.focusedPrinting, evaluation?.focusedStamp,
        evaluation?.identity?.printing, evaluation?.condition?.rawCondition, evaluation?.condition?.authenticity?.concern,
        evaluation?.listing.termsCheckedAt, ...(row.shippingDestination !== undefined || evaluation?.listing.shippingDestination !== undefined
            ? [row.shippingDestination ?? null, evaluation?.listing.shippingDestination ?? null] : [])]);
}

export function useBuyerReviews(options: Options, checkpoint?: BuyerReviewCheckpoint) {
    const { searchId, enabled, ready, allowResearch, targets, offers, now, listings, queue, busy } = options;
    const latest = useRef(options);
    latest.current = options;
    const results = useRef<Map<string, Completed> | null>(null);
    results.current ??= new Map(checkpoint?.filter(([, { decision }]) =>
        (decision.decision !== "BUY" || decision.verifiedPurchase) && (!decision.offer || decision.offer.verifiedPurchase)));
    const completedReviews = results.current;
    const running = useRef(new Map<string, AbortController>());
    const blockedSearch = useRef<string | null>(null);
    const [, update] = useReducer((value: number) => value + 1, 0);
    useEffect(() => {
        return () => {
            for (const job of running.current.values()) job.abort();
            running.current.clear();
        };
    }, [searchId, targets.minProfit, targets.minRoi, offers, allowResearch, enabled, ready]);

    const decisions: Record<string, Decision> = {};
    let unavailable = 0;
    for (const listing of listings) {
        const completed = completedReviews.get(listing.id);
        if (!completed || completed.key !== reviewKey(options, listing)) continue;
        const auction = completed.decision.auctionOpportunity;
        if (auction && (auction.validUntil <= now || (options.auctionUpdates.get(listing.id) ?? 0) > Date.parse(auction.checkedAt))) {
            decisions[listing.id] = { decision: "WAIT", expiredQuote: true, reason: "The auction terms changed or expired. Recheck the next bid and shipping before bidding." };
            continue;
        }
        decisions[listing.id] = completed.validUntil !== undefined && now >= completed.validUntil
            ? { decision: "WAIT", expiredQuote: true, reason: "Wait to buy. The verified eBay price and shipping quote have expired." }
            : completed.decision;
        if (completed.unavailable) unavailable++;
    }
    const pending = queue.filter(listing => {
        const completed = completedReviews.get(listing.id);
        return !decisions[listing.id] || allowResearch && completed?.key === reviewKey(options, listing) && completed.retryAt !== undefined;
    });
    const unreviewed = pending.filter(listing => !decisions[listing.id]).length;
    useEffect(() => {
        if (!enabled || !ready || !allowResearch || !searchId) return;
        const future = pending.flatMap(row => {
            const completed = completedReviews.get(row.id);
            return completed?.key === reviewKey(options, row) && completed.retryAt !== undefined && completed.retryAt > Date.now()
                ? [completed.retryAt] : [];
        });
        if (!future.length) return;
        // Cooldowns release the concurrency slot. Stop/unmount/input changes
        // clear this timer, while a later attempt keeps the original owner.
        const timer = setTimeout(update, Math.min(2_147_483_647, Math.max(0, Math.min(...future) - Date.now())));
        return () => clearTimeout(timer);
    });
    useEffect(() => {
        if (!enabled || !ready || !searchId || blockedSearch.current === searchId) return;
        for (const id of completedReviews.keys()) if (!latest.current.owners.has(id)) completedReviews.delete(id);
        // The response and React’s refreshed listing do not necessarily commit in
        // the same render. Suppress another dispatch for the old inputs during
        // that transition, without accepting their old price as a decision.
        for (const row of listings) {
            const completed = completedReviews.get(row.id);
            if (completed?.transitionFrom && completed.key === reviewKey(options, row)) delete completed.transitionFrom;
        }
        let started = false;
        for (const listing of pending) {
            if (running.current.size + busy.size >= BOUNDED_AUTO_CONCURRENCY) break;
            const id = listing.id, owner = options.owners.get(id), key = reviewKey(options, listing);
            const completed = completedReviews.get(id);
            const retryDue = allowResearch && completed?.key === key && completed.retryAt !== undefined && completed.retryAt <= Date.now();
            if (!owner || busy.has(id) || running.current.has(id) || completed?.key === key && !retryDue || completed?.transitionFrom === key) continue;
            const attempts = (completed?.key === key ? completed.attempts : 0) + 1;
            const controller = new AbortController();
            running.current.set(id, controller);
            started = true;
            const stopForHold = (failure: BuyerReviewFailure | undefined, reason: string) => {
                const code = buyerReviewGlobalHold(failure, reason);
                if (!allowResearch || !code) return false;
                if (blockedSearch.current === searchId) return true;
                blockedSearch.current = searchId;
                for (const [listingId, job] of running.current) if (listingId !== id) job.abort();
                latest.current.onGlobalHold(code, reason);
                return true;
            };
            void (async () => {
                try {
                    const result = await reviewBuyerListing(id, owner, targets, offers, allowResearch, controller.signal);
                    controller.signal.throwIfAborted();
                    const currentOptions = latest.current;
                    const current = currentOptions.listings.find(row => row.id === id);
                    if (!currentOptions.ready || !currentOptions.enabled || currentOptions.searchId !== searchId ||
                        !current || reviewKey(currentOptions, current) !== key) return;
                    if (result.listingId !== id || (result.evaluation && result.evaluation.listing.id !== id) ||
                        (result.unavailable && (result.decision !== "WAIT" || result.offer)) || !["WAIT", "SKIP", "BUY"].includes(result.decision) || !result.reason?.trim()) throw new Error("Invalid buyer review");
                    const validUntil = result.auctionOpportunity?.validUntil ?? (result.decision === "BUY" || result.offer ? Date.parse(result.evaluation?.listing.termsCheckedAt ?? "") + BEST_BUY_TERMS_MAX_AGE_MS : undefined);
                    if (validUntil !== undefined && (!Number.isFinite(validUntil) || validUntil <= Date.now() ||
                        result.decision === "BUY" && !applyVerifiedPurchase(result.evaluation, result.verifiedPurchase, targets, Date.now()))) throw new Error("Purchase terms expired");
                    if (result.offer && (!offers || result.decision !== "WAIT" || !(result.offer.opening > 0) ||
                        !Number.isFinite(result.offer.maxItemPrice) || result.offer.opening > result.offer.maxItemPrice ||
                        result.offer.verifiedPurchase?.listingId !== id || result.offer.opening !== result.offer.verifiedPurchase.itemPrice ||
                        result.offer.maxItemPrice !== result.offer.verifiedPurchase.maxItemPrice)) throw new Error("Invalid offer");
                    if (stopForHold(result.failure, result.reason)) return;
                    const updated = currentOptions.onResult(current, result, owner);
                    const retryAt = allowResearch ? buyerReviewRetryAt(result.failure, result.retryAt, attempts, Date.now()) : undefined;
                    const exhausted = result.failure?.retryable && attempts >= BUYER_REVIEW_MAX_ATTEMPTS;
                    completedReviews.set(id, { key: reviewKey(currentOptions, updated.listing, updated.evaluation), transitionFrom: key,
                        decision: { decision: result.decision, reason: result.reason + (exhausted ? " Automatic checks stopped after three attempts; this copy has not failed verification." : ""),
                            offer: result.offer, gradingOpportunity: result.gradingOpportunity, auctionOpportunity: result.auctionOpportunity,
                            verifiedPurchase: result.verifiedPurchase, waitReason: result.waitReason,
                            unavailable: result.unavailable, failure: result.failure }, unavailable: !!result.unavailable, validUntil, retryAt, attempts });
                } catch (error) {
                    if (!controller.signal.aborted) {
                        const failure = buyerReviewFailure(error instanceof ApiRequestError ? error.code : undefined, error instanceof ApiRequestError && error.retryable,
                            error instanceof ApiRequestError ? error.failureScope : undefined);
                        const retryAt = allowResearch ? buyerReviewRetryAt(failure, error instanceof ApiRequestError
                            ? error.retryAt ?? Date.now() + error.retryAfterMs : undefined, attempts, Date.now()) : undefined;
                        const reason = error instanceof ApiRequestError ? error.message : "Wait to buy. The app could not finish checking this listing’s price and purchase terms.";
                        if (stopForHold(failure, reason)) return;
                        completedReviews.set(id, { key, unavailable: true, retryAt, attempts, decision: {
                            decision: "WAIT", unavailable: true, failure,
                            reason: reason + (failure.retryable && attempts >= BUYER_REVIEW_MAX_ATTEMPTS
                                ? " Automatic checks stopped after three attempts; this copy has not failed verification." : ""),
                        } });
                    }
                } finally {
                    if (running.current.get(id) === controller) {
                        running.current.delete(id);
                        update();
                    }
                }
            })();
        }
        if (started) update();
    });
    const recheckQuote = (id: string) => {
        const result = completedReviews.get(id);
        if (!enabled || !ready || !result?.validUntil || result.validUntil > Date.now() || running.current.has(id)) return;
        completedReviews.delete(id);
        update();
    };
    const readCheckpoint = (): BuyerReviewCheckpoint => Array.from(completedReviews, ([id, { transitionFrom, ...entry }]) => [id, entry]);
    const clearGlobalHolds = () => {
        blockedSearch.current = null;
        for (const [id, entry] of completedReviews) if (buyerReviewGlobalHold(entry.decision.failure, entry.decision.reason) ||
            isRetiredRequestLimit(entry.decision.failure, entry.decision.reason)) completedReviews.delete(id);
        update();
    };
    return { decisions, recheckQuote, readCheckpoint, clearGlobalHolds, remaining: pending.length, unreviewed, unavailable, reviewed: Object.keys(decisions).length - unavailable,
        active: enabled && ready ? running.current.size : 0,
        activeIds: enabled && ready ? new Set(running.current.keys()) : new Set<string>() };
}
