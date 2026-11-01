// Visible anomalies and photographic limitations are separate observations.
export const AUTHENTICITY_FEATURES = ["PRINTING", "FONTS", "HOLO", "BACK", "MATERIAL", "ALTERATION"] as const;
export const AUTHENTICITY_JUDGMENTS = ["SUSPICIOUS", "PHOTO_LIMITATION", "NORMAL_FEATURE", "CONDITION_DAMAGE", "IDENTITY_DIFFERENCE"] as const;
export interface AuthenticityObservation {
    // One-based image number within this condition request.
    photoNumber: number;
    feature: (typeof AUTHENTICITY_FEATURES)[number];
    observation: string;
    expected: string;
    judgment: (typeof AUTHENTICITY_JUDGMENTS)[number];
}
