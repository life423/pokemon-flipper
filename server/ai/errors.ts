export class AiCreditsError extends Error {
    readonly code = "AI_CREDITS";
    constructor(options?: ErrorOptions) { super("OpenAI credits are exhausted. Add credits to resume new AI analysis. Saved assessments remain available.", options); }
}
export function isAiCreditFailure(error: unknown): boolean {
    const seen = new Set<unknown>();
    for (let current = error; current && typeof current === "object" && !seen.has(current);) {
        seen.add(current);
        const value = current as { code?: string; type?: string; cause?: unknown; error?: { code?: string; type?: string } };
        if (current instanceof AiCreditsError || [value.code, value.type, value.error?.code, value.error?.type].some(code =>
            ["AI_CREDITS", "insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"].includes(code ?? ""))) return true;
        current = value.cause;
    }
    return false;
}
export function createAiCreditGate(now = () => Date.now()) {
    let blockedUntil = 0;
    return { check() { if (now() < blockedUntil) throw new AiCreditsError(); },
        reject(error: unknown) { if (isAiCreditFailure(error)) { blockedUntil = now() + 30_000; throw new AiCreditsError({ cause: error }); } } };
}
