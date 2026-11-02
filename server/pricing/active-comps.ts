import { searchListings, getListingDetails, shippingCacheScope, type ListingDetails } from "../ebay/listings.ts";
import { checkListingPhotos } from "../ai/openai.ts";
import { normalizeWords, sameSetFamily, sameCardNumber, photoPrinting, printingClaimFromText, noveltyIn, psaBaseLabelPrinting, titleContradiction } from "../identity/card-identity.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { cleanPhotoCard } from "../ai/photo-card-schema.ts";
import { VISION_MODEL } from "../ai/policy.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { createLimiter, mapLimit } from "../lib/concurrency.ts";
import { AI_CONCURRENCY } from "../../shared/work-limits.ts";
import { loadSaved, reusableRecord, photoFingerprint } from "../analysis/store.ts";
import { ANALYSIS_VERSION } from "../ai/openai.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import type { ActiveComparable, ActiveReference, Identity, PhotoCheck, Slab } from "../../shared/types.ts";

const DISCOUNT = 0.05;
const credibleSeller = (seller: ListingDetails["seller"]) => Boolean(seller && (seller.feedbackScore ?? 0) >= 100 && (seller.feedbackPercentage ?? 0) >= 98.5);
const live = (listing: Pick<ListingDetails, "availability" | "endTime">, now: number) => listing.availability !== "UNAVAILABLE" && (!listing.endTime || Date.parse(listing.endTime) > now);

export function matchesActiveSlab(reading: PhotoCheck, listing: ListingDetails, identity: Identity, target: Slab): boolean {
    if (reading.cardCount !== "ONE" || reading.holder !== "GRADED_SLAB" || !reading.cardIdentity || !reading.slab?.present ||
        !reading.images.some(image => image.view === "FRONT" && image.usable && !image.isStockImage)) return false;
    const card = cleanPhotoCard(reading.cardIdentity);
    if (card.confidence !== "HIGH" || !card.evidence.length || normalizeWords(card.language) !== "english" ||
        normalizeWords(card.name) !== normalizeWords(identity.name) || !sameSetFamily(card.set, identity.set) ||
        !sameCardNumber(card.cardNumber, identity.cardNumber) || card.finish !== identity.finish ||
        reading.printingMarks?.reprintMark !== "NONE_SEEN") return false;
    const slab = checkSlab(reading, listing.aspects);
    if (slab.status !== "OK" || !slab.certNumber || !slab.labelText || slab.grader !== target.grader || slab.grade !== target.grade ||
        !["INTACT", "SCUFFED"].includes(slab.caseCondition) || target.certNumber && slab.certNumber === target.certNumber) return false;
    const baseSet = sameSetFamily(identity.set, "Base Set");
    const visible = photoPrinting(reading.printingMarks, { shadowMatters: baseSet });
    const label = printingClaimFromText(slab.labelText);
    if (slab.grader === "PSA" && baseSet && identity.printing === "SHADOWLESS" && label !== "SHADOWLESS") return false;
    const printing = psaBaseLabelPrinting(reading.slab, card) ?? (label === "NOT_STATED" ? visible : label);
    return printing === identity.printing && !noveltyIn(listing.title);
}

