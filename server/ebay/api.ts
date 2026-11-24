// eBay Browse API: reads public listings with an application token
// (client credentials), independently of the buyer account.
import { createHash } from "node:crypto";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { createSingleFlight } from "../lib/single-flight.ts";
import { reserveBrowseRequest } from "./usage.ts";
import { requireBrowseSearchId, reserveSearchBrowseRequest } from "./search-budget.ts";
import { requireLiveProvider } from "../lib/saved-provider-evidence.ts";

const EBAY_API = "https://api.ebay.com";

export function configuredShippingZip(): string | null {
    const zip = process.env.EBAY_SHIP_TO_ZIP?.trim();
    return zip && /^\d{5}(?:-\d{4})?$/.test(zip) ? zip : null;
}

type EbayEnvironment = "production" | "sandbox";
const cachedTokens = new Map<EbayEnvironment, { token: string; expiresAt: number; fingerprint: string }>();
const share = createSingleFlight();
const rejectedCredentials = new Map<EbayEnvironment, { fingerprint: string; until: number }>();

export class EbayAuthenticationError extends ProviderError {}

export class EbayError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

export async function getApplicationToken(environment: EbayEnvironment): Promise<string> {
    const prefix = environment === "sandbox" ? "EBAY_SANDBOX" : "EBAY";
    const clientId = process.env[prefix + "_CLIENT_ID"]?.trim();
    const clientSecret = process.env[prefix + "_CLIENT_SECRET"]?.trim();
    if (!clientId || !clientSecret) {
        throw new EbayAuthenticationError(`eBay credentials are missing. Add ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET to the app's .env file, then restart the app.`);
    }
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const fingerprint = createHash("sha256").update(credentials).digest("hex");
    const cached = cachedTokens.get(environment);
    if (cached?.fingerprint === fingerprint && Date.now() < cached.expiresAt) return cached.token;
    const label = environment === "sandbox" ? "Sandbox" : "Production";
    const rejectedMessage = `eBay rejected the configured credentials. Check that ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are the matching ${label} key pair in .env, then restart the app.`;
    return share(environment + fingerprint, () => requestApplicationToken(environment, credentials, fingerprint, rejectedMessage));
}

async function requestApplicationToken(environment: EbayEnvironment, credentials: string, fingerprint: string, rejectedMessage: string): Promise<string> {
    // Share failed sign-ins too: loading usage and clicking Search must not
    // repeatedly send a rejected key pair. A corrected pair can retry immediately.
    const rejected = rejectedCredentials.get(environment);
    if (rejected?.fingerprint === fingerprint && Date.now() < rejected.until) {
        throw new EbayAuthenticationError(rejectedMessage);
    }

    const host = environment === "sandbox" ? "https://api.sandbox.ebay.com" : EBAY_API;
    const { response, body: data } = await fetchJson(`${host}/identity/v1/oauth2/token`, {
        method: "POST", redirect: "error",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "https://api.ebay.com/oauth/api_scope",
        }),
    }, { service: "eBay sign-in" });

    if (!response.ok) {
        if (response.status === 401 || response.status === 400 && data.error === "invalid_client") {
            rejectedCredentials.set(environment, { fingerprint, until: Date.now() + 60_000 });
            throw new EbayAuthenticationError(rejectedMessage);
        }
        throw new ProviderError(`eBay sign-in failed (${response.status}). Please retry later.`);
    }

    if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 60) {
        throw new ProviderError("eBay sign-in returned an invalid token response. Please retry later.");
    }
    rejectedCredentials.delete(environment);

    // Tokens last 2 hours. Refresh a minute early so one never expires
    // in the middle of a request.
    const token: string = data.access_token;
    cachedTokens.set(environment, { token, expiresAt: Date.now() + (data.expires_in - 60) * 1000, fingerprint });
    return token;
}

export async function ebayGet<T>(path: string, { signal, keepReserve = false }: { signal?: AbortSignal; keepReserve?: boolean } = {}): Promise<T> {
    signal?.throwIfAborted();
    requireLiveProvider("EBAY");
    if (path.startsWith("/buy/browse/")) requireBrowseSearchId();
    const { assertSqlStorageReady } = await import("../storage/index.ts");
    await assertSqlStorageReady();
    signal?.throwIfAborted();
    const token = await getApplicationToken("production");
    signal?.throwIfAborted();
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    // Optional: lets eBay quote CALCULATED shipping to your ZIP.
    const zip = configuredShippingZip();
    if (zip) headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=${encodeURIComponent(`country=US,zip=${zip}`)}`;

    if (path.startsWith("/buy/browse/")) await reserveSearchBrowseRequest(() => reserveBrowseRequest(keepReserve), signal);
    signal?.throwIfAborted();
    const { response, body: data } = await fetchJson(`${EBAY_API}${path}`, { headers, signal }, { service: "eBay" });

    if (!response.ok) {
        throw new EbayError(
            `eBay request failed (${response.status}): ${data.errors?.[0]?.message ?? "unknown error"}`,
            response.status
        );
    }

    return data as T;
}
