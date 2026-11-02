import type { Targets } from "../types";
import { MONEY_CONFIG } from "../../../shared/money/config.ts";
import { DEVELOPMENT_SEARCH_LIMIT } from "../../../shared/research-policy.ts";

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

// Explicit development scope. HTTP searches enforce the same small limit
// before title/photo screening, regardless of any older browser setting.
export const ALL = Number.POSITIVE_INFINITY;
export const AUTO_OPTIONS = [DEVELOPMENT_SEARCH_LIMIT, 0];
export const DEFAULT_AUTO = DEVELOPMENT_SEARCH_LIMIT;
export const AUTO_KEY = "aiPerSearchDevelopment";

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

export const RESULT_OPTIONS = [DEVELOPMENT_SEARCH_LIMIT];
export const DEFAULT_RESULTS = DEVELOPMENT_SEARCH_LIMIT;

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
