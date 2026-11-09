// Isolated saved-metadata experiment. No app queue, photo assessment or model
// default changes; one exact-input text request shares the original allowance.
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildListingPriorityExperiment, validateListingPriorityResult } from "./review/listing-priority.ts";
import { createBenchmarkTransport } from "./review/benchmark-transport.ts";
import { EBAY_SEARCH_BROWSE_LIMIT } from "../server/ebay/search-budget.ts";
import { candidateAdmission } from "./review/benchmark-results.ts";
import { compareAnalysisPriority } from "../shared/analysis-priority.ts";
import { createModelExperimentRunner } from "../server/analysis/model-experiment.ts";
import { runStructured } from "../server/ai/openai.ts";
import { AI_SEARCH_HARD_CAP_USD, aiSpending } from "../server/ai/spending.ts";
import { withAiUsageContext } from "../server/ai/usage-context.ts";
import { assertSqlStorageReady, closeDatabase, storageBackend } from "../server/storage/index.ts";
import type { Evaluation, ListingSummary, Targets } from "../shared/types.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function compareListingPriority(args = process.argv.slice(2)) {
    const [mode, option, sourceArg, ...extra] = args;
    if (!["--live", "--replay"].includes(mode) || option !== "--report" || !sourceArg || extra.length) throw new Error("Use --live or --replay --report <saved bounded-search report.json>. No new search or allowance is created.");
    const live = mode === "--live", sourceFile = path.resolve(sourceArg);
    if (!sourceFile.startsWith(path.resolve("data/search-benchmarks") + path.sep)) throw new Error("The original report must be inside ignored data/search-benchmarks/.");
    const source = JSON.parse(await fs.readFile(sourceFile, "utf8"));
    const recordedAiCap = source.settings?.aiCapUsd;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(source.searchId) ||
        !source.summary?.intent || typeof source.query !== "string" || !source.query.trim() || source.query.length > 300 ||
        !Number.isFinite(recordedAiCap) || recordedAiCap < 0 || recordedAiCap > AI_SEARCH_HARD_CAP_USD ||
        ![25, 50, EBAY_SEARCH_BROWSE_LIMIT].includes(source.settings?.browseCap) ||
        !Array.isArray(source.listings) || source.listings.length < 1 || source.listings.length > 50 ||
        !Number.isFinite(Date.parse(source.startedAt))) throw new Error("An original capped search report and its pre-photo metadata are required.");
    // Production eligibility reads the current auction clock. Restrict this
    // historical diagnostic to BIN so a replay cannot silently change its
    // input when an auction enters or leaves the twelve-hour window.
    if (source.settings.filters?.typeFilter !== "FIXED_PRICE" || source.listings.some((row: ListingSummary) => row.buyingOption !== "FIXED_PRICE")) {
        throw new Error("This saved-metadata comparison currently requires Buy It Now listings; auction-clock replay is not implemented.");
    }
    const searchId: string = source.searchId, targets: Targets = source.settings.targets;
    if (!targets || !Number.isFinite(targets.minProfit) || !Number.isFinite(targets.minRoi)) throw new Error("Original targets are required.");
    // Deliberately exclude source.final, queue.evaluations and listing details
    // from model input: those contain answers learned after photos were bought.
    const listings = source.listings as ListingSummary[];
    const eligible = listings.filter(row => candidateAdmission(row, source.settings.filters, Date.parse(source.startedAt), targets).eligible)
        .sort((a, b) => compareAnalysisPriority(a, b, targets));
    if (eligible.length < 2) throw new Error("Fewer than two eligible candidates need no paid ranking comparison.");
    const packet = buildListingPriorityExperiment(eligible, source.query);
    const sourceKey = `listing-priority:v1:${hash({ query: source.query, input: packet.input })}`;
    const directory = path.resolve("data/candidate-validation/2026-11-04/text-priority", `${new Date().toISOString().replace(/[:.]/g, "-")}-${live ? "live" : "replay"}`);
    await fs.mkdir(directory, { recursive: true });
    const stopped = new AbortController(), stop = () => stopped.abort(new Error("Text diagnostic stopped; no new paid dispatch is allowed."));
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const originalFetch = globalThis.fetch;
    const observer = createBenchmarkTransport({ live, fetch: originalFetch, allowAzureAuth: true, context: () => ({ searchId, phase: "text-priority" }),
        limits: { ebayBrowse: 0, prices: 0, aiGeneration: 1, aiPreflight: 1 } });
    // The shared observer records images but does not cap CDN downloads. This
    // diagnostic permits neither photos nor any marketplace request at all.
    globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname.endsWith("ebayimg.com")) throw new Error("No image request is allowed in a text-priority experiment.");
        return observer.fetch(input, init);
    };
    const experiment = createModelExperimentRunner({ run: request => {
        if (!live) throw new Error("Saved ranking unavailable; replay cannot buy a replacement.");
        return runStructured({ ...request, dispatchSignal: AbortSignal.any([request.dispatchSignal, stopped.signal]) });
    } });
    const report: Record<string, any> = { mode, startedAt: new Date().toISOString(), sourceFile, searchId, sourceKey, input: packet.input,
        sourceRows: listings.length, eligibleBeforePhotos: eligible.length,
        candidates: packet.candidates, productionQueueChanged: false, maximumNewGenerations: live ? 1 : 0,
        limitations: ["Historical metadata only; no current availability or purchase advice.", "Only a subset has photo outcomes; missed-Deal recall and avoided costs cannot be established."] };
    try {
        if (live && storageBackend() !== "azure-sql") throw new Error("Live experiments require shared SQL dispatch claims.");
        if (live) await assertSqlStorageReady();
        report.budgetBefore = await aiSpending.summary(searchId);
        if (report.budgetBefore.attempts < 1) throw new Error("The original paid search account must already exist; no replacement allowance is authorized.");
        if (live && report.budgetBefore.capUsd > recordedAiCap) throw new Error("The current cap exceeds the original report allowance.");
        // Stop cancels dispatch through the transport wrapper above. Keep this
        // consumer attached so an accepted answer finishes saving before SQL
        // closes, exactly as in the saved-photo comparison diagnostic.
        report.answer = await withAiUsageContext({ searchId }, () => experiment({ sourceKey, model: "gpt-6-luna", request: packet.request,
            validate: value => validateListingPriorityResult(value, packet.candidates) }));
        const proposedIds = report.answer.result.top.map((entry: { key: string }) => packet.candidates.find(candidate => candidate.key === entry.key)!.listingId);
        // These labels are consulted only AFTER the model has answered. An
        // unassessed choice has unknown value; it is not counted as a success.
        const outcomes = (ids: string[]) => ids.map(id => {
            const value: Evaluation | undefined = source.queue?.evaluations?.[id];
            return { listingId: id, eligibleBeforePhotos: eligible.some(row => row.id === id),
                historicalOutcome: value?.underwriting?.verdict ?? "UNASSESSED", assessed: value !== undefined };
        });
        report.baselineTop = outcomes(eligible.slice(0, 8).map(row => row.id));
        report.suggestedTop = outcomes(proposedIds);
        report.actualAvoidedPhotoRequests = 0;
        observer.assertNoBlock();
    } catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
    finally {
        try {
            report.budgetAfter = await aiSpending.summary(searchId);
            if (report.budgetBefore) report.costDelta = {
                settledUsd: Number((report.budgetAfter.settledUsd - report.budgetBefore.settledUsd).toFixed(9)),
                heldUsd: Number((report.budgetAfter.heldUsd - report.budgetBefore.heldUsd).toFixed(9)),
                attempts: report.budgetAfter.attempts - report.budgetBefore.attempts,
            };
            report.transport = observer.snapshot(); report.transports = observer.records; report.completedAt = new Date().toISOString();
            await fs.writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
        } finally {
            globalThis.fetch = originalFetch;
            process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
            await closeDatabase();
        }
    }
    process.stdout.write(JSON.stringify({ report: path.join(directory, "report.json"), error: report.error ?? null,
        costDelta: report.costDelta, transport: report.transport, budgetAfter: report.budgetAfter }, null, 2) + "\n");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await compareListingPriority();
