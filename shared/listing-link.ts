export interface ListingLink { itemId: string; url: string }
const NUMBER = /^\d{9,15}$/;

// Extract identifiers only. The server never follows or fetches submitted URLs.
export function parseListingLink(value: unknown): ListingLink | null {
    if (typeof value !== "string" || value.length > 8192) return null;
    const input = value.trim();
    let id: string; let variation = "0";
    if (NUMBER.test(input)) id = input;
    else {
        const api = /^v1\|(\d{9,15})\|(\d{1,15})$/.exec(input);
        if (api) { id = api[1]; variation = api[2]; }
        else {
            let url: URL;
            try { url = new URL(/^((www|m)\.)?ebay\.com\//i.test(input) ? `https://${input}` : input); } catch { return null; }
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
                !(url.hostname === "ebay.com" || url.hostname.endsWith(".ebay.com"))) return null;
            const match = /^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/.exec(url.pathname);
            if (!match) return null;
            id = match[1];
            const variants = url.searchParams.getAll("var");
            if (variants.length > 1 || variants.length && !/^\d{1,15}$/.test(variants[0])) return null;
            variation = variants[0] ?? "0";
        }
    }
    return { itemId: `v1|${id}|${variation}`, url: `https://www.ebay.com/itm/${id}${variation !== "0" ? `?var=${variation}` : ""}` };
}

export function looksLikeListingLink(value: string): boolean {
    const input = value.trim();
    return Boolean(parseListingLink(input)) || /^(?:[a-z][a-z\d+.-]*:\/\/|(?:www\.|m\.)?ebay\.|v1\|)/i.test(input);
}
