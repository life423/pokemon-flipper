import type { HuntMarketPreferences } from "../../../shared/deal-hunt.ts";

export interface AuctionHuntPrompt {
    marketPreferences: HuntMarketPreferences;
    minProfit?: number;
    goal?: "collect_slab";
    maxDelivered?: number;
}

// Only broad goals belong to the cross-card hunt. Unconsumed words such as a
// card or set name stay with the ordinary named search.
export function auctionHuntPrompt(text: string): AuctionHuntPrompt | null {
    const lower = text.trim().toLowerCase();
    if (!/\b(?:auctions?|flip|resell)\b/.test(lower)) return null;
    // A shorter or different requested window belongs to the ordinary search.
    let remainder = lower
        .replace(/\b(?:ending\s+)?(?:(?:in|with)\s+)?(?:under|less than)\s+10\s*(?:hours?|hrs?|h)\b(?:\s+(?:left|remaining))?/g, " ")
        .replace(/\b(?:only\s+)?10\s*(?:hours?|hrs?|h)\s+(?:left|remaining)\b/g, " ");
    // A broad collector search currently supports graded cards. Keep named
    // cards, specific grades and other unrecognized constraints in named search.
    const collector = /\b(?:for my collection|to collect)\b/.test(remainder);
    let maxDelivered: number | undefined;
    if (collector) {
        if (!/\bauctions?\b/.test(remainder) || !/\b(?:graded|slabs?)\b/.test(remainder) ||
            /\b(?:profit|flip|resell)\b/.test(remainder)) return null;
        remainder = remainder.replace(/\b(?:for my collection|to collect|graded|slabs?)\b/g, " ");
        const budget = /\b(?:under|up to|at most)\s*\$(\d+(?:\.\d{1,2})?)\s+(?:delivered|all[- ]in)\b/.exec(remainder);
        if (budget) {
            maxDelivered = Number(budget[1]);
            if (!Number.isFinite(maxDelivered) || maxDelivered <= 0) return null;
            remainder = remainder.replace(budget[0], " ");
        }
    }
    const preferences: HuntMarketPreferences = {};
    const years = /\b((?:19|20)\d\d)\s*(?:[-–—]|to|through|and)\s*((?:19|20)\d\d)\b/.exec(remainder);
    if (years) {
        preferences.minYear = Number(years[1]); preferences.maxYear = Number(years[2]);
        if (preferences.minYear > preferences.maxYear) return null;
        remainder = remainder.replace(years[0], " ");
    } else {
        const year = /\b((?:19|20)\d\d)\b/.exec(remainder);
        if (year) { preferences.minYear = preferences.maxYear = Number(year[1]); remainder = remainder.replace(year[0], " "); }
    }
    if (/\bvintage\b/.test(lower) && preferences.minYear === undefined) return null;
    const finish = /\b(?:(reverse|non)[-\s]+)?holos?(?:graphic)?\b/.exec(remainder);
    if (finish) {
        preferences.finish = finish[1] === "reverse" ? "REVERSE_HOLO" : finish[1] === "non" ? "NON_HOLO" : "HOLO";
        remainder = remainder.replace(finish[0], " ");
    }
    const profit = /(?:\b(?:at least|minimum(?: profit(?: of)?)?|profit(?: of)?|flip for)\s*\$([\d]+(?:\.\d{1,2})?)\b|\$([\d]+(?:\.\d{1,2})?)\s+(?:in\s+)?profit\b)/.exec(remainder);
    if (profit) remainder = remainder.replace(profit[0], " ");
    remainder = remainder.replace(/\b(?:find|show|search|look|for|me|a|an|the|some|all|my|any|auction|auctions|pok[eé]mon|trading|cards?|vintage|from|between|in|i|can|to|flip|resell|with|profit|of|please)\b/g, "").replace(/[\s,.?!]+/g, "");
    if (remainder || !years && !preferences.minYear && !finish && !/\bauctions?\b/.test(lower)) return null;
    return { marketPreferences: preferences, ...(profit && { minProfit: Number(profit[1] ?? profit[2]) }),
        ...(collector && { goal: "collect_slab" as const }), ...(maxDelivered !== undefined && { maxDelivered }) };
}
