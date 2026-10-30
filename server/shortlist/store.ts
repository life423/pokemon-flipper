import path from "node:path";
import { DATA_DIR } from "../lib/paths.ts";
import { jsonStore } from "../lib/json-store.ts";
import { SHORTLIST_LIMIT, type ShortlistEntry } from "../../shared/shortlist.ts";
import type { ListingSummary, Evaluation } from "../../shared/types.ts";

export class ShortlistError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}
export function cleanSavedListing(value: unknown): ListingSummary {
    const input = value as Partial<ListingSummary> | null;
    const amount = (number: unknown) => number === null || (typeof number === "number" && Number.isFinite(number) && number >= 0);
    const link = (url: unknown) => {
        if (typeof url !== "string" || url.length > 2048) return false;
        try { const parsed = new URL(url); return parsed.protocol === "https:" && (parsed.hostname === "ebay.com" || parsed.hostname.endsWith(".ebay.com")); } catch { return false; }
    };
    if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9|_-]{1,120}$/.test(input.id) || typeof input.title !== "string" || !input.title.trim() || input.title.length > 500 || !link(input.url) ||
        !amount(input.currentPrice) || !amount(input.shipping) || !["AUCTION", "FIXED_PRICE"].includes(input.buyingOption ?? "") ||
        !Array.isArray(input.images) || input.images.length > 24 || input.images.some((image) => typeof image !== "string" || image.length > 2048 || !/^https:\/\//.test(image)) ||
        (input.endTime !== null && (typeof input.endTime !== "string" || !Number.isFinite(Date.parse(input.endTime))))) {
        throw new ShortlistError("A valid listing snapshot is required.");
    }
    const seller = input.seller;
    return { id: input.id, title: input.title, url: input.url!, currentPrice: input.currentPrice!, shipping: input.shipping!,
        ...(typeof input.termsCheckedAt === "string" && Number.isFinite(Date.parse(input.termsCheckedAt)) ? { termsCheckedAt: input.termsCheckedAt } : {}),
        buyingOption: input.buyingOption!, bids: Number.isInteger(input.bids) && input.bids! >= 0 ? input.bids! : 0,
        isGraded: input.isGraded === true, images: [...input.images], endTime: input.endTime!, bestOffer: input.bestOffer === true,
        seller: seller ? { username: typeof seller.username === "string" ? seller.username.slice(0, 200) : null,
            feedbackPercentage: typeof seller.feedbackPercentage === "number" && Number.isFinite(seller.feedbackPercentage) ? seller.feedbackPercentage : null,
            feedbackScore: Number.isInteger(seller.feedbackScore) ? seller.feedbackScore : null } : null };
}

interface File { version: 1; entries: ShortlistEntry[] }
export function createShortlistStore(file = path.join(DATA_DIR, "shortlist.json")) {
    const data = jsonStore<File>(file, () => ({ version: 1, entries: [] }), (value): value is File => {
        const file = value as File | null;
        return file?.version === 1 && Array.isArray(file.entries) && file.entries.length <= SHORTLIST_LIMIT && file.entries.every((entry) => entry && typeof entry.id === "string" && entry.listing?.id === entry.id && typeof entry.notes === "string" && typeof entry.savedAt === "string");
    });
    return {
        list: async () => (await data.read()).entries,
        save: (listing: ListingSummary, evaluation: Evaluation | null, now = new Date().toISOString()) => data.change((file) => {
            const existing = file.entries.find((entry) => entry.id === listing.id);
            if (existing) return existing;
            if (file.entries.length >= SHORTLIST_LIMIT) throw new ShortlistError(`Your shortlist holds up to ${SHORTLIST_LIMIT} listings. Remove one before saving another.`, 409);
            const entry: ShortlistEntry = { id: listing.id, listing, evaluation, savedAt: now, checkedAt: null, notes: "", ceiling: null, needsAnalysis: !evaluation };
            file.entries.unshift(entry);
            return entry;
        }),
        update: (id: string, edit: (entry: ShortlistEntry) => ShortlistEntry) => data.change((file) => {
            const index = file.entries.findIndex((entry) => entry.id === id);
            if (index < 0) return null;
            file.entries[index] = edit(file.entries[index]);
            return file.entries[index];
        }),
        remove: (id: string) => data.change((file) => { file.entries = file.entries.filter((entry) => entry.id !== id); }),
    };
}
export const shortlistStore = createShortlistStore();
