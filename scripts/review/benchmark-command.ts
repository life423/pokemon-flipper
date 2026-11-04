export type BenchmarkCommand = { mode: "live"; query: string } | { mode: "resume" | "replay"; file: string };

// A live retest continues the original report's search account. It is never a
// second allowance disguised as a replay, nor a way to override its query.
export function benchmarkCommand(args: string[]): BenchmarkCommand {
    const values = new Map<string, string>();
    const flags = new Set<string>();
    for (let index = 0; index < args.length; index++) {
        const option = args[index];
        if (option === "--live") {
            if (flags.has(option)) throw new Error("Duplicate benchmark option.");
            flags.add(option);
        } else if (["--query", "--resume", "--replay"].includes(option)) {
            const value = args[++index];
            if (!value?.trim() || value.startsWith("--") || values.has(option)) throw new Error("A benchmark option requires one value.");
            values.set(option, value);
        } else throw new Error("Unknown benchmark option.");
    }
    const live = flags.has("--live"), query = values.get("--query"), resume = values.get("--resume"), replay = values.get("--replay");
    if (live && resume && !query && !replay) return { mode: "resume", file: resume };
    if (!live && replay && !query && !resume) return { mode: "replay", file: replay };
    if (live && query?.trim() && query.length <= 300 && !resume && !replay) return { mode: "live", query: query.trim() };
    throw new Error("Choose --live --query '<search>', --live --resume <report.json>, or --replay <report.json>.");
}
