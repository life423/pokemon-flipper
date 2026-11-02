import type { EbayUsage, SearchIntent } from "../types";
import { describeSearchCriteria } from "../../../shared/search-criteria.ts";
import { name } from "../format";

// "1st Edition Charizard from Base Set, graded": how the search was read.
export function describeIntent(intent: SearchIntent): string {
    let text = [intent.printing ? name(intent.printing) : null, intent.cardName ?? (intent.sets.length ? "cards" : "listings for this search")]
        .filter(Boolean)
        .join(" ");

    if (intent.sets.length > 0) text += ` from ${intent.sets.join(" or ")}`;
    if (intent.cardNumber) text += ` #${intent.cardNumber}`;
    const criteria = describeSearchCriteria(intent);
    if (criteria.length) text += ` · ${criteria.join(" · ")}`;

    return text;
}

export function describeUsage(usage: EbayUsage): string {
    const left = `eBay today: ${usage.remaining.toLocaleString()} of ${usage.limit.toLocaleString()} requests left`;
    const development = usage.devLimit === undefined ? "" : ` Development allowance: ${usage.devRemaining ?? 0} of ${usage.devLimit} additional requests left.`;
    return usage.braking
        ? `${left}. New optional lookups are paused to preserve the daily reserve.${development}`
        : `${left}.${development}`;
}
