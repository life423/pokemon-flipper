// eBay Browse API: reads public listings with an application token
// (client credentials). No eBay user ever signs in.

const EBAY_API = "https://api.ebay.com";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export class EbayError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
    }
}

async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt) {
        return cachedToken;
    }

    const credentials = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString(
        "base64"
    );

    const response = await fetch(`${EBAY_API}/identity/v1/oauth2/token`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "https://api.ebay.com/oauth/api_scope",
        }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            `eBay token request failed (${response.status}): ${data.error_description ?? data.error ?? "unknown error"}`
        );
    }

    // Tokens last 2 hours. Refresh a minute early so one never expires
    // in the middle of a request.
    cachedToken = data.access_token as string;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return cachedToken;
}

export async function ebayGet<T>(path: string): Promise<T> {
    const token = await getAccessToken();
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    };

    // Optional: lets eBay quote CALCULATED shipping to your ZIP.
    if (process.env.EBAY_SHIP_TO_ZIP) {
        headers["X-EBAY-C-ENDUSERCTX"] = `contextualLocation=country%3DUS%2Czip%3D${process.env.EBAY_SHIP_TO_ZIP}`;
    }

    const response = await fetch(`${EBAY_API}${path}`, { headers });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new EbayError(
            `eBay request failed (${response.status}): ${data.errors?.[0]?.message ?? "unknown error"}`,
            response.status
        );
    }

    return data as T;
}
