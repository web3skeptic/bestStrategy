import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { handleConnect, handleDisconnect, handleMessage, getActiveGames } from './gameManager';
import { headlessRouter, handleListReplays, handleGetReplay } from './headlessApi';
import { authRouter } from './authRoutes';
import { requireAuth } from './auth';

// Use PORT env var if set, otherwise bind to 0 (OS picks a free port)
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;
// HOST lets the deploy bind to 127.0.0.1 so only the reverse proxy can reach it.
const HOST = process.env.HOST;
const app = express();
const server = http.createServer(app);

// ── JSON body parsing ──
app.use(express.json({ limit: '64kb' }));

// ── Auth (register/login) ──
// These routes issue JWTs. Required to access /api/headless/*.
app.use('/api/auth', authRouter);

// ── Headless JSON API ──
// Replay endpoints are public (read-only). All other headless routes require JWT.
app.get('/api/headless/replays', handleListReplays);
app.get('/api/headless/:gameId/replay', handleGetReplay);
app.use('/api/headless', requireAuth, headlessRouter);

// ── Active games list (for spectator lobby) ──
app.get('/api/games', (_req, res) => {
  res.json(getActiveGames());
});

// ── Static files (production build) ──
const distPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(distPath));
// Dedicated route for the replay viewer page (built as a separate Vite entry).
app.get('/replay', (_req, res) => {
  res.sendFile(path.join(distPath, 'replay.html'));
});
// Replays browser — searchable list of all recorded games.
app.get('/replays', (_req, res) => {
  res.sendFile(path.join(distPath, 'replays.html'));
});
// Asset demo — showcases every tile, unit and structure.
app.get('/demo', (_req, res) => {
  res.sendFile(path.join(distPath, 'demo.html'));
});
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ── WebSocket ──
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  handleConnect(ws);

  ws.on('message', (data) => {
    try {
      handleMessage(ws, data.toString());
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err);
    handleDisconnect(ws);
  });
});

const onListen = () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`\nServer running on http://localhost:${port}`);
  console.log(`Cloudflare:  cloudflared tunnel --url http://localhost:${port}\n`);
};
if (HOST) server.listen(PORT, HOST, onListen);
else server.listen(PORT, onListen);
