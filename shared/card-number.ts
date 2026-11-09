function parseNumberPart(part: string | undefined) {
    if (part === undefined || part === "") return null;

    const match = part.match(/^([A-Z-]*?)0*(\d+)([A-Z]*)$/);
    return match
        ? { prefix: match[1] + (match[3] ? `:${match[3]}` : ""), value: Number(match[2]) }
        : { prefix: part, value: null };
}

export function normalizeCardNumber(value: unknown) {
    const text = String(value ?? "").toUpperCase().replace(/\s+/g, "").replace(/^#/, "");
    if (!text) return null;

    const parts = text.split("/");
    const number = parseNumberPart(parts[0]);
    const total = parseNumberPart(parts[1]);
    // The GG numerator identifies Galarian Gallery; sellers sometimes write
    // its fixed GG70 denominator as 70. Keep all other prefixes and totals.
    const galleryAlias = parts.length === 2 && number?.prefix === "GG" && number.value !== null &&
        number.value >= 1 && number.value <= 70 && total?.value === 70 && total.prefix === "";
    return {
        number: number?.value ?? null,
        numberPrefix: number?.prefix ?? "",
        total: total?.value ?? null,
        totalPrefix: galleryAlias ? "GG" : total?.prefix ?? "",
    };
}

export function compareCardNumbers(a: unknown, b: unknown): boolean | null {
    const x = normalizeCardNumber(a);
    const y = normalizeCardNumber(b);
    if (!x || !y || x.number === null || y.number === null) return null;
    if (x.number !== y.number || x.numberPrefix !== y.numberPrefix) return false;

    // A partial number can agree with a fraction when the set also matches.
    return x.total === null || y.total === null || x.total === y.total && x.totalPrefix === y.totalPrefix;
}

export function sameCardNumber(a: unknown, b: unknown): boolean {
    return compareCardNumbers(a, b) === true;
}
