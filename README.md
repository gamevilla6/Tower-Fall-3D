# Tower Fall 3D

A mobile-first physics stacking game built with React, Three.js, and Cannon-es.

## GitHub Pages

The repository-root `index.html` is the Vite source entry for Pages. GitHub Pages
cannot execute TSX files directly: use the included GitHub Actions build, not
“Deploy from a branch”.

1. In the repository's **Settings → Pages → Build and deployment**, choose
   **GitHub Actions** as the source.
2. Push these changes to `main` (or run **Build and publish GitHub Pages** from
   the Actions tab).
3. The workflow builds and publishes a static site with `index.html` at its root.
   Use the site URL reported by that workflow.

The production build uses `./` asset URLs, so it works under a repository subpath
or a custom domain without changing the configuration. No backend, Replit
environment variables, or secrets are needed. Three.js and Cannon-es load from
version-pinned HTTPS JSDelivr URLs; Google Fonts also uses HTTPS. An internet
connection is needed to load those external resources.

### Build locally

With Node.js 22 and pnpm 10 installed:

```sh
pnpm install --frozen-lockfile
pnpm --filter @workspace/3d-game run typecheck
pnpm run build:pages
```

The ready-to-host files are in `generated-artifacts/github-pages/`, including its
root `index.html`, `assets/`, favicon, and `.nojekyll`. Upload the whole directory
if using another static host. Generated files are excluded from Git.

The normal Replit app continues to use `artifacts/3d-game/index.html` and the
existing managed workflow. Both entries load the same game source.