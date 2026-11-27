export function canonicalBaseSet2(key: string): string {
    return /^(?:2000 )?(?:game )?base (?:set (?:2|ii)|ii)$/.test(key) ? "base set 2" : key;
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
