// Bound the whole response, including its body, so a stalled provider cannot
// occupy a concurrency slot indefinitely. No automatic retry spends requests.
export class ProviderError extends Error {}

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
