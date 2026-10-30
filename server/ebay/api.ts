// eBay Browse API: reads public listings with an application token
// (client credentials). No eBay user ever signs in.
import { createHash } from "node:crypto";
import { fetchJson, ProviderError } from "../lib/http.ts";
import { createSingleFlight } from "../lib/single-flight.ts";

const EBAY_API = "https://api.ebay.com";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
const share = createSingleFlight();
let rejectedCredentials: { fingerprint: string; until: number } | null = null;

export class EbayAuthenticationError extends ProviderError {}

const REJECTED_MESSAGE = "eBay rejected the configured credentials. Check that EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are the matching Production key pair in .env, then restart the app.";

export class EbayError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

async function getAccessToken(): Promise<string> {
    return share("token", requestAccessToken);
}

async function requestAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const clientId = process.env.EBAY_CLIENT_ID?.trim();
    const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
        throw new EbayAuthenticationError("eBay credentials are missing. Add EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to the app's .env file, then restart the app.");
    }
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
        "base64"
    );
    // Share failed sign-ins too: loading usage and clicking Search must not
    // repeatedly send a rejected key pair. A corrected pair can retry immediately.
    const fingerprint = createHash("sha256").update(credentials).digest("hex");
    if (rejectedCredentials && rejectedCredentials.fingerprint === fingerprint && Date.now() < rejectedCredentials.until) {
        throw new EbayAuthenticationError(REJECTED_MESSAGE);
    }

    const { response, body: data } = await fetchJson(`${EBAY_API}/identity/v1/oauth2/token`, {
        method: "POST",
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
            rejectedCredentials = { fingerprint, until: Date.now() + 60_000 };
            throw new EbayAuthenticationError(REJECTED_MESSAGE);
        }
        throw new ProviderError(`eBay sign-in failed (${response.status}). Please retry later.`);
    }

    if (typeof data.access_token !== "string" || !data.access_token || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 60) {
        throw new ProviderError("eBay sign-in returned an invalid token response. Please retry later.");
    }
    rejectedCredentials = null;

    // Tokens last 2 hours. Refresh a minute early so one never expires
    // in the middle of a request.
    cachedToken = data.access_token as string;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return cachedToken;
}

export async function ebayGet<T>(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
    signal?.throwIfAborted();
    const token = await getAccessToken();
    signal?.throwIfAborted();
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    // Optional: lets eBay quote CALCULATED shipping to your ZIP.
    if (process.env.EBAY_SHIP_TO_ZIP) {
        headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=country%3DUS%2Czip%3D${process.env.EBAY_SHIP_TO_ZIP}`;
    }

    const { response, body: data } = await fetchJson(`${EBAY_API}${path}`, { headers, signal }, { service: "eBay" });

    if (!response.ok) {
        throw new EbayError(
            `eBay request failed (${response.status}): ${data.errors?.[0]?.message ?? "unknown error"}`,
            response.status
        );
    }

    return data as T;
}
