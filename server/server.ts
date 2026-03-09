import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { handleConnect, handleDisconnect, handleMessage } from './gameManager';

// Use PORT env var if set, otherwise bind to 0 (OS picks a free port)
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;
const app = express();
const server = http.createServer(app);

// ── Static files (production build) ──
const distPath = path.join(process.cwd(), 'dist');
app.use(express.static(distPath));
app.get('/{*path}', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

// ── WebSocket ──
const wss = new WebSocketServer({ server });

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

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`\nServer running on http://localhost:${port}`);
  console.log(`Cloudflare:  cloudflared tunnel --url http://localhost:${port}\n`);
});
