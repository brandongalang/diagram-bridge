# Changelog

## 0.1.1 — 2026-10-02

- Load the browser renderer only for PNG snapshots. Local medians across nine runs on macOS arm64 with Node 26.7: `read` 313 → 126 ms, `pull` 298 → 122 ms, `help` 280 → 104 ms, and `schema` 281 → 103 ms.
- Reuse connector routes when selection, node labels, or notes change. Geometry changes invalidate the cache; edge changes invalidate the affected route. A 100-node, 150-edge fixture performs zero additional route calculations across eight selection updates after its first render.
- Separate canvas projection and route caching from the React component, and share keyboard focus handling between history and agent handoff panels.
- Restore focus when closing a sidebar with Escape. Escape in a field outside the sidebar leaves it open.
- Select handoff instructions after clipboard failure when focus remains in the panel, preserve outside focus after delayed failure, and announce successful copying.
- Keep Undo history unchanged when Escape cancels an unedited diagram title.

Validation: 114 automated tests, TypeScript checking, production build, and an installation outside the checkout with revisioned PNG export. Browser checks use Aside at desktop and narrow viewport sizes; timing results are local measurements, not cross-device guarantees.
