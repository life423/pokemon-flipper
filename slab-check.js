import { normalizeText } from "./listing-filters.js";

// What the photos show about a slab, checked against the listing's item
// details. The label is the grader's own record, so a slab only passes
// when its label is readable and nothing disagrees with it.

const GRADER_PATTERNS = [
    [/\bpsa\b|professional sports authenticator/, "PSA"],
    [/\bcgc\b|certified guaranty/, "CGC"],
    [/\bbgs\b|beckett/, "BGS"],
    [/\bsgc\b/, "SGC"],
    [/\btag\b/, "TAG"],
];

const CERT_URLS = {
    PSA: (cert) => `https://www.psacard.com/cert/${cert}`,
    CGC: (cert) => `https://www.cgccards.com/certlookup/${cert}/`,
};

// "Professional Sports Authenticator (PSA)" and "PSA" are both PSA.
export function graderCode(text) {
    const value = normalizeText(text);

    if (!value) return null;

    const found = GRADER_PATTERNS.find(([pattern]) => pattern.test(value));
    return found ? found[1] : null;
}

// "MINT 9", "9", "GEM MT 10", and "8.5" become "9", "10", and "8.5".
export function normalizeGrade(text) {
    const match = String(text ?? "").match(/\b(10|[1-9](?:\.5)?)\b/);
    return match ? match[1] : null;
}

function digits(text) {
    const value = String(text ?? "").replace(/\D/g, "");
    return value || null;
}

function qualifierOf(text) {
    const value = String(text ?? "").trim();
    return /^(none|n\/a|null)?$/i.test(value) ? null : value;
}

export function checkSlab(photoCheck, aspects = {}) {
    const slab = photoCheck.slab;

    if (!slab?.present) {
        return {
            status: "NEEDS_REVIEW",
            grader: null,
            grade: null,
            gradeQualifier: null,
            certNumber: null,
            certUrl: null,
            labelText: null,
            caseCondition: "NOT_VISIBLE",
            reasons: ["The photos show a graded case, but its label couldn't be read."],
            concerns: [],
        };
    }

    const grader = graderCode(slab.grader);
    const grade = normalizeGrade(slab.grade);
    const gradeQualifier = qualifierOf(slab.gradeQualifier);
    const labelCert = digits(slab.certNumber);
    const reasons = [];

    if (!grader) reasons.push("The grading company on the label couldn't be read.");
    if (!grade) reasons.push("The grade on the label couldn't be read.");

    // The item details have to agree with the label.
    const listedGrader = graderCode(aspects["Professional Grader"]);
    const listedGrade = normalizeGrade(aspects.Grade);
    const listedCert = digits(aspects["Certification Number"]);

    if (listedGrader && grader && listedGrader !== grader) {
        reasons.push(`The item details say ${listedGrader}, but the label says ${grader}.`);
    }
    if (listedGrade && grade && listedGrade !== grade) {
        reasons.push(`The item details say grade ${listedGrade}, but the label says ${grade}.`);
    }
    if (listedCert && labelCert && listedCert !== labelCert) {
        reasons.push("The cert number in the item details doesn't match the label.");
    }
    if (slab.caseCondition === "CRACKED") {
        reasons.push("The case looks cracked, so the grade may not hold up on resale.");
    }
    if (gradeQualifier) {
        reasons.push(`The label has a qualifier (${gradeQualifier}). Qualified grades sell for less and aren't priced yet.`);
    }
    if (slab.authenticity === "POSSIBLE") {
        reasons.push("The slab or label may not be genuine.");
    }

    const certNumber = labelCert ?? listedCert;

    return {
        status:
            slab.authenticity === "LIKELY_FAKE" ? "LIKELY_FAKE" : reasons.length > 0 ? "NEEDS_REVIEW" : "OK",
        grader,
        grade,
        gradeQualifier,
        certNumber,
        certUrl: grader && certNumber && CERT_URLS[grader] ? CERT_URLS[grader](certNumber) : null,
        labelText: slab.labelText ?? null,
        caseCondition: slab.caseCondition ?? "NOT_VISIBLE",
        reasons,
        concerns: slab.concerns ?? [],
    };
}
