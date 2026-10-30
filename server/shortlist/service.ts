import { getListingDetails, type ListingDetails } from "../ebay/listings.ts";
import { loadSaved } from "../analysis/store.ts";
import { ANALYSIS_VERSION } from "../ai/openai.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { EbayError } from "../ebay/api.ts";
import { listingEvidenceKey, photoEvidenceKey } from "../../shared/listing-evidence.ts";
import { retargetEvaluation } from "../../shared/money/targets.ts";
import { MONEY_CONFIG } from "../../shared/money/config.ts";
import type { Evaluation, ListingSummary, DeeperPhotoReview } from "../../shared/types.ts";
import type { RefreshResult } from "../../shared/shortlist.ts";
import { shortlistStore, ShortlistError } from "./store.ts";
import { readCache } from "../lib/cache.ts";
import { withFreshListing } from "../../shared/fresh-listing.ts";

export function createShortlistService({ store = shortlistStore, details = getListingDetails, load = loadSaved, cached = (id: string) => readCache<ListingDetails>(`ebay:item:${id}`, 24 * 7), now = () => Date.now() } = {}) {
    const limit = createLimiter(2);
    const share = createSingleFlight();
    const failures = new Map<string, { until: number; message: string }>();
    const save = async (listing: ListingSummary) => {
        const record = await load(listing.id);
        const currentDetails = await cached(listing.id);
        if (listing.termsCheckedAt !== currentDetails?.retrievedAt) listing = { ...listing, termsCheckedAt: undefined };
        if (currentDetails?.availability === "UNAVAILABLE") listing = { ...listing, availability: "UNAVAILABLE" };
        const candidate = record?.version === ANALYSIS_VERSION ? record.latestEvaluation : null;
        const fullPhotos = candidate?.evaluation.listing.photos ?? [];
        const matchesSnapshot = candidate && (candidate.evidenceKey === listingEvidenceKey(listing) || candidate.evaluation.listing.title.trim() === listing.title.trim() && photoEvidenceKey(fullPhotos) === photoEvidenceKey(listing.images));
        const matchesCurrentDetails = !currentDetails || candidate?.evaluation.listing.title.trim() === currentDetails.title.trim() && photoEvidenceKey(fullPhotos) === photoEvidenceKey(currentDetails.images);
        const snapshot = matchesSnapshot && matchesCurrentDetails ? candidate!.evaluation : null;
        const review = record?.deeperPhotoReview;
        const evaluation = snapshot ? retargetEvaluation({ ...snapshot, ...(review?.inputKey === snapshot.photoReviewKey ? { deeperPhotoReview: review } : {}) }, MONEY_CONFIG.targets, listing) : null;
        return store.save(evaluation ? withFreshListing(listing, evaluation) : listing, evaluation, new Date(now()).toISOString());
    };
    const remember = async (evaluation: Evaluation, evidenceKey: string) => store.update(evaluation.listing.id, (entry) => {
        if (evaluation.listing.termsCheckedAt) {
            const listing = withFreshListing(entry.listing, evaluation);
            if (listing === entry.listing && listingEvidenceKey(listing) !== evidenceKey) return entry;
            return { ...entry, listing, evaluation: retargetEvaluation(evaluation, MONEY_CONFIG.targets, listing), needsAnalysis: false };
        }
        if (listingEvidenceKey(entry.listing) !== evidenceKey) return entry;
        return { ...entry, evaluation, needsAnalysis: false };
    });
    const rememberReview = async (id: string, review: DeeperPhotoReview) => store.update(id, (entry) => entry.evaluation?.photoReviewKey === review.inputKey
        ? { ...entry, evaluation: retargetEvaluation({ ...entry.evaluation, deeperPhotoReview: review }, MONEY_CONFIG.targets) } : entry);
    const refreshOne = (id: string) => share(id, () => limit(async () => {
        const entry = (await store.list()).find((entry) => entry.id === id);
        if (!entry) return;
        if (entry.checkedAt && now() - Date.parse(entry.checkedAt) < 60_000) return;
        const failure = failures.get(id);
        if (failure && failure.until > now()) throw new ShortlistError(`${failure.message} Wait 30 seconds before retrying.`, 429);
        try {
            let refreshed: ListingDetails;
            try { refreshed = await details(id, { maxAgeHours: 0, keepReserve: true }); }
            catch (error) {
                if (!(error instanceof EbayError && [404, 410].includes(error.status))) throw error;
                await store.update(id, (latest) => ({ ...latest, checkedAt: new Date(now()).toISOString(), listing: { ...latest.listing, availability: "UNAVAILABLE" },
                    evaluation: latest.evaluation ? retargetEvaluation({ ...latest.evaluation, listing: { ...latest.evaluation.listing, availability: "UNAVAILABLE" } }, MONEY_CONFIG.targets) : null }));
                failures.delete(id);
                return;
            }
            await store.update(id, (latest) => {
                const listing: ListingSummary = { ...latest.listing, title: refreshed.title, url: refreshed.url, currentPrice: refreshed.price, shipping: refreshed.shipping,
                    termsCheckedAt: refreshed.retrievedAt ?? new Date(now()).toISOString(),
                    buyingOption: refreshed.buyingOption, bids: refreshed.bids, endTime: refreshed.endTime, images: refreshed.images, seller: refreshed.seller,
                    isGraded: /graded/i.test(refreshed.condition ?? "") && !/ungraded/i.test(refreshed.condition ?? "") || Boolean(refreshed.aspects["Professional Grader"]),
                    bestOffer: refreshed.bestOffer ?? false, cardCondition: refreshed.cardCondition, conditionNotes: refreshed.conditionNotes,
                    availability: refreshed.availability ?? "UNKNOWN", screen: undefined, match: undefined, mistakes: undefined };
                const same = latest.evaluation && latest.evaluation.listing.title.trim() === refreshed.title.trim() &&
                    photoEvidenceKey(latest.evaluation.listing.photos ?? latest.listing.images) === photoEvidenceKey(refreshed.images);
                const evaluation = same && latest.evaluation ? retargetEvaluation({ ...latest.evaluation, listing: { ...latest.evaluation.listing,
                    title: refreshed.title, url: refreshed.url, price: refreshed.price, shipping: refreshed.shipping, buyingOption: refreshed.buyingOption,
                    bids: refreshed.bids, endTime: refreshed.endTime, seller: refreshed.seller, availability: listing.availability } }, MONEY_CONFIG.targets) : null;
                return { ...latest, listing, evaluation, needsAnalysis: !evaluation, checkedAt: new Date(now()).toISOString() };
            });
            failures.delete(id);
        } catch (error) {
            const message = (error as Error).message;
            if (failures.size >= 200) failures.delete(failures.keys().next().value!);
            failures.set(id, { until: now() + 30_000, message });
            throw error;
        }
    }));
    return { save, remember, rememberReview, async refresh(ids: string[]): Promise<RefreshResult> {
        const errors: RefreshResult["errors"] = [];
        await Promise.all(ids.map(async (id) => { try { await refreshOne(id); } catch (error) { errors.push({ id, message: (error as Error).message }); } }));
        return { entries: await store.list(), errors };
    } };
}
export const shortlistService = createShortlistService();
