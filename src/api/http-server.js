import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wsServer } from './ws-server.js';
import { sharedContext } from '../context/shared-context.js';
import { intentManager } from '../context/intent-manager.js';
import { contractGraph } from '../context/contract-graph.js';
import { conflictDetector } from '../conflict/detector.js';
import { conflictNotifier } from '../conflict/notifier.js';
import { conflictResolver } from '../conflict/resolver.js';
import { pubSubEngine } from '../redis/pubsub.js';
import { getKvCollection } from '../db/collections.js';
import { CONFIG } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

export class HttpServer {
  constructor(port = CONFIG.HTTP_PORT, host = CONFIG.HOST) {
    this.port = port;
    this.host = host;
    this.server = null;
    this.sseClients = new Set();

    // Route pubsub messages to SSE clients as well
    pubSubEngine.on('message', ({ channel, message }) => {
      this._broadcastSSE({ channel, data: message });
    });
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));

      // Handle WebSocket upgrades
      this.server.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws' || req.url === '/events') {
          wsServer.handleUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[HttpServer] Port ${this.port} is already in use. Trying alternate port ${this.port + 1}...`);
          this.port += 1;
          this.server.listen(this.port, this.host);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[HttpServer] Web Dashboard & API running at http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.port}`);
        resolve(this);
      });
    });
  }

  async _handleRequest(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 1. SSE Stream
      if (pathname === '/events' && req.method === 'GET') {
        return this._handleSSE(req, res);
      }

      // 2. REST API Endpoints
      if (pathname.startsWith('/api/')) {
        return await this._handleApi(req, res, pathname, url);
      }

      // 3. Health check
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }

      // 4. Static Files (Dashboard UI)
      return this._handleStatic(req, res, pathname);

    } catch (err) {
      console.error('[HttpServer] Request Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  async _handleApi(req, res, pathname, url) {
    // Helper to read JSON body
    const readBody = async () => {
      return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (_) {
            resolve({});
          }
        });
      });
    };

    const sendJson = (statusCode, data) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    };

    // GET /api/context - Common Pool of Context
    if (pathname === '/api/context' && req.method === 'GET') {
      const context = await sharedContext.getUnifiedContext();
      return sendJson(200, context);
    }

    // GET /api/files - List files
    if (pathname === '/api/files' && req.method === 'GET') {
      const files = sharedContext.getAllFiles();
      return sendJson(200, files);
    }

    // GET /api/files/content - Get single file
    if (pathname === '/api/files/content' && req.method === 'GET') {
      const filePath = url.searchParams.get('path');
      const file = sharedContext.getFile(filePath);
      if (!file) return sendJson(404, { error: 'File not found' });
      return sendJson(200, file);
    }

    // POST /api/agents/register
    if (pathname === '/api/agents/register' && req.method === 'POST') {
      const body = await readBody();
      const agent = await sharedContext.registerAgent(body.agentId, body.role, body.machineId, body.metadata);
      return sendJson(200, { success: true, agent });
    }

    // POST /api/agents/heartbeat
    if (pathname === '/api/agents/heartbeat' && req.method === 'POST') {
      const body = await readBody();
      const agent = await sharedContext.heartbeatAgent(body.agentId);
      return sendJson(200, { success: Boolean(agent), agent });
    }

    // POST /api/intent/acquire
    if (pathname === '/api/intent/acquire' && req.method === 'POST') {
      const body = await readBody();
      const result = await intentManager.acquireIntent(
        body.agentId,
        body.filePath,
        body.description,
        {
          machineId: body.machineId,
          role: body.role,
          ttlMs: body.ttlMs,
          symbols: body.symbols
        }
      );
      return sendJson(result.success ? 200 : 409, result);
    }

    // POST /api/intent/release
    if (pathname === '/api/intent/release' && req.method === 'POST') {
      const body = await readBody();
      const result = await intentManager.releaseIntent(body.agentId, body.filePath);
      return sendJson(result.success ? 200 : 400, result);
    }

    // POST /api/changes/submit
    if (pathname === '/api/changes/submit' && req.method === 'POST') {
      const body = await readBody();
      const { agentId, filePath, content, baseHash } = body;

      const evaluation = await conflictDetector.evaluateChange(agentId, filePath, content, baseHash);

      if (evaluation.hasConflict) {
        const alert = await conflictNotifier.notifyConflict(evaluation);
        return sendJson(409, {
          status: 'CONFLICT_DETECTED',
          canAutoMerge: evaluation.canAutoMerge,
          conflict: alert
        });
      }

      const updated = await sharedContext.commitFileChange(filePath, content, agentId);
      return sendJson(200, {
        status: 'COMMITTED',
        file: updated,
        warnings: evaluation.warnings || []
      });
    }

    // GET /api/conflicts
    if (pathname === '/api/conflicts' && req.method === 'GET') {
      const conflicts = await conflictDetector.getPendingConflicts();
      return sendJson(200, conflicts);
    }

    // POST /api/conflicts/resolve
    if (pathname === '/api/conflicts/resolve' && req.method === 'POST') {
      const body = await readBody();
      const { conflictId, strategy, customContent, resolvedBy } = body;
      try {
        const result = await conflictResolver.resolve(conflictId, strategy, { customContent, resolvedBy });
        return sendJson(200, result);
      } catch (err) {
        return sendJson(400, { error: err.message });
      }
    }

    // POST /api/redis/command - Execute command from Web UI
    if (pathname === '/api/redis/command' && req.method === 'POST') {
      const body = await readBody();
      const command = (body.command || '').trim();
      const tokens = command.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return sendJson(400, { error: 'Empty command' });

      const op = tokens[0].toUpperCase();
      const args = tokens.slice(1);
      const kv = getKvCollection();

      if (op === 'PING') return sendJson(200, { result: 'PONG' });
      if (op === 'SET') {
        await kv.updateOne({ key: args[0] }, { $set: { key: args[0], type: 'string', value: args[1], updatedAt: new Date().toISOString() } }, { upsert: true });
        return sendJson(200, { result: 'OK' });
      }
      if (op === 'GET') {
        const doc = await kv.findOne({ key: args[0] });
        return sendJson(200, { result: doc ? doc.value : null });
      }
      if (op === 'KEYS') {
        const docs = await kv.find({}).toArray();
        return sendJson(200, { result: docs.map(d => d.key) });
      }
      if (op === 'PUBLISH') {
        const receivers = pubSubEngine.publish(args[0], args.slice(1).join(' '));
        return sendJson(200, { result: receivers });
      }

      return sendJson(200, { result: `Executed ${op}` });
    }

    return sendJson(404, { error: `Endpoint ${pathname} not found` });
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'SSE stream connected' })}\n\n`);

    this.sseClients.add(res);

    req.on('close', () => {
      this.sseClients.delete(res);
    });
  }

  _broadcastSSE(payload) {
    const dataStr = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(dataStr);
      } catch (_) {}
    }
  }

  _handleStatic(req, res, pathname) {
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    if (!fs.existsSync(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[ext] || 'text/plain';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  async stop() {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    wsServer.close();

    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
  }
}
