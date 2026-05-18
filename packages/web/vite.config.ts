import { defineConfig, type Plugin } from "vite";
import path from "path";

/**
 * Vite plugin to patch three-forcegraph and 3d-force-graph at build time.
 *
 * three-forcegraph bug: update() sets state.engineRunning = true unconditionally
 * (line 1482) but only sets state.layout inside a conditional block (line 1479).
 * When update() is called for non-graphData prop changes, state.layout can be
 * undefined while engineRunning is true, causing layoutTick() to crash on
 * state.layout[...].tick().
 *
 * 3d-force-graph issue: _animationCycle has no error handling, so one crash in
 * tickFrame() kills the entire animation loop (requestAnimationFrame never
 * re-scheduled) → permanent black screen.
 *
 * Fix 1: Guard state.layout access in layoutTick.
 * Fix 2: Wrap _animationCycle body in try-catch so rendering continues.
 */
function patchForceGraph(): Plugin {
  return {
    name: "patch-force-graph",
    transform(code, id) {
      // Patch three-forcegraph: guard state.layout in layoutTick
      if (id.includes("three-forcegraph")) {
        return code.replace(
          "state.layout[isD3Sim ? 'tick' : 'step'](); // Tick it",
          "if (state.layout) { state.layout[isD3Sim ? 'tick' : 'step'](); } else { state.engineRunning = false; return; } // Tick it (patched)"
        );
      }

      // Patch 3d-force-graph: wrap _animationCycle in try-catch
      if (id.includes("3d-force-graph")) {
        return code.replace(
          `_animationCycle: function _animationCycle(state) {
      if (state.enablePointerInteraction) {
        // reset canvas cursor (override dragControls cursor)
        this.renderer().domElement.style.cursor = null;
      }

      // Frame cycle
      state.forceGraph.tickFrame();
      state.renderObjs.tick();
      state.animationFrameRequestId = requestAnimationFrame(this._animationCycle);
    }`,
          `_animationCycle: function _animationCycle(state) {
      try {
        if (state.enablePointerInteraction) {
          this.renderer().domElement.style.cursor = null;
        }
        state.forceGraph.tickFrame();
        state.renderObjs.tick();
      } catch (e) {
        // Swallow tick errors to keep animation loop alive (patched)
      }
      state.animationFrameRequestId = requestAnimationFrame(this._animationCycle);
    }`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [patchForceGraph()],
  server: {
    open: true,
  },
  resolve: {
    alias: {
      // three-render-objects@1.40.4 imports from three/webgpu which is a
      // standalone ~5MB bundle that duplicates all of three.js. The duplicate
      // classes cause Kapsule state init to fail (renderObjs undefined → tick crash).
      // Redirect to our shim that re-exports from the single "three" copy.
      "three/webgpu": path.resolve(__dirname, "src/three-webgpu-shim.ts"),
    },
    dedupe: ["three"],
  },
});
