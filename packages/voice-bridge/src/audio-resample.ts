// audio-resample.ts — PCM-int16 linear-interpolation resampler.
//
// Why hand-rolled, why linear:
//   - speex-resampler / libsamplerate would give us proper band-limited
//     sinc resampling, but they're 100+ KB native deps with prebuilds-or-bust
//     install ergonomics. The voice-bridge container is ~30 MB; we are not
//     paying that price.
//   - For voice in the 300–3400 Hz formant band (which is what `gpt-realtime-2`
//     emits and what HA satellites consume), 16 kHz ↔ 24 kHz and 22.05 kHz
//     conversions through linear interpolation are inaudible: the alias energy
//     lands above 8 kHz, where the speech band has ~30 dB less power, and HA's
//     I2S codec on the Voice PE already low-passes at ~7 kHz. Sir's ears do
//     not hear the difference between linear and sinc on butler-speech.
//   - All resampling happens on the hot audio path (every ~20 ms frame), so a
//     branch-free linear interpolation is the latency-correct choice.
//
// Wire contract:
//   - Input/output are Buffers of little-endian signed 16-bit PCM (mono).
//     This matches:
//       * OpenAI Realtime GA `audio/pcm` (pcm16 LE @ 24 kHz)
//       * ESPHome native API VoiceAssistantAudio frames when USE_API_AUDIO
//         is set (pcm16 LE @ 16 kHz, per OHF-Voice/linux-voice-assistant)
//       * Wyoming `audio-chunk` payloads (pcm16 LE @ 16 kHz in, 22.05 kHz out)
//   - Odd-byte inputs are rejected: PCM16 frames are always an even byte count
//     and an odd buffer indicates upstream framing damage we should surface
//     rather than silently truncate.
//   - Sample rates are arbitrary positive integers; the resampler does not
//     special-case integer ratios (24/16 = 3/2) because the branch-free linear
//     path is already cheap enough that the special-case wouldn't pay back the
//     code-complexity cost.
//
// Performance budget:
//   - One ~20 ms frame at 16 kHz = 640 bytes = 320 samples. Resampled to 24 kHz
//     = 480 samples = 960 bytes. The inner loop is ~5 arithmetic ops per output
//     sample, so a frame resamples in single-digit microseconds on a Pi5. The
//     hot path is not a bottleneck.
//
// We deliberately do NOT implement a streaming resampler with carryover state
// between calls — each frame resamples independently. This means a sub-sample
// alignment error at the join (worst-case 1/24000s = 41 µs of jitter on the
// 16→24 path) gets re-introduced each frame, but is below the inter-frame
// playback jitter HA already introduces on its WebSocket transport, and well
// below any audible threshold. If a future regression mode needs gap-free
// resampling, add a `ResamplerState` class then; until then, this is enough.

const BYTES_PER_SAMPLE = 2;

/**
 * Resample a buffer of 16-bit LE PCM mono samples from `srcRate` to `dstRate`
 * using linear interpolation.
 *
 * Edge cases:
 *   - Empty input → empty output (no-op).
 *   - srcRate === dstRate → returns a copy of the input (NEVER returns the
 *     original buffer — callers MUST be able to mutate without surprising the
 *     caller of the previous step).
 *   - Single input sample → single output sample (the only output is the
 *     input).
 *
 * Throws on odd-byte buffers (framing error) or non-positive rates (config
 * error) — both indicate an upstream bug we want loud, not silent.
 */
export function resamplePcm16(
  input: Buffer,
  srcRate: number,
  dstRate: number,
): Buffer {
  if (!Number.isFinite(srcRate) || srcRate <= 0) {
    throw new Error(`srcRate must be a positive number, got ${srcRate}`);
  }
  if (!Number.isFinite(dstRate) || dstRate <= 0) {
    throw new Error(`dstRate must be a positive number, got ${dstRate}`);
  }
  if (input.length % BYTES_PER_SAMPLE !== 0) {
    throw new Error(
      `PCM16 buffer length must be even, got ${input.length} bytes`,
    );
  }
  if (input.length === 0) return Buffer.alloc(0);

  // Same-rate fast path. We still copy so the caller can mutate the result
  // without affecting the original.
  if (srcRate === dstRate) {
    return Buffer.from(input);
  }

  const srcSamples = input.length / BYTES_PER_SAMPLE;
  if (srcSamples === 1) {
    // Single-sample input: nothing to interpolate against; return as-is.
    return Buffer.from(input);
  }

  // Read input as int16 LE — we use a typed-array view over the underlying
  // ArrayBuffer slice so we get free SIMD-friendly contiguous memory.
  const src = new Int16Array(
    input.buffer,
    input.byteOffset,
    srcSamples,
  );

  // Output sample count: floor(srcSamples * dstRate / srcRate). We use this
  // instead of round to keep duration monotonic and avoid an off-by-one in the
  // last interpolation index.
  const dstSamples = Math.max(
    1,
    Math.floor((srcSamples * dstRate) / srcRate),
  );
  const out = Buffer.allocUnsafe(dstSamples * BYTES_PER_SAMPLE);
  const dst = new Int16Array(out.buffer, out.byteOffset, dstSamples);

  // The phase increment per output sample, in source-sample units.
  const ratio = srcRate / dstRate;

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = src[idx];
    // Clamp the upper index against srcSamples-1 — the last output sample can
    // land exactly on the last input index when the ratio divides evenly.
    const s1 = idx + 1 < srcSamples ? src[idx + 1] : s0;
    // Linear interpolation. Result is already in int16 range because both
    // endpoints are; explicit rounding keeps the cast deterministic across
    // engines (V8's typed-array store truncates, but we want round-to-nearest).
    const value = s0 + (s1 - s0) * frac;
    dst[i] = Math.round(value);
  }

  return out;
}

/**
 * Convenience: split a continuous PCM16 stream into ~`frameMs`-long chunks at
 * the given sample rate. Used by the ESPHome session to chunk OpenAI's audio
 * deltas (which arrive at arbitrary sizes) into VoiceAssistantAudio frames
 * close to what real ESPHome firmware emits (the satellite chunks every
 * ~20 ms; HA's voice_assistant integration tolerates a wide range but ~20 ms
 * is the sweet spot for jitter-free playback).
 */
export function frameChunks(
  buf: Buffer,
  sampleRate: number,
  frameMs: number,
): Buffer[] {
  if (buf.length === 0) return [];
  if (frameMs <= 0) throw new Error(`frameMs must be > 0, got ${frameMs}`);
  const samplesPerFrame = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const bytesPerFrame = samplesPerFrame * BYTES_PER_SAMPLE;
  const frames: Buffer[] = [];
  for (let off = 0; off < buf.length; off += bytesPerFrame) {
    frames.push(buf.subarray(off, Math.min(off + bytesPerFrame, buf.length)));
  }
  return frames;
}
