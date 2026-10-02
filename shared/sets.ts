// A set's name as a lookup key, so the price sources' spellings match:
// "SWSH09: Brilliant Stars" and "Brilliant Stars" are the same set, and a
// printing in the name ("Base Set (Shadowless)") is still Base Set.
export function setKey(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/^[a-z0-9]+:\s*/, "")
        .replace(/\(.*?\)/g, " ")
        .replace(/\b(pokemon|shadowless|1st edition|first edition|unlimited)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// The year a set came out, if known.
export function yearOf(years: Record<string, number>, set: string | null | undefined): number | null {
    return set ? (years[setKey(set)] ?? null) : null;
}
