import { VISION_MODEL } from "../ai/policy.ts";
import { PHOTO_REVIEW_REVISION, CONDITION_ASSESSMENT_REVISION } from "../../shared/pricing-freshness.ts";
import { CONDITION_RULES_VERSION } from "../../shared/conditions.ts";
import type { PhotoCheck } from "../../shared/types.ts";

// Read compatibility for already-paid full assessments. Keep these exact
// identifiers while retiring their former multi-stage request writers.
export const ANALYSIS_VERSION = VISION_MODEL + "/prompts-" + PHOTO_REVIEW_REVISION;
export const CONDITION_VERSION = VISION_MODEL + "/condition-" + CONDITION_RULES_VERSION + "/prompts-" + CONDITION_ASSESSMENT_REVISION;
export type IdentityPhotoReading = Pick<PhotoCheck, "cardIdentity" | "printedName" | "printedNumber" | "printingMarks" | "slab" | "cardCount">;
