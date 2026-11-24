import { auctionDecision } from "../../../shared/card-presentation.ts";
import { readyForPricing } from "../../../shared/identity.ts";
import { withinReminderWindow } from "../../../shared/sniper.ts";
import { priceEvidenceGap } from "../../../shared/money/price-evidence.ts";
import { DEFAULT_SNIPER_LEAD_SECONDS } from "../../../shared/sniper.ts";
import type { AnalysisState } from "../analysis-state";
import type { ListingSummary, Targets } from "../types";
import type { SniperDraft } from "./AuctionSniper";

interface Props {
    listing: ListingSummary;
    analysis?: AnalysisState;
    targets: Targets;
    now: number;
    className?: string;
    onSnipe?: (draft: SniperDraft) => void;
}

export function AuctionReminderButton({ listing, analysis, targets, now, className, onSnipe }: Props) {
    if (!onSnipe || listing.buyingOption !== "AUCTION" || listing.availability === "UNAVAILABLE" ||
        !withinReminderWindow(listing, now) ||
        Date.parse(listing.endTime ?? "") - now <= DEFAULT_SNIPER_LEAD_SECONDS.reminder * 1000) return null;

    function openPlanner() {
        const assessed = analysis?.status === "done" && analysis.evaluation.listing.id === listing.id ? analysis : null;
        const evaluation = assessed?.evaluation;
        let suggestion: SniperDraft["suggestion"] = null;
        if (evaluation && !assessed.pricingExpired && readyForPricing(evaluation.identity) &&
            evaluation.listing.buyingOption === "AUCTION" && evaluation.listing.endTime && evaluation.listing.shipping != null &&
            !priceEvidenceGap(evaluation) && evaluation.underwriting?.verdict.startsWith("BUY") && !evaluation.underwriting.shippingUnconfirmed) {
            const decision = auctionDecision(evaluation, targets, now);
            if (decision.status === "WITHIN_LIMIT" && decision.ceiling != null) {
                suggestion = { maxBid: decision.ceiling, title: evaluation.listing.title,
                    shipping: evaluation.listing.shipping, endTime: evaluation.listing.endTime };
            }
        }
        onSnipe?.({ itemId: listing.id, title: listing.title, url: listing.url, searchId: assessed?.searchRunId, suggestion });
    }

    return <button type="button" className={className} aria-haspopup="dialog" onClick={openPlanner}
        aria-label={`Auction sniper for ${listing.title}`}>Auction sniper</button>;
}
