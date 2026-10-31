import { createLimiter } from "../lib/concurrency.ts";
const limit = createLimiter(3);
const MAX_BYTES = 8 * 1024 * 1024;

// OpenAI occasionally cannot fetch an otherwise public eBay image. Only that
// failure gets one inline-image fallback, never arbitrary server-side URLs.
export function canRetryImageDownload(error: unknown): boolean {
    const value = error as { status?: number; message?: string };
    return value?.status === 400 && /unable to download|image.*download|download.*(?:image|content)/i.test(value.message ?? "");
}
export async function inlineEbayImage(url: string, signal: AbortSignal): Promise<string> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "i.ebayimg.com" || parsed.port || parsed.username || parsed.password || !parsed.pathname.startsWith("/images/")) throw new Error("Only public eBay listing images can use the image fallback.");
    return limit(async () => {
        const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
        const type = response.headers.get("content-type")?.split(";")[0];
        if (!response.ok || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type) || !response.body) throw new Error("The listing image could not be retrieved for AI review.");
        if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("The listing image exceeds the AI fallback size limit.");
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
        try {
            while (true) {
                const { done, value } = await reader.read(); if (done) break;
                bytes += value.length; if (bytes > MAX_BYTES) throw new Error("The listing image exceeds the AI fallback size limit.");
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
    });
}
