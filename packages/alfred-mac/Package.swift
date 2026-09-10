// swift-tools-version:5.9
// Alfred Black for Mac — builds with the Command Line Tools alone (no Xcode.app).
// scripts/build-app.sh wraps the executable into a signed .app + .dmg.
import PackageDescription

let package = Package(
  name: "AlfredBlack",
  platforms: [.macOS(.v13)],
  targets: [
    // whisper.cpp, prebuilt by its own release pipeline (MIT). Dictation runs on this
    // Mac against a bundled model; nothing is sent anywhere. Pinned by checksum.
    .binaryTarget(
      name: "whisper",
      url: "https://github.com/ggml-org/whisper.cpp/releases/download/b4938/whisper-b4938-xcframework.zip",
      checksum: "dcc6cdc6d6902d11893434ceda70c23a2a64450f65a1b570035c9908988dfedd"
    ),
    .executableTarget(
      name: "AlfredBlack",
      dependencies: ["whisper"],
      path: "Sources/AlfredBlack",
      resources: [
        .copy("Resources/Fonts"),
        .copy("Resources/CoworkPlugin"),
        .copy("Resources/Brand"),
      ],
      swiftSettings: [.unsafeFlags(["-parse-as-library"])],
      // the framework lives in Contents/Frameworks inside the app (and beside the binary in .build)
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    ),
  ]
)
