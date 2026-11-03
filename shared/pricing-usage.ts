export interface PricingResearchUsage {
    searchId: string;
    limit: number;
    // Durable reservations, including failed/unknown transports. Cache hits
    // consume nothing; a repeated ID or later day does not reset this count.
    used: number;
    remaining: number;
    completed: number;
    pending: number;
    unresolved: number;
    // Provider-reported credit units, not dollars or inferred row charges.
    reportedCredits: number;
    unreportedCreditAttempts: number;
    returnedRows: number;
    unreportedRowAttempts: number;
    // Last observed numeric account headers; not a projected current balance.
    provider: { limit: number | null; remaining: number | null; balance: number | null; resetSeconds: number | null } | null;
}
