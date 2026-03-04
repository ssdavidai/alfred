// Shim for three/webgpu — prevents bundling the standalone three.webgpu.js
// which is a complete duplicate of three.js (~5MB) and causes class identity
// mismatches that crash three-render-objects.
//
// WebGPURenderer is imported by three-render-objects but only used when
// useWebGPU=true (default: false). Providing a no-op class is safe.

export * from "three";

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class WebGPURenderer {}
