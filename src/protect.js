// ── BASIC SOURCE PROTECTION ──────────────────────────────────
// Deters casual users from inspecting the source via browser UI.
// NOTE: This does NOT stop determined users or crawlers.
(function () {
  "use strict";

  // Disable right-click context menu
  document.addEventListener("contextmenu", function (e) {
    e.preventDefault();
  });

  // Block common DevTools keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    // F12 — DevTools toggle
    if (e.key === "F12") {
      e.preventDefault();
      return false;
    }
    // Ctrl+Shift+I — DevTools (Elements / Console)
    // Ctrl+Shift+J — DevTools (Console)
    // Ctrl+Shift+C — Inspect Element
    if (e.ctrlKey && e.shiftKey && ["I", "i", "J", "j", "C", "c"].includes(e.key)) {
      e.preventDefault();
      return false;
    }
    // Ctrl+U — View Page Source
    if (e.ctrlKey && (e.key === "U" || e.key === "u")) {
      e.preventDefault();
      return false;
    }
  });
})();
