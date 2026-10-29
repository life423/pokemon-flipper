// eBay search thumbnails and full listing photos can use different sizes
// of the same image. Other providers' URLs retain their own identity.
export function normalizedPhoto(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.hostname === "i.ebayimg.com" || parsed.hostname.endsWith(".ebayimg.com")) {
            parsed.pathname = parsed.pathname.replace(/\/s-l\d+(?=\.)/g, "/s-l");
            return parsed.href;
        }
    } catch { /* Compare malformed URLs literally; never fetch client-supplied URLs. */ }
    return url;
}

export function photoEvidenceKey(images: readonly string[]): string {
    return JSON.stringify([...new Set(images.map(normalizedPhoto))]);
}

export function listingEvidenceKey(listing: { title: string; images: readonly string[] }): string {
    return JSON.stringify([listing.title.trim(), photoEvidenceKey(listing.images)]);
}

// A legacy full-details cache has no search snapshot. Search may show only
// a subset, but its lead photo and every supplied photo must still agree.
export function searchPhotosFitDetails(expected: readonly string[], details: readonly string[]): boolean {
    const wanted = [...new Set(expected.map(normalizedPhoto))];
    const available = details.map(normalizedPhoto);
    if (!wanted.length) return !available.length;
    return wanted[0] === available[0] && wanted.every((photo) => available.includes(photo));
}
