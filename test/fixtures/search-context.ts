import { test as nodeTest, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { withAiUsageContext } from "../../server/ai/usage-context.ts";

// Provider mocks still pass through real dispatch accounting. Give each test
// the same explicit operation scope that HTTP middleware supplies in the app.
export function test(name: string, run: (context: TestContext) => void | Promise<void>) {
    return nodeTest(name, context => withAiUsageContext({ searchId: randomUUID() }, () => run(context)));
}
