import type { GradeRange, Verdict } from "./types";
import { CONDITION_NAMES } from "../../shared/conditions.ts";

export { dollars, percent } from "../../shared/format.ts";

export function timeLeft(endTime: string | null, now: number): string | null {
    if (!endTime) return null;

    const ms = Date.parse(endTime) - now;

    if (ms <= 0) return "Ended";

    const minutes = Math.floor(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${rest}m`;

    return `${rest}m`;
}

export function describeRange({ low, likely, high }: GradeRange): string {
    return likely === null ? `${low} to ${high}` : `${low} to ${high}, likely ${likely}`;
}

const NAMES: Record<string, string> = {
    ...CONDITION_NAMES,
    NOT_STATED: "Not stated",
    NOT_VISIBLE: "Not visible",
    NONE_SEEN: "None seen",
    CANT_TELL: "Can't tell",
    REVERSE_HOLO: "Reverse holo",
    NON_HOLO: "Non-holo",
    FIRST_EDITION: "1st Edition",
    FRONT_DETAIL: "Front close-up",
    BACK_DETAIL: "Back close-up",
    GRADED_SLAB: "Graded slab",
    SLEEVE_OR_TOPLOADER: "Sleeve or toploader",
};

// SCREAMING_CASE from the server, in sentence case.
export function name(value: string | null | undefined): string {
    if (!value) return "\u2014";
    if (NAMES[value]) return NAMES[value];

    const words = value.toLowerCase().split("_");
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);

    return words.join(" ");
}

export type Tone = "buy" | "grade" | "review" | "pass" | "neutral";

export const VERDICTS: Record<Verdict, { label: string; tone: Tone }> = {
    BUY_RAW: { label: "Buy raw", tone: "buy" },
    BUY_AND_GRADE: { label: "Buy and grade", tone: "grade" },
    BUY_GRADED: { label: "Buy graded", tone: "buy" },
    NEEDS_REVIEW: { label: "Needs review", tone: "review" },
    PASS: { label: "Pass", tone: "pass" },
    CANT_PRICE: { label: "Can't price", tone: "neutral" },
};
