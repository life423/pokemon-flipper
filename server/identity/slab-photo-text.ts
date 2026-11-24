import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ScreeningSoldReference } from "../../shared/types.ts";
import { downloadEbayImage } from "../ai/image-input.ts";
import type { ListingDetails } from "../ebay/listings.ts";
import { readCache, writeCache } from "../lib/cache.ts";
import { createLimiter } from "../lib/concurrency.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";
import { createSharedWork } from "../lib/shared-work.ts";
import { StorageUnavailableError } from "../storage/index.ts";
import { canMatchLabelText, matchesLabelText } from "./matches-label-text.ts";

const run = promisify(execFile);
const reader = fileURLToPath(new URL("./read-slab-text.swift", import.meta.url));
const share = createSharedWork();
const limit = createLimiter(2);
const isTranscript = (value: unknown): value is string[] => Array.isArray(value) && value.every(line => typeof line === "string");

// Store only what the image says. Every comparison checks that text against
// the current listing, certificate and sold market, including on cache hits.
export async function matchesSlabPhoto(listing: ListingDetails, reference: ScreeningSoldReference, signal?: AbortSignal) {
    const image = listing.images[0];
    if (!image || !canMatchLabelText(listing, reference)) return false;
    const key = `collector:slab-photo-text:v1:${image}`;
    const lines = await share(key, async active => {
        const cached = await readCache<unknown>(key, Infinity);
        if (cached !== null) {
            if (!isTranscript(cached)) throw new StorageUnavailableError("The saved slab photo text could not be read.");
            return cached;
        }
        if (process.platform !== "darwin") return null;
        return limit(async () => {
            active.throwIfAborted();
            let text: unknown;
            try {
                requireLiveProvider("EBAY");
                const { bytes } = await downloadEbayImage(image, active);
                const job = run("/usr/bin/swift", [reader], { signal: active, timeout: 8000, maxBuffer: 64_000, encoding: "utf8" });
                // Swift may exit before reading stdin when the local toolchain is unavailable.
                job.child.stdin?.on("error", () => {}).end(bytes);
                text = JSON.parse((await job).stdout);
            } catch {
                active.throwIfAborted();
                return null;
            }
            if (!isTranscript(text)) return null;
            await writeCache(key, text);
            return text;
        });
    }, signal);
    return lines !== null && matchesLabelText(lines, listing, reference);
}
