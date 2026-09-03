// swift-tools-version:5.9
// Alfred Black for Mac — builds with the Command Line Tools alone (no Xcode.app).
// scripts/build-app.sh wraps the executable into a signed .app + .dmg.
import PackageDescription

let package = Package(
  name: "AlfredBlack",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "AlfredBlack",
      path: "Sources/AlfredBlack",
      resources: [
        .copy("Resources/Fonts"),
        .copy("Resources/CoworkPlugin"),
      ],
      swiftSettings: [.unsafeFlags(["-parse-as-library"])]
    ),
  ]
)
