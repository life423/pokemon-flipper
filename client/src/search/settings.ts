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

// Listing admission and paid analysis are separate controls. Automatic work
// considers the loaded candidates, while server reservations enforce its cost.
export const ALL = Number.POSITIVE_INFINITY;
export const AUTO_OPTIONS = [ALL, 0];
export const DEFAULT_AUTO = ALL;
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

export function readAutoSetting(): number {
    try {
        const saved = localStorage.getItem(AUTO_KEY);
        if (saved === "3" || saved === "25") { localStorage.setItem(AUTO_KEY, String(DEFAULT_AUTO)); return DEFAULT_AUTO; }
        return saved !== null && AUTO_OPTIONS.includes(Number(saved)) ? Number(saved) : DEFAULT_AUTO;
    } catch {
        return DEFAULT_AUTO;
    }
}
