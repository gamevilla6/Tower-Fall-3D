---
name: 3D preview without WebGL
description: Environment note for keeping physics-based 3D games usable in embedded previews without WebGL.
---

If an embedded preview cannot create a WebGL context, the Three.js renderer may fail even though the game and its CDN modules are otherwise available. A canvas-based projected 3D fallback can preserve visibility and interaction while leaving the Three.js path intact for browsers with WebGL.

**Why:** The screenshot browser lacked a usable WebGL context, so the game initially displayed only an engine error instead of a playable scene.

**How to apply:** When building browser games that depend on WebGL, handle renderer creation failure separately from CDN or physics loading failure, and provide a non-WebGL presentation path when the core gameplay can continue.
