import { randomUUID } from "node:crypto";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";

// Create once at the explicit command boundary. Reusing this runner keeps
// retries, nested tasks and parallel readings inside one spending/Browse cap.
export function createCliResearchScope() {
    const searchId = randomUUID();
    return <T>(work: () => T): T => withAiUsageContext({ searchId }, work);
}
