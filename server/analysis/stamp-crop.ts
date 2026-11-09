import { createHash } from "node:crypto";
import sharp from "sharp";
import { inlineEbayImage } from "../ai/image-fallback.ts";
import type { PhotoReport } from "../../shared/types.ts";

type Box = { left: number; top: number; width: number; height: number };
export type StampCrop = { photoNumber: number; box: Box; sourceSha256: string; dataUrl: string };

const INPUT_LIMIT = 8_000_000;
const PREVIEW_SIZE = 320;
const MIN_CARD_WIDTH = 350;

function yellowBorder(data: Buffer): Uint8Array {
    const mask = new Uint8Array(data.length / 3);
    for (let index = 0; index < mask.length; index++) {
        const red = data[index * 3], green = data[index * 3 + 1], blue = data[index * 3 + 2];
        if (red >= 95 && green >= 66 && green >= red * 0.58 && green <= red * 1.02 &&
            red - blue >= 45 && green - blue >= 35) mask[index] = 1;
    }
    return mask;
}

function hasYellowEdges(mask: Uint8Array, width: number, box: Box): boolean {
    // The yellow border is continuous along each side of an upright WotC card.
    // Check inside the corners so their curvature does not affect the fit.
    const inset = Math.max(2, Math.round(box.width * 0.023));
    let left = 0, right = 0, top = 0, bottom = 0;
    for (let sample = 1; sample < 10; sample++) {
        const row = box.top + Math.round(box.height * sample / 10);
        const col = box.left + Math.round(box.width * sample / 10);
        left += Number(mask[row * width + box.left + inset] > 0);
        right += Number(mask[row * width + box.left + box.width - 1 - inset] > 0);
        top += Number(mask[(box.top + inset) * width + col] > 0);
        bottom += Number(mask[(box.top + box.height - 1 - inset) * width + col] > 0);
    }
    return Math.min(left, right, top, bottom) >= 7;
}

function findCard(mask: Uint8Array, width: number, height: number): Box | null {
    const queue = new Int32Array(mask.length);
    let card: Box | null = null;
    for (let start = 0; start < mask.length; start++) {
        if (mask[start] !== 1) continue;
        let end = 0;
        const visit = (index: number) => {
            if (mask[index] !== 1) return;
            mask[index] = 2;
            queue[end++] = index;
        };
        visit(start);
        let left = width, right = 0, top = height, bottom = 0;
        for (let next = 0; next < end; next++) {
            const index = queue[next];
            const x = index % width, y = Math.floor(index / width);
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
            if (x > 0) visit(index - 1);
            if (x < width - 1) visit(index + 1);
            visit(index - width);
            visit(index + width);
        }
        const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
        const aspect = box.width / box.height;
        const coverage = end / (box.width * box.height);
        if (box.height < height * 0.4 || aspect < 0.65 || aspect > 0.79 ||
            coverage < 0.075 || coverage > 0.65 || !hasYellowEdges(mask, width, box)) continue;
        if (card) return null;
        card = box;
    }
    return card;
}

export async function cropStampFromImage(source: Buffer): Promise<Omit<StampCrop, "photoNumber"> | null> {
    const image = sharp(source, { autoOrient: true, limitInputPixels: INPUT_LIMIT });
    const metadata = await image.metadata();
    if ((metadata.pages ?? 1) !== 1) return null;
    const original = metadata.autoOrient;
    const { data, info } = await image.clone().resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: "inside", withoutEnlargement: true })
        .toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const card = findCard(yellowBorder(data), info.width, info.height);
    if (!card || card.width * original.width / info.width < MIN_CARD_WIDTH) return null;

    // The stamp is under the left edge of the art on this card layout.
    // Include that edge and the species strip so the model can verify placement.
    const scaleX = original.width / info.width, scaleY = original.height / info.height;
    const left = Math.floor((card.left + card.width * 0.025) * scaleX);
    const top = Math.floor((card.top + card.height * 0.46) * scaleY);
    const right = Math.ceil((card.left + card.width * 0.31) * scaleX);
    const bottom = Math.ceil((card.top + card.height * 0.64) * scaleY);
    const box = { left, top, width: right - left, height: bottom - top };
    const crop = await image.extract(box).png().toBuffer();
    return { box, sourceSha256: createHash("sha256").update(source).digest("hex"),
        dataUrl: `data:image/png;base64,${crop.toString("base64")}` };
}

export async function selectStampCrop(images: readonly string[], reports: readonly PhotoReport[], signal?: AbortSignal): Promise<StampCrop | null> {
    signal?.throwIfAborted();
    const frontPhotos = reports.filter(report => report.view === "FRONT" && report.usable && !report.isStockImage &&
        !report.obscuresCondition && images[report.number - 1]);
    const attempted = new Set<string>();
    let best: StampCrop | null = null;
    for (const report of frontPhotos) {
        const url = images[report.number - 1].replace(/\/s-l\d+\./, "/s-l1600.");
        if (attempted.has(url)) continue;
        if (attempted.size === 2) break;
        attempted.add(url);
        try {
            const source = await inlineEbayImage(url, signal ?? AbortSignal.timeout(15_000));
            signal?.throwIfAborted();
            const crop = await cropStampFromImage(Buffer.from(source.slice(source.indexOf(",") + 1), "base64"));
            signal?.throwIfAborted();
            if (crop && (!best || crop.box.width > best.box.width)) best = { ...crop, photoNumber: report.number };
        } catch {
            signal?.throwIfAborted();
        }
    }
    return best;
}
