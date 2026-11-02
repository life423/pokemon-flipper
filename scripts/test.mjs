import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Every suite receives private storage, including older tests that do not
// import an isolation fixture. Provider mocks must not touch real ledgers.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pokemon-test-suite-"));
try {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), "test/**/*.test.*"], {
        stdio: "inherit",
        env: { ...process.env, POKEMON_FLIPPER_DATA_DIR: directory, POKEMON_FLIPPER_STORAGE: "file" },
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    process.exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
