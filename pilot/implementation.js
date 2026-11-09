/*
 * Standalone circular frame-scrub pilot, adapted from oil-motion's
 * assets/interactive-motion.ts (shortestCircularDelta + smoothDamp).
 * No build step or runtime dependencies. Serve over HTTP rather than file://.
 *
 * motion_pipeline.py atlas fields are used without renaming:
 * version, type, asset, frameCount, columns, rows, cellWidth, cellHeight,
 * atlasWidth, atlasHeight, files.
 * ../build/timeline.json must be compiled from the actual final frames. It
 * supplies schemaVersion: 1, fps, frameDuration: 1/fps, frameCount, and one
 * segment with start, hold and endExclusive. No requested-duration fallback.
 *
 * Add measured directions to ../final/motion.json after sampling:
 * "pointerMapping": {
 *   "anglesDegrees": [-135, -120, ...],  // one per atlas frame, screen atan2
 *   "restFrame": 0,
 *   "headAnchor": { "x": 0.38, "y": 0.28 }, // fractions of the full cell
 *   "smoothTime": 0.11
 * }
 * Screen angles: right=0, down=90, left=180, up=-90; positive is clockwise.
 * Do not include a duplicate closing frame. Nonuniform sample angles work.
 * The approximate -135-degree starting pose is not silently treated as a
 * measured angle: absent/invalid mapping keeps this pilot static.
 */
