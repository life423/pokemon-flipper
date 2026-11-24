import { useEffect, useReducer, useRef } from "react";
import type { BuyerListingReview } from "../../../shared/wait-skip-review.ts";
import { listingEvidenceKey } from "../../../shared/listing-evidence.ts";
import { BOUNDED_AUTO_CONCURRENCY } from "../../../shared/research-policy.ts";
import { BEST_BUY_TERMS_MAX_AGE_MS } from "../../../shared/search-diagnostic.ts";
import { reviewBuyerListing } from "../api";
import type { Evaluation, ListingSummary, Targets } from "../types";

type Decision = Pick<BuyerListingReview, "decision" | "reason" | "offer" | "gradingOpportunity" | "auctionOpportunity"> & { unavailable?: true; expiredQuote?: true };
type Completed = { key: string; transitionFrom?: string; decision: Decision; unavailable: boolean; validUntil?: number };
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
}
function reviewKey(options: Options, row: ListingSummary, evaluation = options.evaluations.get(row.id)) {
    return JSON.stringify([options.owners.get(row.id), options.targets.minProfit, options.targets.minRoi,
        options.offers, options.allowResearch, ...evidence(row),
        evaluation?.answeredAt, evaluation?.pricesCheckedAt, evaluation?.pricingVersion, evaluation?.photoReviewKey,
        evaluation?.deeperPhotoReview?.reviewedAt, evaluation?.focusedPrinting, evaluation?.focusedStamp,
        evaluation?.identity?.printing, evaluation?.condition?.rawCondition, evaluation?.condition?.authenticity?.concern,
        evaluation?.listing.termsCheckedAt]);
}

export function useBuyerReviews(options: Options) {
    const { searchId, enabled, ready, allowResearch, targets, offers, now, listings, queue, busy } = options;
    const latest = useRef(options);
    latest.current = options;
    const results = useRef(new Map<string, Completed>());
    const running = useRef(new Map<string, AbortController>());
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
        const completed = results.current.get(listing.id);
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
    const pending = queue.filter(listing => !decisions[listing.id]);
    useEffect(() => {
        if (!enabled || !ready || !searchId) return;
        for (const id of results.current.keys()) if (!latest.current.owners.has(id)) results.current.delete(id);
        // The response and React’s refreshed listing do not necessarily commit in
        // the same render. Suppress another dispatch for the old inputs during
        // that transition, without accepting their old price as a decision.
        for (const row of listings) {
            const completed = results.current.get(row.id);
            if (completed?.transitionFrom && completed.key === reviewKey(options, row)) delete completed.transitionFrom;
        }
        let started = false;
        for (const listing of pending) {
            if (running.current.size + busy.size >= BOUNDED_AUTO_CONCURRENCY) break;
            const id = listing.id, owner = options.owners.get(id), key = reviewKey(options, listing);
            const completed = results.current.get(id);
            if (!owner || busy.has(id) || running.current.has(id) || completed?.key === key || completed?.transitionFrom === key) continue;
            const controller = new AbortController();
            running.current.set(id, controller);
            started = true;
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
                        result.decision === "BUY" && !result.evaluation?.underwriting?.verdict.startsWith("BUY"))) throw new Error("Purchase terms expired");
                    if (result.offer && (!offers || result.decision !== "WAIT" || !(result.offer.opening > 0) ||
                        !Number.isFinite(result.offer.maxItemPrice) || result.offer.opening > result.offer.maxItemPrice)) throw new Error("Invalid offer");
                    const updated = currentOptions.onResult(current, result, owner);
                    results.current.set(id, { key: reviewKey(currentOptions, updated.listing, updated.evaluation), transitionFrom: key, decision: { decision: result.decision, reason: result.reason, offer: result.offer, gradingOpportunity: result.gradingOpportunity, auctionOpportunity: result.auctionOpportunity, unavailable: result.unavailable }, unavailable: !!result.unavailable, validUntil });
                } catch {
                    if (!controller.signal.aborted) results.current.set(id, { key, unavailable: true, decision: {
                        decision: "WAIT", unavailable: true, reason: "Wait to buy. The app could not finish checking this listing’s price and purchase terms.",
                    } });
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
        const result = results.current.get(id);
        if (!enabled || !ready || !result?.validUntil || result.validUntil > Date.now() || running.current.has(id)) return;
        results.current.delete(id);
        update();
    };
    return { decisions, recheckQuote, remaining: pending.length, unavailable, reviewed: Object.keys(decisions).length - unavailable,
        active: enabled && ready ? running.current.size : 0 };
}
