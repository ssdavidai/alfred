// Dictation — the Ask listens. Audio never leaves this Mac: whisper.cpp runs a
// bundled model (ggml-base-q5_1, 57 MB, 99 languages) on the GPU while you speak,
// and the field fills as the words settle. A pause ends the take; ⏎ sends it.
import Foundation
import AVFoundation
import whisper

final class Dictation: ObservableObject {
  @Published var listening = false
  @Published var text = ""            // the live transcript
  @Published var level: Float = 0     // microphone level 0…1, for the pulse
  @Published var finished = false     // the take ended; `text` is final
  @Published var problem: String? = nil

  static let modelName = "ggml-base-q5_1.bin"
  static var modelURL: URL? { Bundle.main.resourceURL?.appendingPathComponent("Models/\(modelName)") }
  static var available: Bool { modelURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }
  static let maxSeconds = 45.0, silence = 1.8, minSpeech = 0.6, voiceRMS: Float = 0.012

  private let engine = AVAudioEngine()
  private let lock = NSLock()
  private var samples: [Float] = []   // 16 kHz mono, guarded by `lock`
  private var lastVoiceAt: Date? = nil, startedAt: Date? = nil
  private var ticker: Timer? = nil
  private var pass: Task<Void, Never>? = nil

  // One Whisper context per process. The first load compiles Metal shaders (seconds,
  // cached by the system afterwards); later loads take ~0.1 s. Warm it at launch.
  private static var ctx: OpaquePointer? = nil
  private static let queue = DispatchQueue(label: "black.alfred.whisper", qos: .userInitiated)
  static func warm() { queue.async { _ = context() } }
  private static func context() -> OpaquePointer? {
    if let c = ctx { return c }
    guard let u = modelURL else { return nil }
    var p = whisper_context_default_params(); p.use_gpu = true
    ctx = whisper_init_from_file_with_params(u.path, p); return ctx
  }

  func start() {
    guard !listening, Self.available else { return }
    text = ""; finished = false; problem = nil; lastVoiceAt = nil; startedAt = Date()
    lock.lock(); samples = []; lock.unlock()
    AVCaptureDevice.requestAccess(for: .audio) { ok in
      DispatchQueue.main.async {
        guard ok else { self.problem = "The microphone is off for Alfred Black — System Settings › Privacy › Microphone."; return }
        self.begin()
      }
    }
  }
  private func begin() {
    let input = engine.inputNode; let native = input.outputFormat(forBus: 0)
    guard native.sampleRate > 0,
          let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
          let conv = AVAudioConverter(from: native, to: target) else { problem = "No microphone."; return }
    input.installTap(onBus: 0, bufferSize: 4096, format: native) { [weak self] buf, _ in self?.ingest(buf, conv, target) }
    do { engine.prepare(); try engine.start() } catch { problem = "The microphone could not start: \(error.localizedDescription)"; return }
    listening = true; Self.warm()
    ticker = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: true) { [weak self] _ in self?.tick() }
  }
  /// On the audio thread: resample to 16 kHz mono, keep the samples, measure the level.
  private func ingest(_ buf: AVAudioPCMBuffer, _ conv: AVAudioConverter, _ target: AVAudioFormat) {
    let frames = AVAudioFrameCount(Double(buf.frameLength) * 16000 / buf.format.sampleRate) + 16
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: frames) else { return }
    var fed = false
    conv.convert(to: out, error: nil) { _, status in
      if fed { status.pointee = .noDataNow; return nil }
      fed = true; status.pointee = .haveData; return buf
    }
    guard let ch = out.floatChannelData?[0], out.frameLength > 0 else { return }
    let n = Int(out.frameLength); var sum: Float = 0
    for i in 0..<n { sum += ch[i] * ch[i] }
    let rms = (sum / Float(n)).squareRoot()
    lock.lock(); samples.append(contentsOf: UnsafeBufferPointer(start: ch, count: n)); lock.unlock()
    DispatchQueue.main.async { self.level = min(1, rms * 12); if rms > Self.voiceRMS { self.lastVoiceAt = Date() } }
  }
  private func tick() {
    guard listening else { return }
    let now = Date()
    if let v = lastVoiceAt, now.timeIntervalSince(v) > Self.silence { stop(); return }
    if now.timeIntervalSince(startedAt ?? now) > Self.maxSeconds { stop(); return }
    if lastVoiceAt != nil { transcribe(final: false) }
  }
  /// Ends the take; the final pass lands in `text` and sets `finished`.
  func stop() {
    guard listening else { return }
    ticker?.invalidate(); ticker = nil
    engine.inputNode.removeTap(onBus: 0); engine.stop(); listening = false; level = 0
    if lastVoiceAt != nil { transcribe(final: true) } else { finished = true }
  }
  func cancel() { pass?.cancel(); pass = nil; if listening { stop() }; text = ""; finished = false }

  private func transcribe(final: Bool) {
    guard final || pass == nil else { return }          // one partial pass at a time
    lock.lock(); let snap = samples; lock.unlock()
    guard Double(snap.count) / 16000 >= Self.minSpeech else { if final { finished = true }; return }
    pass = Task.detached(priority: .userInitiated) { [weak self] in
      let out = Self.run(snap)
      await MainActor.run { [weak self] in guard let self else { return }; if let out { self.text = out }; if final { self.finished = true }; self.pass = nil }
    }
  }
  /// Whole-take decoding on the shared context; a 10 s take costs ~0.2 s on Apple silicon.
  static func run(_ pcm: [Float]) -> String? {
    var result: String? = nil
    queue.sync {
      guard let ctx = context() else { return }
      var p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
      p.n_threads = Int32(max(2, min(6, ProcessInfo.processInfo.activeProcessorCount - 2)))
      p.print_progress = false; p.print_realtime = false; p.print_timestamps = false; p.no_timestamps = true
      p.suppress_blank = true; p.temperature_inc = 0
      "auto".withCString { lang in
        p.language = lang
        guard whisper_full(ctx, p, pcm, Int32(pcm.count)) == 0 else { return }
        var s = ""; for i in 0..<whisper_full_n_segments(ctx) { s += String(cString: whisper_full_get_segment_text(ctx, i)) }
        result = clean(s)
      }
    }
    return result
  }
  /// Whisper narrates silence as "[BLANK_AUDIO]" or "(music)"; those are not words.
  static func clean(_ s: String) -> String {
    let stripped = s.replacingOccurrences(of: #"\s*[\[\(][^\]\)]*[\]\)]"#, with: "", options: .regularExpression)
    return stripped.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  }
  /// Any audio file → the same pipeline (for `--transcribe`, the verifier).
  static func transcribe(file: URL) -> String? {
    guard let f = try? AVAudioFile(forReading: file),
          let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
          let conv = AVAudioConverter(from: f.processingFormat, to: target),
          let inBuf = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length)),
          let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(f.length) * 16000 / f.processingFormat.sampleRate) + 64) else { return nil }
    try? f.read(into: inBuf); var fed = false
    conv.convert(to: out, error: nil) { _, status in if fed { status.pointee = .endOfStream; return nil }; fed = true; status.pointee = .haveData; return inBuf }
    guard let ch = out.floatChannelData?[0] else { return nil }
    return run(Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength))))
  }
}
