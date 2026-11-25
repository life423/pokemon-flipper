import { createHash } from "node:crypto";
import sharp from "sharp";
import { inlineEbayImage } from "../ai/image-input.ts";
import type { PhotoReport } from "../../shared/types.ts";

type Box = { left: number; top: number; width: number; height: number };
export type StampCrop = { photoNumber: number; box: Box; sourceSha256: string; dataUrl: string; contextImage?: string };

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
    // A slightly rotated card has sloped sides inside its axis-aligned box.
    // Require a short, continuous yellow run near each side at each sample.
    const depth = Math.max(3, Math.round(box.width * 0.08));
    const yellowEdge = (start: number, step: number) => {
        for (let offset = 0; offset < depth - 1; offset++) {
            const index = start + offset * step;
            if (mask[index] === 2 && mask[index + step] === 2) return 1;
        }
        return 0;
    };
    let left = 0, right = 0, top = 0, bottom = 0;
    for (let sample = 1; sample < 10; sample++) {
        const row = box.top + Math.round(box.height * sample / 10);
        const col = box.left + Math.round(box.width * sample / 10);
        left += yellowEdge(row * width + box.left, 1);
        right += yellowEdge(row * width + box.left + box.width - 1, -1);
        top += yellowEdge(box.top * width + col, width);
        bottom += yellowEdge((box.top + box.height - 1) * width + col, -width);
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

export async function cropStampFromImage(source: Buffer, area: "STAMP" | "ARTWORK" | "REPRINT" = "STAMP"): Promise<Omit<StampCrop, "photoNumber"> | null> {
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
    const left = Math.floor((card.left + card.width * (area === "REPRINT" ? 0.53 : 0.025)) * scaleX);
    const top = Math.floor((card.top + card.height * (area === "REPRINT" ? 0.27 : area === "ARTWORK" ? 0.075 : 0.46)) * scaleY);
    const right = Math.ceil((card.left + card.width * (area === "STAMP" ? 0.31 : area === "REPRINT" ? 1 : 0.985)) * scaleX);
    const bottom = Math.ceil((card.top + card.height * 0.64) * scaleY);
    const box = { left, top, width: right - left, height: bottom - top };
    const crop = await image.extract(box).png().toBuffer();
    return { box, sourceSha256: createHash("sha256").update(source).digest("hex"),
        dataUrl: `data:image/png;base64,${crop.toString("base64")}` };
}

export async function selectStampCrop(images: readonly string[], reports: readonly PhotoReport[], signal?: AbortSignal, includeContext = false): Promise<StampCrop | null> {
    signal?.throwIfAborted();
    const fronts = reports.filter(report => report.view === "FRONT" && report.usable && !report.isStockImage && images[report.number - 1]);
    const clearFronts = fronts.filter(report => !report.obscuresCondition);
    // Glare elsewhere can hide surface wear while the printed stamp area is clear.
    // The reader must see the complete expected region before it can report absence.
    const frontPhotos = clearFronts.length ? clearFronts : fronts;
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
            if (crop && (!best || crop.box.width > best.box.width)) best = { ...crop, photoNumber: report.number, ...(includeContext ? { contextImage: source } : {}) };
        } catch {
            signal?.throwIfAborted();
        }
    }
    return best;
}
