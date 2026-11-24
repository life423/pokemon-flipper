import { setKey } from "./sets.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import type { SearchIntent } from "./types.ts";

// Release years are search preferences. They are not collector numbers and
// sellers do not have to write them in a listing title.
const YEAR = "(?:19|20)\\d{2}";
const RANGE = new RegExp(`(?<![\\w/#])\\b(?:(?:from|between)\\s+)?(${YEAR})\\s*(?:[-–—]|to|through|and)\\s*(${YEAR})\\b(?![\\w/])`, "i");
const SINGLE = new RegExp(`(?<![\\w/#])\\b(${YEAR})\\b(?![\\w/]|\\s*\\/)`, "g");

export function searchYears(text: string): { minYear: number; maxYear: number; phrase: string } | null {
    const range = RANGE.exec(text);
    if (range) {
        const minYear = Number(range[1]), maxYear = Number(range[2]);
        return minYear <= maxYear ? { minYear, maxYear, phrase: range[0] } : null;
    }
    const years = [...text.matchAll(SINGLE)];
    return years.length === 1 ? { minYear: Number(years[0][1]), maxYear: Number(years[0][1]), phrase: years[0][0] } : null;
}

export function withoutSearchYears(text: string): string {
    if (/\bbase\s+set\b/i.test(text) && hasBaseSetFourthPrint("Base Set", text)) return text;
    const years = searchYears(text);
    return years ? text.replace(years.phrase, " ").replace(/\s+/g, " ").trim() : text;
}

export function outsideSearchYears(intent: SearchIntent, set: string | null | undefined, title = ""): boolean {
    if (intent.minYear === undefined && intent.maxYear === undefined) return false;
    const releaseYear = set ? intent.releaseYears?.[setKey(set)] : undefined;
    const stated = searchYears(title);
    const year = releaseYear ?? (stated?.minYear === stated?.maxYear ? stated?.minYear : undefined);
    return year !== undefined && (year < (intent.minYear ?? 1900) || year > (intent.maxYear ?? 2099));
}
