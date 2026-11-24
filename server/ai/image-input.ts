import { createLimiter } from "../lib/concurrency.ts";
const limit = createLimiter(3);
const MAX_BYTES = 8 * 1024 * 1024;

export async function downloadEbayImage(url: string, signal: AbortSignal) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "i.ebayimg.com" || parsed.port || parsed.username || parsed.password || !parsed.pathname.startsWith("/images/")) throw new Error("Only public eBay listing images can be downloaded for review.");
    return downloadImage(url, signal);
}

export async function inlineCatalogImage(url: string, signal: AbortSignal): Promise<string> {
    const parsed = new URL(url);
    if (parsed.origin !== "https://assets.tcgdex.net" || parsed.username || parsed.password ||
        !parsed.pathname.startsWith("/en/")) throw new Error("Expected an English TCGdex catalog image.");
    const { type, bytes } = await downloadImage(url, signal);
    return `data:${type};base64,${bytes.toString("base64")}`;
}

function downloadImage(url: string, signal: AbortSignal) {
    return limit(async () => {
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        const type = response.headers.get("content-type")?.split(";")[0];
        if (!response.ok || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type) || !response.body) throw new Error("The image could not be retrieved for AI review.");
        if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("The image exceeds the AI input size limit.");
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read(); if (done) break;
                bytes += value.length; if (bytes > MAX_BYTES) throw new Error("The image exceeds the AI input size limit.");
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        return { type, bytes: Buffer.concat(chunks) };
    });
}

export async function inlineEbayImage(url: string, signal: AbortSignal): Promise<string> {
    const { type, bytes } = await downloadEbayImage(url, signal);
    return `data:${type};base64,${bytes.toString("base64")}`;
}
