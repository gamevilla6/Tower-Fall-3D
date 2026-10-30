---
name: Pages build resolution
description: Why root-level static builds need different React resolution in this pnpm workspace.
---

When building from the repository root, do not force React deduplication against
that root unless React is actually installed there. Let source imports resolve
against the game package instead.

**Why:** pnpm isolates package dependencies. Moving Vite's root to satisfy a
repository-root HTML entry made deduplication resolve React from the workspace
package, which has no React dependency, causing an unresolved JSX runtime.

**How to apply:** When changing the build root or adding another static target,
test a production build with Replit's PORT and BASE_PATH absent, then serve the
output under both a domain root and a repository subpath.
