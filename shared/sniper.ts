export type SniperMode = "reminder" | "sandbox";

export const DEFAULT_SNIPER_LEAD_SECONDS = { reminder: 60, sandbox: 10 } as const;

export interface SniperCapabilities { sandbox: boolean }

export interface SniperQuote {
    itemId: string;
    url: string;
    title: string;
    endTime: string;
    checkedAt: string;
    currentBid: number | null;
    minimumBid: number | null;
    shipping: number | null;
    highBidder?: boolean;
    /** Opaque connection generation confirmed when previewing a sandbox bid. */
    buyerConnectionId?: string;
}

export interface SniperArm {
    mode: SniperMode;
    quote: SniperQuote;
    maxBid: number;
    leadSeconds: number;
}

export type SniperStatus = "ARMED" | "REMINDER" | "SUBMITTING" | "SUBMITTED" | "SKIPPED" | "CANCELLED" | "UNCERTAIN";

export interface SniperJob extends SniperArm {
    id: string;
    status: SniperStatus;
    message: string;
    updatedAt: string;
}

export const REMINDER_WINDOW_HOURS = 12;
export function withinReminderWindow(listing: { buyingOption: string; endTime: string | null }, now = Date.now()): boolean {
    if (listing.buyingOption !== "AUCTION") return false;
    const end = Date.parse(listing.endTime ?? "");
    return Number.isFinite(end) && end > now && end - now <= REMINDER_WINDOW_HOURS * 3600000;
}
