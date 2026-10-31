import { searchListings, getListingDetails, shippingCacheScope, type ListingDetails } from "../ebay/listings.ts";
import { checkListingPhotos } from "../ai/openai.ts";
import { normalizeWords, sameSetFamily, sameCardNumber, photoPrinting, printingClaimFromText, noveltyIn, psaBaseLabelPrinting, titleContradiction } from "../identity/card-identity.ts";
import { checkSlab } from "../identity/slab-check.ts";
import { cleanPhotoCard } from "../ai/photo-card-schema.ts";
import { VISION_MODEL } from "../ai/policy.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { loadSaved, reusableRecord, photoFingerprint } from "../analysis/store.ts";
import { ANALYSIS_VERSION } from "../ai/openai.ts";
import { searchAttributes } from "../../shared/search-criteria.ts";
import type { ActiveComparable, ActiveReference, Identity, PhotoCheck, Slab } from "../../shared/types.ts";

const DISCOUNT = 0.05;
const MAX_DETAILS = 6;
const MAX_PHOTO_CHECKS = 3;
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

export function createActiveComparableFinder({ search = searchListings, details = getListingDetails, read = async (urls: string[], listing: ListingDetails) =>
    checkListingPhotos(listing, urls, "ACTIVE_COMP"),
    cached = readCache, save = writeCache, savedAssessment = loadSaved, now = Date.now } = {}) {
    const share = createSingleFlight(); const shareSearch = createSingleFlight(); const sharePhoto = createSingleFlight(); const limit = createLimiter(2);
    return async (identity: Identity, slab: Slab, subjectId: string): Promise<ActiveReference | null> => {
        if (identity.status !== "IDENTIFIED" || slab.status !== "OK" || !slab.grader || !slab.grade || !["HOLO", "NON_HOLO", "REVERSE_HOLO"].includes(identity.finish)) return null;
        const key = `active-comps:v3:${VISION_MODEL}:${shippingCacheScope()}:${JSON.stringify([identity.name, identity.set, identity.cardNumber, identity.printing, identity.finish, slab.grader, slab.grade, subjectId, slab.certNumber])}`;
        return share(key, () => limit(async () => {
            const stored = await cached<{ reference: ActiveReference | null }>(key, 2 / 60);
            if (stored) return stored.reference;
            // Sellers abbreviate numbers and call the same finish foil/holo/RH.
            // Search broadly once; the actual photos enforce exact identity.
            const number = identity.cardNumber?.split("/")[0].replace(/^0+(?=\d)/, "");
            const query = `${identity.name} ${identity.set} ${number} ${slab.grader} ${slab.grade}`;
            try {
                const found = await shareSearch(query, () => search(query, { maxResults: 200, sort: "price", keepReserve: true }));
                const candidates = found.listings.filter(listing => {
                    const attributes = searchAttributes(listing.title);
                    return !titleContradiction(listing.title, identity.set, identity.cardNumber) &&
                        (!attributes.grader || attributes.grader === slab.grader) && (attributes.grade === null || attributes.grade === Number(slab.grade)) &&
                        (!attributes.finish || attributes.finish === identity.finish) && listing.id !== subjectId && listing.buyingOption === "FIXED_PRICE" && listing.isGraded &&
                        listing.currentPrice !== null && listing.currentPrice > 0 && credibleSeller(listing.seller) && live(listing, now());
                })
                    .sort((a, b) => (a.currentPrice! + (a.shipping ?? 0)) - (b.currentPrice! + (b.shipping ?? 0))).slice(0, MAX_DETAILS);
                const accepted: ActiveComparable[] = []; const certs = new Set<string>(); let paidChecks = 0;
                for (const candidate of candidates) {
                    const listing = await details(candidate.id, { maxAgeHours: 1 / 60, keepReserve: true }).catch(() => null);
                    if (!listing || listing.buyingOption !== "FIXED_PRICE" || !live(listing, now()) || !credibleSeller(listing.seller) ||
                        !Number.isFinite(listing.price) || listing.price! <= 0 || listing.shipping === null || !Number.isFinite(listing.shipping) || listing.shipping < 0 || !listing.images.length) continue;
                    if (listing.aspects["Card Number"] && !sameCardNumber(listing.aspects["Card Number"], identity.cardNumber) ||
                        listing.aspects.Language && normalizeWords(listing.aspects.Language) !== "english" ||
                        /\b(signed|autographed|miscut|error|crimp)|\bholo\s*bleed\b|\bdouble\s*holo\b/i.test(listing.title) || listing.aspects.Autographed?.toLowerCase() === "yes") continue;
                    const urls = [...new Set(listing.images)].slice(0, 3);
                    const photoKey = `active-comp-photo:v1:${VISION_MODEL}:${JSON.stringify([listing.title, listing.aspects, urls])}`;
                    const reading = await sharePhoto(photoKey, async () => {
                        const saved = await cached<PhotoCheck>(photoKey, 24 * 365);
                        if (saved && (saved.cardIdentity?.confidence === "HIGH" && saved.slab?.grade && saved.slab.grader || await cached(photoKey, 15 / 60))) return saved;
                        const existing = reusableRecord(await savedAssessment(listing.id), { version: ANALYSIS_VERSION, fingerprint: photoFingerprint(listing.images.slice(0, 24)), title: listing.title });
                        if (existing?.photoCheck) return existing.photoCheck.result;
                        if (paidChecks >= MAX_PHOTO_CHECKS) return null;
                        paidChecks++;
                        const answer = await read(urls, listing);
                        await save(photoKey, answer.result);
                        return answer.result;
                    }).catch(() => null);
                    if (!reading || !matchesActiveSlab(reading, listing, identity, slab)) continue;
                    const certNumber = reading.slab!.certNumber!.replace(/\D/g, "");
                    if (certs.has(certNumber)) continue;
                    certs.add(certNumber);
                    accepted.push({ id: listing.id, title: listing.title, url: listing.url, price: listing.price!, shipping: listing.shipping,
                        total: Math.round((listing.price! + listing.shipping) * 100) / 100, seller: listing.seller!, certNumber, checkedAt: new Date(now()).toISOString() });
                }
                accepted.sort((a, b) => a.total - b.total);
                const reference = accepted.length ? { checkedAt: new Date(now()).toISOString(), grader: slab.grader!, grade: slab.grade!, lowestTotal: accepted[0].total,
                    resalePrice: Math.floor(accepted[0].total * (1 - DISCOUNT) * 100) / 100, discountRate: DISCOUNT, listings: accepted } : null;
                await save(key, { reference });
                return reference;
            } catch { return null; }
        }));
    };
}
export const findActiveComparables = createActiveComparableFinder();
