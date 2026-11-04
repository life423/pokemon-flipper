import type { PricingResearchUsage } from "./pricing-usage.ts";
import type { ProviderUsageSnapshot } from "./provider-usage.ts";

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
