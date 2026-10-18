import type { CapacitorConfig } from '@capacitor/cli';

// iPhone app shell for Tactical Tribes. The game itself is bundled in the app
// (dist-ios/, built by `npm run build:ios`); online play connects to the live
// server at wss://interslavic.space/game-upgradable/ws.
const config: CapacitorConfig = {
  appId: 'space.interslavic.tacticaltribes',
  appName: 'Tactical Tribes',
  webDir: 'dist-ios',
  // Matches the game's dark green menu so there's no white flash on launch.
  backgroundColor: '#0a1510',
  ios: {
    // The page handles the notch itself (viewport-fit=cover + safe-area CSS).
    contentInset: 'never',
    // A game board, not a document: no rubber-band scrolling or link previews.
    scrollEnabled: false,
    allowsLinkPreview: false,
    backgroundColor: '#0a1510',
  },
};

export default config;
