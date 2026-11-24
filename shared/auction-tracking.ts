export type AuctionTrackingStatus = "OPEN" | "OVER_LIMIT" | "RECHECK" | "AWAITING_SALE" | "WITHIN_LIMIT" | "ABOVE_LIMIT" | "UNCONFIRMED";

export interface TrackedAuction {
    listingId: string;
    title: string;
    url: string;
    alertedAt: string;
    endsAt: string;
    marketValue: number;
    originalMaxBid: number;
    initialBid: number;
    originalShipping: number;
    checkedAt: string;
    nextBid: number | null;
    shipping: number | null;
    status: AuctionTrackingStatus;
    note: string;
    bidHistory?: { checkedAt: string; currentBid: number | null; minimumBid: number | null; shipping: number | null }[];
    recheckAfter?: string;
    closingPrice?: number;
    soldAt?: string;
    saleUrl?: string;
}

export interface AuctionTrackingResults {
    auctions: TrackedAuction[];
    confirmed: number;
    withinLimit: number;
    awaiting: number;
}
