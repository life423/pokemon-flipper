import type { Targets } from "../types";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";

// Recent searches, newest first, offered before the next search.
export const RECENT_KEY = "recentSearches";
export const RECENT_LIMIT = 6;

// Offered before there are recent searches.
export const STARTER_SEARCHES = ["aquapolis cards psa 7 or better holo", "1999 charizard", "neo genesis lugia", "base set blastoise"];

export function readRecentSearches(): string[] {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
        return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === "string") : [];
    } catch {
        return [];
    }
}

// AI analyses at once, and per search unless you ask for more.
// How many candidates the AI analyzes on its own per search: every one
// that lands in Waiting by default, best first, or a cap, or none.
export const ALL = Number.POSITIVE_INFINITY;
export const AUTO_OPTIONS = [ALL, 20, 10, 5, 0];
export const DEFAULT_AUTO = ALL;
// Saved under a new name, so an old cap doesn't hold over the new default.
export const AUTO_KEY = "aiPerSearch";

// Your profit and return targets, saved between visits.
export function readTargets(): Targets {
    try {
        const saved = JSON.parse(localStorage.getItem("targets") ?? "null");
        if (typeof saved?.minProfit === "number" && typeof saved?.minRoi === "number") return saved;
    } catch {
        // Unreadable: use the defaults.
    }

    return MONEY_CONFIG.targets;
}

// The boxes show whole dollars and percents, and stay empty for "any".
export const targetText = (targets: Targets) => ({
    minProfit: targets.minProfit === 0 ? "" : String(targets.minProfit),
    minRoi: targets.minRoi === 0 ? "" : String(Math.round(targets.minRoi * 100)),
});

// eBay results per search: later pages are mostly loose matches, and each
// result can cost an eBay request, so 400 unless you ask for more.
export const RESULT_OPTIONS = [200, 400, 1000];
export const DEFAULT_RESULTS = 400;

export function readResultsSetting(): number {
    try {
        const saved = Number(localStorage.getItem("results"));
        return RESULT_OPTIONS.includes(saved) ? saved : DEFAULT_RESULTS;
    } catch {
        return DEFAULT_RESULTS;
    }
}

export function readAutoSetting(): number {
    try {
        const saved = localStorage.getItem(AUTO_KEY);
        return saved !== null && AUTO_OPTIONS.includes(Number(saved)) ? Number(saved) : DEFAULT_AUTO;
    } catch {
        return DEFAULT_AUTO;
    }
}
