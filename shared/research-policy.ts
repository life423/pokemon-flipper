// Automatic research thresholds, shared by preliminary screening and the
// evaluator's verified post-photo identity. Explicit manual research is separate.
export const MIN_AUTOMATIC_RAW_RESALE = 60;
export const CHEAP_FIRST_EDITION_BASE_SET_LIMIT = 10;
// Matching metadata rows admitted from one source page. This is independent
// of the Browse-request cap and the two-cent paid-AI spending cap.
export const DEVELOPMENT_SEARCH_LIMIT = 50;
// Preliminary price requests share the larger all-stage per-search allowance.
// This controls runaway/rate pressure; provider credits are not dollar costs.
export const PRICE_SCREEN_REQUEST_LIMIT = 64;
// Bound in-flight detail/photo work independently of how many rows are shown.
// More candidates can finish through saved evidence or remaining AI budget.
export const BOUNDED_AUTO_CONCURRENCY = 2;
// Maximum supplied photos accepted by the bounded assessment response schema.
export const BOUNDED_PHOTO_LIMIT = 6;
