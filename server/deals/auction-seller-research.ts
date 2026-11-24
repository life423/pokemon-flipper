import type { ListingSummary } from "../../shared/types.ts";
import { auctionPhotoPriority } from "../../shared/auction-research.ts";
import { autoAnalysisBlockReason } from "../../shared/analysis.ts";
import { freshListingTime } from "../../shared/grading-watch.ts";
import { listingDisclosesCardCrease } from "../../shared/ebay-condition-notes.ts";
import { sellerConditionClues } from "../../shared/raw-condition-claim.ts";
import { sellerDisclosedCreasing } from "../../shared/conditions.ts";
import { CCG_INDIVIDUAL_CARDS } from "../ebay/listings.ts";
import { ebayGet, EbayError } from "../ebay/api.ts";
import { EbayBudgetError } from "../ebay/usage.ts";
import { ProviderError } from "../lib/http.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";

type Profile = NonNullable<ListingSummary["auctionResearch"]>;
type InventoryPage = { total?: number; itemSummaries?: { seller?: { username?: string }; categories?: { categoryId: string }[] }[] };
const share = createSharedWork();
const departments = [[CCG_INDIVIDUAL_CARDS, "CCG singles"], ["11450", "clothing"], ["11700", "home and garden"]] as const;
const sellerName = /^[a-z0-9_.-]{1,80}$/i;

export async function sellerAuctionInventory(seller: string, signal?: AbortSignal): Promise<Profile | null> {
    if (!sellerName.test(seller)) return null;
    const key = "auction:seller-inventory:v1:US:" + seller.toLowerCase();
    return share(key, async active => {
        const cached = await readCache<Profile>(key, 24);
        if (cached) return cached;
        const totals: number[] = [];
        for (const [id] of departments) {
            const query = new URLSearchParams({ category_ids: id, limit: "3",
                filter: `sellers:{${seller}},buyingOptions:{AUCTION|FIXED_PRICE}` });
            const page = await ebayGet<InventoryPage>("/buy/browse/v1/item_summary/search?" + query, {signal: active, keepReserve: true});
            const count = page.total;
            const items = page.itemSummaries ?? [];
            if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count < items.length ||
                (count > 0 && !items.length) || items.some(row => row.seller?.username?.toLowerCase() !== seller.toLowerCase() ||
                    !row.categories?.some(category => category.categoryId === id))) return null;
            totals.push(count);
        }
        const profile: Profile = { cardListings: totals[0], otherListings: totals[1] + totals[2],
            categories: departments.map(([, name]) => name), sampledAt: new Date().toISOString() };
        await writeCache(key, profile);
        return profile;
    }, signal);
}

export async function researchAuctionSellers(listings: ListingSummary[], now: number, signal?: AbortSignal,
    lookup = sellerAuctionInventory): Promise<ListingSummary[]> {
    const ranked = listings.map(row => ({ row, priority: auctionPhotoPriority(row, now) }))
        .filter(({ row, priority }) => priority > 0 && row.seller?.username).sort((a,b) => b.priority - a.priority);
    return sampleInventories(listings, ranked.map(({ row }) => row), row => row.buyingOption === "AUCTION", signal, lookup);
}

// The caller has already ranked the matching copies within the buyer's budget.
export async function researchFreshRawSellers(listings: ListingSummary[], now: number, signal?: AbortSignal,
    lookup = sellerAuctionInventory): Promise<ListingSummary[]> {
    const eligible = listings.filter(row => {
        if (row.buyingOption !== "FIXED_PRICE" || row.isGraded || row.match || !sellerName.test(row.seller?.username ?? "") ||
            freshListingTime(row, now) === null || Date.parse(row.endTime ?? "") <= now || autoAnalysisBlockReason(row, now)) return false;
        const condition = sellerConditionClues(row);
        return !condition.severe && !condition.conflict && !listingDisclosesCardCrease(row) &&
            !sellerDisclosedCreasing([`Seller description: ${row.title}`]);
    });
    const eligibleCopies = new Set(eligible);
    return sampleInventories(listings, eligible, row => eligibleCopies.has(row), signal, lookup);
}

async function sampleInventories(listings: ListingSummary[], priority: ListingSummary[], accepts: (row: ListingSummary) => boolean,
    signal: AbortSignal | undefined, lookup: typeof sellerAuctionInventory): Promise<ListingSummary[]> {
    const usernames = [...new Set(priority.map(row => row.seller!.username!.toLowerCase()))].slice(0, 2);
    if (!usernames.length) return listings;
    const profiles = new Map<string, Profile>();
    for (const user of usernames) {
        signal?.throwIfAborted();
        try {
            const profile = await lookup(user, signal);
            if (profile) profiles.set(user, profile);
        } catch (error) {
            signal?.throwIfAborted();
            if (error instanceof EbayBudgetError && error.reason === "QUOTA") break;
            if (!(error instanceof EbayError || error instanceof ProviderError)) throw error;
        }
    }
    return listings.map(row => {
        const profile = row.seller?.username && profiles.get(row.seller.username.toLowerCase());
        return profile && accepts(row) ? { ...row, auctionResearch: profile } : row;
    });
}
