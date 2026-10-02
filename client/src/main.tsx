import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);

// Pokemon Flipper doesn't use a service worker. One left on this address by
// another project serves stale files and stale API answers, so remove it,
// clear its caches, and reload once, clean.
if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        if (registrations.length === 0) return;

        await Promise.all(registrations.map((registration) => registration.unregister()));

        if ("caches" in window) {
            const names = await caches.keys();
            await Promise.all(names.map((name) => caches.delete(name)));
        }

        location.reload();
    });
}