(() => {
  "use strict";

  const MANIFEST_URL = new URL("../final/motion.json", document.baseURI);
  const TIMELINE_URL = new URL("../build/timeline.json", document.baseURI);
  const DEFAULT_ATLAS_URL = new URL("../final/motion.webp", document.baseURI);
  const stage = document.querySelector("#stage");
  const character = document.querySelector("#character");
  const fallback = document.querySelector("#fallback");
  const sprite = document.querySelector("#sprite");
  const status = document.querySelector("#status");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const wrap = (value, length = 360) => ((value % length) + length) % length;
  const shortestDelta = (from, to) => {
    let delta = wrap(to) - wrap(from);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  };

  // Same critically damped integration as oil-motion's createFrameAnimator.
  function smoothDamp(current, target, velocity, smoothTime, maxSpeed, dt) {
    const omega = 2 / Math.max(0.0001, smoothTime);
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = clamp(current - target, -maxSpeed * smoothTime, maxSpeed * smoothTime);
    const limitedTarget = current - change;
    const temp = (velocity + omega * change) * dt;
    let nextVelocity = (velocity - omega * temp) * decay;
    let next = limitedTarget + (change + temp) * decay;
    if ((target - current > 0) === (next > target)) {
      next = target;
      nextVelocity = 0;
    }
    return [next, nextVelocity];
  }

  function validateManifest(manifest) {
    if (manifest.version !== 1 || manifest.type !== "sprite-atlas") {
      throw new Error("Unsupported atlas manifest");
    }
    for (const key of ["frameCount", "columns", "rows", "cellWidth", "cellHeight", "atlasWidth", "atlasHeight"]) {
      if (!Number.isInteger(manifest[key]) || manifest[key] < 1) throw new Error(`Invalid ${key}`);
    }
    if (manifest.frameCount > manifest.columns * manifest.rows ||
        manifest.atlasWidth !== manifest.columns * manifest.cellWidth ||
        manifest.atlasHeight !== manifest.rows * manifest.cellHeight ||
        manifest.atlasWidth > 4096 || manifest.atlasHeight > 4096) {
      throw new Error("Atlas dimensions do not match manifest");
    }
    // The pilot contract is 160×160 CSS pixels at target DPR 2.
    if (manifest.cellWidth < 320 || manifest.cellHeight < 320) {
      throw new Error("Atlas does not meet the pilot's 160 CSS px / DPR 2 target");
    }
  }

  function validateMapping(manifest) {
    const mapping = manifest.pointerMapping;
    if (!mapping || !Array.isArray(mapping.anglesDegrees) ||
        mapping.anglesDegrees.length !== manifest.frameCount ||
        mapping.anglesDegrees.some(angle => !Number.isFinite(angle))) {
      throw new Error("MISSING_ANGLE_MAPPING");
    }
    if (!Number.isInteger(mapping.restFrame) || mapping.restFrame < 0 ||
        mapping.restFrame >= manifest.frameCount) throw new Error("Invalid restFrame");
    const anchor = mapping.headAnchor;
    if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) ||
        anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1) {
      throw new Error("Invalid headAnchor");
    }
    // Circular duplicates, including a copied last/first closing pose, are ambiguous.
    const angles = mapping.anglesDegrees.map(angle => wrap(angle));
    if (angles.some((angle, index) => angles.slice(0, index).some(other =>
      Math.abs(shortestDelta(angle, other)) < 0.01))) {
      throw new Error("Duplicate measured directions");
    }
    return { ...mapping, anglesDegrees: angles, smoothTime: clamp(mapping.smoothTime ?? 0.11, 0.04, 0.5) };
  }

  function validateTimeline(timeline, manifest) {
    if (timeline.schemaVersion !== 1 || !Number.isFinite(timeline.fps) ||
        timeline.fps <= 0 || !Number.isFinite(timeline.frameDuration) ||
        timeline.frameDuration <= 0 ||
        Math.abs(timeline.frameDuration - 1 / timeline.fps) > 0.000001) {
      throw new Error("Invalid timeline schema or frame rate");
    }
    if (!Number.isInteger(timeline.frameCount) ||
        timeline.frameCount !== manifest.frameCount) {
      throw new Error("Timeline frameCount does not match the final atlas");
    }
    if (!Array.isArray(timeline.segments) || timeline.segments.length !== 1) {
      throw new Error("The circular pilot requires exactly one timeline segment");
    }
    const segment = timeline.segments[0];
    if (![segment.start, segment.hold, segment.endExclusive].every(Number.isFinite) ||
        segment.start < 0 || !(segment.start <= segment.hold &&
        segment.hold < segment.endExclusive)) {
      throw new Error("Timeline must satisfy start <= hold < endExclusive");
    }
    const spanFrames = (segment.endExclusive - segment.start) / timeline.frameDuration;
    const holdFrame = (segment.hold - segment.start) / timeline.frameDuration;
    if (Math.abs(spanFrames - timeline.frameCount) > 0.0001 ||
        Math.abs(holdFrame - Math.round(holdFrame)) > 0.0001 ||
        Math.round(holdFrame) >= timeline.frameCount) {
      throw new Error("Timeline boundaries do not match the actual final frame count");
    }
  }

  async function decodeImage(url) {
    const image = new Image();
    image.decoding = "async";
    image.src = url.href;
    await image.decode();
    return image;
  }

  function createCircularScrubber(manifest, mapping) {
    const angles = mapping.anglesDegrees;
    const restAngle = angles[mapping.restFrame];
    let angle = restAngle;
    let velocity = 0;
    let previousFrame = -1;
    let input = { active: false, x: 0, y: 0 };
    let head = { x: 0, y: 0 };
    let geometryDirty = true;
    let visible = true;
    let raf = 0;
    let lastTime = 0;
    let destroyed = false;

    function renderFrame(index) {
      if (index === previousFrame) return;
      const column = index % manifest.columns;
      const row = Math.floor(index / manifest.columns);
      const x = manifest.columns === 1 ? 0 : column / (manifest.columns - 1) * 100;
      const y = manifest.rows === 1 ? 0 : row / (manifest.rows - 1) * 100;
      // Exactly one visible sprite layer; no image opacity blending.
      sprite.style.backgroundPosition = `${x}% ${y}%`;
      previousFrame = index;
    }

    function nearestFrame(targetAngle) {
      let nearest = 0;
      let distance = Infinity;
      angles.forEach((sample, index) => {
        const candidate = Math.abs(shortestDelta(targetAngle, sample));
        if (candidate < distance) {
          distance = candidate;
          nearest = index;
        }
      });
      return nearest;
    }

    function tick(now) {
      raf = 0;
      if (destroyed || !visible || document.hidden) { lastTime = 0; return; }
      if (geometryDirty) {
        const rect = character.getBoundingClientRect();
        head = { x: rect.left + rect.width * mapping.headAnchor.x,
          y: rect.top + rect.height * mapping.headAnchor.y };
        geometryDirty = false;
      }
      const dt = lastTime ? Math.min((now - lastTime) / 1000, 1 / 30) : 1 / 60;
      lastTime = now;
      let target = restAngle;
      if (input.active) {
        const dx = input.x - head.x;
        const dy = input.y - head.y;
        // Avoid an undefined twitch directly over the head anchor.
        target = Math.hypot(dx, dy) < 6 ? restAngle : Math.atan2(dy, dx) * 180 / Math.PI;
      }
      target = angle + shortestDelta(angle, target);
      [angle, velocity] = smoothDamp(angle, target, velocity, mapping.smoothTime, 720, dt);
      renderFrame(nearestFrame(angle));
      if (Math.abs(target - angle) > 0.01 || Math.abs(velocity) > 0.01) schedule();
      else { angle = wrap(angle); velocity = 0; lastTime = 0; }
    }

    function schedule() {
      if (!raf && !destroyed && visible && !document.hidden) raf = requestAnimationFrame(tick);
    }

    renderFrame(mapping.restFrame);
    return {
      setInput(next) { input = next; schedule(); },
      reset() { input = { ...input, active: false }; schedule(); },
      updateGeometry() { geometryDirty = true; schedule(); },
      setVisible(next) {
        visible = next;
        if (!next && raf) { cancelAnimationFrame(raf); raf = 0; lastTime = 0; }
        if (next) { geometryDirty = true; schedule(); }
      },
      destroy() { destroyed = true; if (raf) cancelAnimationFrame(raf); },
    };
  }

  let scrubber = null;
  let activeTouch = null;
  let bootToken = 0;
  let stageVisible = true;

  // Input listeners only record the latest target; all frame writes happen in rAF.
  window.addEventListener("pointermove", event => {
    if (event.pointerType === "mouse") {
      scrubber?.setInput({ active: true, x: event.clientX, y: event.clientY });
    }
  }, { passive: true });
  window.addEventListener("pointerout", event => {
    if (event.pointerType === "mouse" && event.relatedTarget === null) scrubber?.reset();
  });
  stage.addEventListener("pointermove", event => {
    if (event.pointerType === "mouse") return;
    if (event.pointerType === "touch" && event.pointerId !== activeTouch) return;
    scrubber?.setInput({ active: true, x: event.clientX, y: event.clientY });
  }, { passive: true });
  stage.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse") return;
    activeTouch = event.pointerId;
    stage.setPointerCapture(event.pointerId);
    scrubber?.setInput({ active: true, x: event.clientX, y: event.clientY });
  });
  function releasePointer(event) {
    if (event.pointerId === activeTouch) {
      activeTouch = null;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      scrubber?.reset();
    }
  }
  stage.addEventListener("pointerup", releasePointer);
  stage.addEventListener("pointercancel", releasePointer);
  stage.addEventListener("lostpointercapture", releasePointer);
  stage.addEventListener("pointerleave", event => {
    if (event.pointerType !== "mouse" && activeTouch === null) scrubber?.reset();
  });
  window.addEventListener("blur", () => scrubber?.reset());
  window.addEventListener("scroll", () => scrubber?.updateGeometry(), { passive: true });
  window.addEventListener("resize", () => scrubber?.updateGeometry(), { passive: true });
  const resizeObserver = new ResizeObserver(() => scrubber?.updateGeometry());
  resizeObserver.observe(character);
  resizeObserver.observe(stage);
  const intersectionObserver = new IntersectionObserver(entries => {
    stageVisible = entries[0].isIntersecting;
    scrubber?.setVisible(stageVisible && !document.hidden);
  });
  intersectionObserver.observe(stage);
  document.addEventListener("visibilitychange", () => {
    scrubber?.setVisible(stageVisible && !document.hidden);
  });

  for (const button of document.querySelectorAll("button[data-theme]")) {
    button.addEventListener("click", () => {
      document.documentElement.dataset.theme = button.dataset.theme;
      for (const other of document.querySelectorAll("button[data-theme]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
  }

  async function boot() {
    const token = ++bootToken;
    scrubber?.destroy();
    scrubber = null;
    sprite.hidden = true;
    fallback.hidden = false;
    status.textContent = reducedMotion.matches ? "已遵循减少动态效果设置，显示静态姿态" : "动画素材准备中";
    if (reducedMotion.matches) return;
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-cache" });
      if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
      const manifest = await response.json();
      validateManifest(manifest);
      const timelineResponse = await fetch(TIMELINE_URL, { cache: "no-cache" });
      if (!timelineResponse.ok) throw new Error(`Timeline HTTP ${timelineResponse.status}`);
      const timeline = await timelineResponse.json();
      validateTimeline(timeline, manifest);
      const mapping = validateMapping(manifest);
      const atlasUrl = manifest.asset ? new URL(manifest.asset, MANIFEST_URL) : DEFAULT_ATLAS_URL;
      if (atlasUrl.origin !== location.origin) throw new Error("Atlas must be local to this demo");
      const atlas = await decodeImage(atlasUrl);
      if (atlas.naturalWidth !== manifest.atlasWidth || atlas.naturalHeight !== manifest.atlasHeight) {
        throw new Error("Decoded atlas does not match manifest");
      }
      // The visible static fallback must also be decoded before an atomic swap.
      await fallback.decode();
      if (token !== bootToken || reducedMotion.matches) return;
      sprite.style.backgroundImage = `url(${JSON.stringify(atlasUrl.href)})`;
      sprite.style.backgroundSize = `${manifest.columns * 100}% ${manifest.rows * 100}%`;
      scrubber = createCircularScrubber(manifest, mapping);
      scrubber.setVisible(stageVisible && !document.hidden);
      sprite.hidden = false;
      fallback.hidden = true;
      status.textContent = "动画已就绪";
    } catch (error) {
      if (token !== bootToken) return;
      // Missing production assets never create simulated movement.
      status.textContent = error.message === "MISSING_ANGLE_MAPPING"
        ? "动画素材准备中 · 等待帧角度标注" : "动画素材准备中";
      console.info("Orange-cat pilot is using its static fallback:", error.message);
    }
  }
  reducedMotion.addEventListener("change", boot);
  window.addEventListener("pagehide", () => {
    bootToken += 1;
    scrubber?.destroy();
  });
  window.addEventListener("pageshow", event => { if (event.persisted) void boot(); });
  void boot();
})();
