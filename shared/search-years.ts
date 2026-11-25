import { setKey } from "./sets.ts";
import { hasBaseSetFourthPrint } from "./reprint-release.ts";
import type { SearchIntent } from "./types.ts";

// Release years are search preferences. They are not collector numbers and
// sellers do not have to write them in a listing title.
const YEAR = "(?:(?:19|20)\\d{2}|2100)";
const YEAR_FRAME = "(?:(?:released\\s+)?(?:from|between|during|in)\\s+(?:(?:the\\s+)?(?:release\\s+)?years?\\s+)?)?";
const BEGIN = "(?<![\\w/#$])\\b";
const END = "\\b(?![\\w/]|\\s*/)";
const RANGE = new RegExp(`${BEGIN}${YEAR_FRAME}(${YEAR})\\s*(?:[-–—]|to|through|and)\\s*(${YEAR})${END}`, "gi");
const SINGLE = new RegExp(`${BEGIN}${YEAR_FRAME}(${YEAR})${END}`, "gi");
const BOUND = new RegExp(`${BEGIN}(?:released\\s+)?(no\\s+(?:newer|later|older|earlier)\\s+than|on\\s+or\\s+before|on\\s+or\\s+after|before|after|since|until|through|up\\s+to)\\s+(?:(?:the\\s+)?(?:release\\s+)?year\\s+)?(${YEAR})${END}`, "gi");

interface SearchYears { minYear?: number; maxYear?: number; phrase: string }

function yearMentions(text: string, pattern: RegExp) {
    return [...text.matchAll(pattern)].filter(match => {
        const before = text.slice(0, match.index), after = text.slice(match.index! + match[0].length);
        return !/(?:[/$#]|\b(?:card\s+(?:number|no\.?)|no\.))\s*$/i.test(before) &&
            !/^\s*(?:dollars|usd|bucks)\b/i.test(after);
    });
}

export function readSearchYearConstraint(text: string): SearchYears | "invalid" | null {
    const ranges = yearMentions(text, RANGE), bounds = yearMentions(text, BOUND);
    const [range] = ranges;
    if (range) {
        const minYear = Number(range[1]), maxYear = Number(range[2]);
        if (ranges.length !== 1 || minYear > maxYear || bounds.some(bound =>
            bound.index! < range.index! || bound.index! + bound[0].length > range.index! + range[0].length)) return "invalid";
        return { minYear, maxYear, phrase: range[0] };
    }
    if (bounds.length) {
        const [first, last = first] = bounds;
        const end = last.index! + last[0].length;
        if (bounds.length > 2 || bounds.length === 2 && !/^\s*(?:,\s*(?:and)?|and)\s*$/i.test(text.slice(first.index! + first[0].length, last.index)))
            return "invalid";
        if (yearMentions(text, SINGLE).some(year => year.index! < first.index! || year.index! >= end)) return "invalid";
        let minYear: number | undefined, maxYear: number | undefined;
        for (const bound of bounds) {
            const word = bound[1].toLowerCase(), year = Number(bound[2]);
            if (/newer|later|before|until|through|up\s+to/.test(word)) {
                if (maxYear !== undefined) return "invalid";
                maxYear = year - Number(word === "before");
            } else {
                if (minYear !== undefined) return "invalid";
                minYear = year + Number(word === "after");
            }
        }
        if ((maxYear ?? 2100) < 1900 || (minYear ?? 1900) > 2100 ||
            minYear !== undefined && maxYear !== undefined && minYear > maxYear) return "invalid";
        return { ...(minYear !== undefined && { minYear }), ...(maxYear !== undefined && { maxYear }),
            phrase: text.slice(first.index, end) };
    }
    const years = yearMentions(text, SINGLE);
    return years.length === 1 ? { minYear: Number(years[0][1]), maxYear: Number(years[0][1]), phrase: years[0][0] } : null;
}

export function searchYears(text: string): SearchYears | null {
    const years = readSearchYearConstraint(text);
    return years === "invalid" ? null : years;
}

export function releaseYearText(minYear?: number | null, maxYear?: number | null, rangeSeparator = "–"): string {
    if (minYear == null) return maxYear == null ? "" : `Through ${maxYear}`;
    if (maxYear == null) return `Since ${minYear}`;
    return minYear === maxYear ? String(minYear) : `${minYear}${rangeSeparator}${maxYear}`;
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
    return year !== undefined && (intent.minYear !== undefined && year < intent.minYear || intent.maxYear !== undefined && year > intent.maxYear);
}
