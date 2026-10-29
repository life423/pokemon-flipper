// Set the environment before loading the server on Windows, macOS and Linux.
process.env.NODE_ENV = "production";
await import("../server/app.ts");
