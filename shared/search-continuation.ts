/** A server-saved next batch. The UUID is a discovery record, not a renewed allowance. */
export interface SearchContinuation {
    token: string;
    searchId: string;
    pending: number;
    moreSource: boolean;
    sourceLimitReached?: boolean;
    blocked?: "QUOTA";
}
