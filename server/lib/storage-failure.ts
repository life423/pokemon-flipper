import { StorageUnavailableError } from "../storage/index.ts";

// SDKs wrap custom transport failures. Preserve a storage stop rather than
// retrying a cache outage as a provider/network failure.
export function storageFailure(error: unknown): StorageUnavailableError | null {
    const seen = new Set<unknown>();
    for (let current = error; current && typeof current === "object" && !seen.has(current);) {
        seen.add(current);
        if (current instanceof StorageUnavailableError) return current;
        const value = current as { code?: unknown; cause?: unknown };
        if (value.code === "STORAGE_UNAVAILABLE") return new StorageUnavailableError();
        current = value.cause;
    }
    return null;
}
