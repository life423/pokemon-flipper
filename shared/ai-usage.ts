import type { PricingResearchUsage } from "./pricing-usage.ts";
import type { ProviderUsageSnapshot } from "./provider-usage.ts";
import type { DealHuntAction } from "./deal-hunt.ts";
import type { ListingSummary } from "./types.ts";

export interface AiUsageStage {
    step: string;
    model: string;
    calls: number;
    failed: number;
    images: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    serviceTier?: string | null;
    // Null means some attempts did not report this field; it is not zero cost.
    cacheWriteTokens?: number | null;
    cacheWrite30mTokens?: number | null;
    cacheWrite12hTokens?: number | null;
    reasoningOutputTokens?: number | null;
    unreportedUsageCalls?: number;
    unreportedCacheWriteCalls?: number;
}

export interface AiUsageDay {
    dayUtc: string;
    calls: number;
    searchId?: string;
    unattributedCalls?: number;
    stages: AiUsageStage[];
    budget?: AiSearchBudget;
    pricing?: PricingResearchUsage | null;
    providers?: ProviderUsageSnapshot[];
    hunt?: HuntProgress;
}

export interface HuntProgress {
    searchId: string;
    phase: "planning" | "discovering" | "pricing" | "reviewing" | "completed" | "stopped" | "failed";
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    cohort?: string;
    guidance?: string;
    action?: DealHuntAction | "find_listings";
    /** Listing summaries loaded across queries, before candidate deduplication. */
    discovered: number;
    screened: number;
    retained: number;
    /** Distinct copies on which an evidence check completed. */
    reviewed: number;
    /** Distinct copies whose photo-evidence check completed, including saved evidence. */
    photos: number;
    scans: number;
    /** A bounded window of provisional copies; these are not purchase approvals. */
    candidates?: ListingSummary[];
}

export interface AiSearchBudget {
    configured: boolean;
    paused: boolean;
    searchId: string | null;
    capUsd: number | null;
    committedUsd: number;
    settledUsd: number;
    heldUsd: number;
    remainingUsd: number | null;
    attempts: number;
    unsettledAttempts: number;
}
