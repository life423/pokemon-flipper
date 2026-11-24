export const FIRST_REVIEW_COUNT = 15;

export interface SearchReviewSelection {
    source: "ai" | "rules";
    /** Distinct retained listing IDs in the order to start their reviews. */
    listingIds: string[];
}
