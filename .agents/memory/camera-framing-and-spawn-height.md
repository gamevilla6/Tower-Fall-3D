---
name: Camera framing and spawn height
description: Prevent camera-follow framing from feeding back into falling-block spawn height.
---

Base new-block spawn height on the settled tower top, not the camera target. Frame the tower and active block with camera distance, while keeping the look target centered on the actual structure rather than reserved headroom.

**Why:** When spawn elevation depends on camera aim, following a rising tower raises the next spawn point, which can make the camera chase an artificially growing target and lose the base.

**How to apply:** When tuning camera tracking, calculate settled height, active-block height, and framing margin separately. Check both portrait and landscape views, including the 2D fallback projection when WebGL is unavailable.
