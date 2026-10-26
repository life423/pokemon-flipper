// Ordinary CGC grade descriptions, matched to the numeric grade. Keep unknown,
// mixed, legacy and special labels separate from plain-grade sale evidence.
// Source: https://www.cgccards.uk/card-grading/grading-scale/
const CGC_DESCRIPTIONS: Record<string, readonly string[]> = {
    "10": ["GEMMINT"],
    "9.5": ["MINT+"],
    "9": ["MINT"],
    "8.5": ["NMMINT+", "NEARMINTMINT+"],
    "8": ["NMMINT", "NEARMINTMINT"],
    "7.5": ["NEARMINT+", "NM+"],
    "7": ["NEARMINT", "NM"],
    "6.5": ["EXNM+", "EXCELLENTNEARMINT+"],
    "6": ["EXNM", "EXCELLENTNEARMINT"],
    "5.5": ["EXCELLENT+", "EX+"],
    "5": ["EXCELLENT", "EX"],
    "4.5": ["VGEX+", "VERYGOODEXCELLENT+"],
    "4": ["VGEX", "VERYGOODEXCELLENT"],
    "3.5": ["VERYGOOD+", "VG+"],
    "3": ["VERYGOOD", "VG"],
    "2.5": ["GOOD+"],
    "2": ["GOOD"],
    "1.5": ["FAIR"],
    "1": ["POOR"],
};

export function gradeQualifier(text: unknown, grader: string | null, grade: string | null): string | null {
    const value = String(text ?? "").trim();
    if (/^(none|n\/a|null)?$/i.test(value)) return null;

    // Exact aliases only: removing separators cannot strip OC, altered,
    // Pristine, Perfect or any other additional designation from a label.
    const description = value.toUpperCase().replace(/[\s/._-]+/g, "");
    if (grader === "CGC" && grade && CGC_DESCRIPTIONS[grade]?.includes(description)) return null;

    return value;
}
