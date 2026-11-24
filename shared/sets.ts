export function canonicalBaseSet2(key: string): string {
    return /^(?:2000 )?(?:game )?base (?:set (?:2|ii)|ii)$/.test(key) ? "base set 2" : key;
}

export function ordinaryBaseSetPokemonNumber(value: string | null | undefined): boolean {
    const collector = Number(value?.match(/^0*([1-9][0-9]?)\s*\/\s*102$/)?.[1]);
    // Base Set Pokémon are numbered 1–69. Machamp's stamped deck copies
    // are an exception to the ordinary artwork-shadow and stamp rules.
    return collector <= 69 && collector !== 8;
}

// A set's name as a lookup key, so the price sources' spellings match:
// "SWSH09: Brilliant Stars" and "Brilliant Stars" are the same set, and a
// printing in the name ("Base Set (Shadowless)") is still Base Set.
export function setKey(name: string): string {
    return canonicalBaseSet2(name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/^[a-z0-9]+:\s*/, "")
        .replace(/\(.*?\)/g, " ")
        .replace(/\b(pokemon|shadowless|1st edition|first edition|unlimited)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim());
}

// The year a set came out, if known.
export function yearOf(years: Record<string, number>, set: string | null | undefined): number | null {
    return set ? (years[setKey(set)] ?? null) : null;
}
