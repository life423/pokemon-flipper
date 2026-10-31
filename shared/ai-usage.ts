export interface AiUsageDay {
    dayUtc: string;
    calls: number;
    stages: { step: string; model: string; calls: number; failed: number; images: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }[];
}
