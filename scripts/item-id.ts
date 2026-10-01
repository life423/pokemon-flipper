// Accepts an eBay link, a bare item number, or an API ID (v1|...|0).
export function toItemId(input: string | undefined): string | null {
    if (!input) return null;
    if (input.startsWith("v1|")) return input;
    if (/^\d+$/.test(input)) return `v1|${input}|0`;

    const fromLink = input.match(/\/itm\/(?:[^/?]+\/)?(\d+)/);
    return fromLink ? `v1|${fromLink[1]}|0` : null;
}
