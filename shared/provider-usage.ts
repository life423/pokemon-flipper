export type ProviderUsageProvider = "EBAY" | "PKMNPRICES";

// Observed account quota, separate from each search's app request allowance.
// A recent decrease informs a warning; it never authorizes provider work.
export interface ProviderUsageSnapshot {
    provider: ProviderUsageProvider;
    label: string;
    limit: number;
    remaining: number;
    observedAt: string;
    resetsAt: string;
    usedInWindow: number | null;
    windowMinutes: number;
    warning: "LOW" | "FAST" | "LOW_AND_FAST" | null;
}
