// Diagnostic-only guard. It counts transport attempts (including retries),
// blocks before dispatch, and never changes the app's production limits.
export type ReviewService = "ebayBrowse" | "ai" | "prices";
export const REVIEW_LIMITS = { ebayBrowse: 150, ai: 120, prices: 100 } as const;
export class ReviewBudget {
    readonly used: Record<ReviewService, number> = { ebayBrowse: 0, ai: 0, prices: 0 };
    readonly blocked: Record<string, number> = {};
    private discoveries = new Map<string, number>();
    constructor(readonly limits: Record<ReviewService, number> = REVIEW_LIMITS, readonly photosPerQuery = 6) {}
    reserve(service: ReviewService, query: string, schema?: string): void {
        const discovery = service === "ai" && schema === "photo_discovery";
        const reason = this.used[service] >= this.limits[service] ? `${service} total cap`
            : discovery && (this.discoveries.get(query) ?? 0) >= this.photosPerQuery ? "new discovery photo cap" : null;
        if (reason) {
            this.blocked[reason] = (this.blocked[reason] ?? 0) + 1;
            throw new Error(`Review limit: ${reason}; request was not sent.`);
        }
        this.used[service] += 1;
        if (discovery) this.discoveries.set(query, (this.discoveries.get(query) ?? 0) + 1);
    }
}
