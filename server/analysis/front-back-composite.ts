import sharp from "sharp";
import type { PhotoCheck } from "../../shared/types.ts";
import { inlineEbayImage } from "../ai/image-input.ts";
import { listingExclusion } from "../ebay/filters.ts";
import type { ListingDetails } from "../ebay/listings.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";

export function couldBeFrontBackComposite(listing: ListingDetails, first: PhotoCheck, rest: PhotoCheck): boolean {
    const overview = first.images[0], sides = rest.images;
    if (listing.images.length !== 3 || first.images.length !== 1 || sides.length !== 2 ||
        first.cardCount !== "MULTIPLE" || rest.cardCount !== "ONE" || rest.confidence !== "HIGH" ||
        overview.view !== "OTHER" || !overview.usable || overview.isStockImage ||
        !sides.every(side => side.usable && !side.isStockImage) ||
        !sides.some(side => side.view === "FRONT") || !sides.some(side => side.view === "BACK")) return false;
    const number = first.cardIdentity?.cardNumber, name = first.cardIdentity?.name;
    if (!name || name !== rest.cardIdentity?.name || !number || number !== rest.cardIdentity?.cardNumber ||
        first.cardMatch?.verdict !== "MATCH" || rest.cardMatch?.verdict !== "MATCH") return false;
    const description = [listing.title, ...(listing.conditionNotes ?? [])].join(" ");
    return !listingExclusion({ title: description, itemId: listing.id }) &&
        !/\b(pair|two cards|two copies)\b/i.test(description) &&
        (!listing.aspects["Number of Cards"] || listing.aspects["Number of Cards"] === "1");
}

const SIDE = 96;
function hasVisibleDetail(rgb: Buffer): boolean {
    let total = 0, sumSquares = 0;
    for (let i = 0; i < rgb.length; i += 3) {
        const light = (rgb[i] + 2 * rgb[i + 1] + rgb[i + 2]) / 4;
        total += light;
        sumSquares += light * light;
    }
    const count = rgb.length / 3;
    return sumSquares / count - (total / count) ** 2 > 20 ** 2;
}
// Compare every tile so a shared background cannot
// hide a different card in the center of a seller's photo.
function samePicture(panel: Buffer, photo: Buffer): boolean {
    for (let tileY = 0; tileY < SIDE; tileY += 16) {
        for (let tileX = 0; tileX < SIDE; tileX += 16) {
            let diff = 0;
            for (let y = tileY; y < tileY + 16; y++) {
                const start = (y * SIDE + tileX) * 3;
                for (let i = start; i < start + 16 * 3; i++) diff += Math.abs(panel[i] - photo[i]);
            }
            if (diff > 16 * 16 * 3 * 5) return false;
        }
    }
    return true;
}

/** Only accepts two uncropped, side-by-side repeats of the two full seller photos. */
export async function matchesFrontBackComposite(images: readonly Buffer[]): Promise<boolean> {
    if (images.length !== 3) return false;
    const decoded = images.map(source => sharp(source, { autoOrient: true, limitInputPixels: 2_000_000 }));
    const metadata = await Promise.all(decoded.map(image => image.metadata()));
    if (metadata.some(info => (info.pages ?? 1) !== 1 || info.hasAlpha)) return false;
    const { width, height } = metadata[0].autoOrient;
    const half = Math.floor(width / 2);
    if (half < 80 || height < 80 || metadata.slice(1).some(({ autoOrient: side }) =>
        Math.min(side.width, side.height) < 80 || Math.abs(side.width / side.height - half / height) > 0.02)) return false;
    // Decode the two JPEGs at full resolution so both halves use the same resampling path.
    const preview = (source: ReturnType<typeof sharp>) => source.resize(SIDE, SIDE, { fit: "fill", fastShrinkOnLoad: false }).toColourspace("srgb").removeAlpha().raw().toBuffer();
    const [left, right, one, two] = await Promise.all([
        preview(decoded[0].clone().extract({ left: 0, top: 0, width: half, height })),
        preview(decoded[0].clone().extract({ left: half, top: 0, width: width - half, height })),
        preview(decoded[1]), preview(decoded[2]),
    ]);
    if (!hasVisibleDetail(one) || !hasVisibleDetail(two) || samePicture(one, two)) return false;
    return (samePicture(left, one) && samePicture(right, two)) || (samePicture(left, two) && samePicture(right, one));
}

export async function checkFrontBackComposite(urls: readonly string[], signal: AbortSignal): Promise<boolean | null> {
    try {
        requireLiveProvider("EBAY"); // Skip thumbnail downloads in a saved-only replay.
        const images = await Promise.all(urls.map(async url => {
            const thumbnail = url.replace(/\/s-l\d+\./, "/s-l500.");
            const inline = await inlineEbayImage(thumbnail, signal);
            return Buffer.from(inline.slice(inline.indexOf(",") + 1), "base64");
        }));
        return await matchesFrontBackComposite(images);
    } catch {
        signal.throwIfAborted();
        return null;
    }
}
