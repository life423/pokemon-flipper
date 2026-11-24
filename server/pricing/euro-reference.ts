const ecbDaily = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const day = 86_400_000;

export function parseEuroReference(xml: string, now: number) {
    const date = xml.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/i)?.[1];
    const usdPerEur = Number(xml.match(/<Cube\s+currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/i)?.[1]);
    if (!date || !Number.isFinite(usdPerEur) || usdPerEur <= 0) return null;
    const timestamp = Date.parse(date + "T00:00:00Z");
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date ||
        timestamp > now || now - timestamp >= 7 * day) return null;
    return { date, usdPerEur };
}

type Rate = ReturnType<typeof parseEuroReference>;
let cached: { expires: number; rate: Rate } | undefined;
let pending: Promise<Rate> | undefined;

export async function latestEuroReference(): Promise<Rate> {
    const now = Date.now();
    if (cached && now < cached.expires) return cached.rate;
    if (pending) return pending;
    pending = (async () => {
        let rate: Rate = null;
        try {
            const response = await fetch(ecbDaily, { signal: AbortSignal.timeout(5000) });
            if (response.ok) rate = parseEuroReference(await response.text(), Date.now());
        } catch { /* EUR offers remain usable when the reference is unavailable. */ }
        const expires = Date.now() + (rate ? 6 * 3_600_000 : 10 * 60_000);
        cached = { rate, expires: rate ? Math.min(expires, Date.parse(rate.date) + 7 * day) : expires };
        return rate;
    })().finally(() => { pending = undefined; });
    return pending;
}
