"use client";

import { useEffect } from "react";

// Registers the PWA service worker (public/sw.js). Registration failure is
// non-fatal — the app just isn't installable in that browser.
export function RegisterServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((err) => console.warn("service worker registration failed:", err));
    }
  }, []);
  return null;
}
