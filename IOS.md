# iPhone app

A native iOS wrapper for Tactical Tribes, built with Capacitor 8. The game itself (HTML, JS, 3D assets)
is bundled inside the app, so single-player and pass-and-play work offline. Online play connects to the
live server at `wss://interslavic.space/game-upgradable/ws`, so app and website players can play each other.

## Build and run

```bash
npm ci
npm run build:ios      # builds dist-ios/ for the app and copies it into the Xcode project
npm run ios:open       # opens ios/App/App.xcodeproj in Xcode
```

In Xcode, pick a simulator or a connected iPhone and press Run.
To install on a real iPhone, select your team under Signing & Capabilities for the "App" target first.
The bundle id is `space.interslavic.tacticaltribes`.

Command-line simulator build:

```bash
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ios-build \
  CODE_SIGNING_ALLOWED=NO build
```

## How the app build differs from the website build

`VITE_NATIVE_APP=1` (set by `npm run build:ios`, see `vite.config.ts`):

- relative asset paths (`base: "./"`), output to `dist-ios/`, only the game page;
- `VITE_WS_URL` points online play at interslavic.space;
- `viewport-fit=cover`, so the existing safe-area CSS works around the notch / Dynamic Island;
- no in-game agent chat panel (a site-admin tool that needs same-origin HTTP APIs);
- the Replays button opens the website in Safari.

Native settings: `capacitor.config.ts` (dark background, no scroll bounce) and
`ios/App/App/Info.plist` (status bar hidden, full screen, arm64).
The icon and launch image are made from the game's warrior art. The sources are in `ios-assets/`.

## After changing the game

Run `npm run build:ios` again before building in Xcode. Xcode only sees the copy in `ios/App/App/public/`.
