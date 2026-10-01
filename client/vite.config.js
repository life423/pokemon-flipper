import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React client. In development it runs inside the Express server
// (app.js), so the whole app stays on one port.
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    plugins: [react()],
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
});
