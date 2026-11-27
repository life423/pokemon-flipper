// Bound the whole response, including its body, so a stalled provider cannot
// occupy a concurrency slot indefinitely. No automatic retry spends requests.
export class ProviderError extends Error {
    readonly retryAfterMs?: number;
    constructor(message: string, options?: ErrorOptions & { retryAfterMs?: number }) { super(message, options); this.retryAfterMs = options?.retryAfterMs; }
}

// Limit decoded page reads by received bytes, including chunked responses.
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) throw new ProviderError("The provider returned no response body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
            await reader.cancel();
            throw new ProviderError("Response exceeded the expected size.");
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function fetchJson(
    url: string,
    init: RequestInit,
    { service, timeoutMs = 20_000 }: { service: string; timeoutMs?: number }
): Promise<{ response: Response; body: any }> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    try {
        const response = await fetch(url, { ...init, signal });
        const body = await response.json().catch((error: unknown) => {
            if (signal.aborted) throw error;
            if (response.ok) throw new ProviderError(`${service} returned unreadable data. Please retry later.`, { cause: error });
            return {};
        });
        return { response, body };
    } catch (error) {
        if (deadline.aborted && !init.signal?.aborted) {
            throw new ProviderError(`${service} timed out after ${Math.round(timeoutMs / 1000)} seconds. Please retry later.`, { cause: error });
        }
        throw error;
    }
}