export function createActiveComparableFinder({ search = searchListings, details = getListingDetails, read = async (urls: string[], listing: ListingDetails, signal?: AbortSignal) =>
    checkListingPhotos(listing, urls, "ACTIVE_COMP", signal),
    cached = readCache, save = writeCache, savedAssessment = loadSaved, now = Date.now } = {}) {
    const share = createSharedWork(); const shareSearch = createSharedWork(); const sharePhoto = createSharedWork(); const limit = createLimiter(AI_CONCURRENCY);
    return async (identity: Identity, slab: Slab, subjectId: string, signal?: AbortSignal): Promise<ActiveReference | null> => {
        if (identity.status !== "IDENTIFIED" || slab.status !== "OK" || !slab.grader || !slab.grade || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish)) return null;
        const key = `active-comps:v5:${VISION_MODEL}:${shippingCacheScope()}:${JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish, slab.grader, slab.grade, subjectId, slab.certNumber])}`;
        return share(key, jobSignal => limit(async () => {
            jobSignal.throwIfAborted();
            const stored = await cached<{ reference: ActiveReference | null }>(key, 2 / 60);
            jobSignal.throwIfAborted();
            if (stored) return stored.reference;
            // Sellers abbreviate numbers and call the same finish foil/holo/RH.
            // Search broadly once; the actual photos enforce exact identity.
            const number = identity.cardNumber?.split("/")[0].replace(/^0+(?=\d)/, "");
            const query = `${identity.name} ${identity.set} ${number} ${slab.grader} ${slab.grade}`;
            try {
                const found = await shareSearch(query, searchSignal => search(query, { maxResults: 200, sort: "price", keepReserve: true, signal: searchSignal }), jobSignal);
                jobSignal.throwIfAborted();
                const candidates = found.listings.filter(listing => {
                    const attributes = searchAttributes(listing.title);
                    return !titleContradiction(listing.title, identity.set, identity.cardNumber) &&
                        (!attributes.grader || attributes.grader === slab.grader) && (attributes.grade === null || attributes.grade === Number(slab.grade)) &&
                        (!attributes.finish || attributes.finish === identity.finish) && listing.id !== subjectId && listing.buyingOption === "FIXED_PRICE" && listing.isGraded &&
                        listing.currentPrice !== null && listing.currentPrice > 0 && credibleSeller(listing.seller) && live(listing, now());
                })
                    .sort((a, b) => (a.currentPrice! + (a.shipping ?? 0)) - (b.currentPrice! + (b.shipping ?? 0)));
                const accepted: ActiveComparable[] = []; const certs = new Set<string>();
                await mapLimit(candidates, AI_CONCURRENCY, async candidate => {
                    jobSignal.throwIfAborted();
                    const listing = await details(candidate.id, { maxAgeHours: 1 / 60, keepReserve: true }).catch(() => null);
                    jobSignal.throwIfAborted();
                    if (!listing || listing.buyingOption !== "FIXED_PRICE" || !live(listing, now()) || !credibleSeller(listing.seller) ||
                        !Number.isFinite(listing.price) || listing.price! <= 0 || listing.shipping === null || !Number.isFinite(listing.shipping) || listing.shipping < 0 || !listing.images.length) return;
                    if (listing.aspects["Card Number"] && !sameCardNumber(listing.aspects["Card Number"], identity.cardNumber) ||
                        listing.aspects.Language && normalizeWords(listing.aspects.Language) !== "english" ||
                        /\b(signed|autographed|miscut|error|crimp)|\bholo\s*bleed\b|\bdouble\s*holo\b/i.test(listing.title) || listing.aspects.Autographed?.toLowerCase() === "yes") return;
                    const urls = [...new Set(listing.images)].slice(0, 24);
                    const photoKey = `active-comp-photo:v1:${VISION_MODEL}:${JSON.stringify([listing.title, listing.aspects, urls])}`;
                    const reading = await sharePhoto(photoKey, async photoSignal => {
                        const saved = await cached<PhotoCheck>(photoKey, 24 * 365);
                        // An unreadable label or mismatch remains evidence for
                        // these unchanged photos; waiting cannot add detail.
                        if (saved) return saved;
                        const existing = reusableRecord(await savedAssessment(listing.id), { version: ANALYSIS_VERSION, fingerprint: photoFingerprint(listing.images.slice(0, 24)), title: listing.title });
                        if (existing?.photoCheck) return existing.photoCheck.result;
                        photoSignal.throwIfAborted();
                        const answer = await read(urls, listing, photoSignal);
                        await save(photoKey, answer.result);
                        return answer.result;
                    }, jobSignal).catch(() => { jobSignal.throwIfAborted(); return null; });
                    jobSignal.throwIfAborted();
                    if (!reading || !matchesActiveSlab(reading, listing, identity, slab)) return;
                    const certNumber = checkSlab(reading, listing.aspects).certNumber!;
                    if (certs.has(certNumber)) return;
                    certs.add(certNumber);
                    accepted.push({ id: listing.id, title: listing.title, url: listing.url, price: listing.price!, shipping: listing.shipping,
                        total: Math.round((listing.price! + listing.shipping) * 100) / 100, seller: listing.seller!, certNumber, checkedAt: new Date(now()).toISOString() });
                });
                jobSignal.throwIfAborted();
                accepted.sort((a, b) => a.total - b.total);
                const reference = accepted.length ? { checkedAt: new Date(now()).toISOString(), grader: slab.grader!, grade: slab.grade!, lowestTotal: accepted[0].total,
                    resalePrice: Math.floor(accepted[0].total * (1 - DISCOUNT) * 100) / 100, discountRate: DISCOUNT, listings: accepted } : null;
                await save(key, { reference });
                return reference;
            } catch { jobSignal.throwIfAborted(); return null; }
        }), signal);
    };
}
export const findActiveComparables = createActiveComparableFinder();
