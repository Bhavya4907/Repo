import net from 'node:net';
import { RespParser } from './resp-parser.js';
import { pubSubEngine } from './pubsub.js';
import { getKvCollection } from '../db/collections.js';
import { sharedContext } from '../context/shared-context.js';
import { intentManager } from '../context/intent-manager.js';
import { conflictDetector } from '../conflict/detector.js';
import { conflictNotifier } from '../conflict/notifier.js';
import { conflictResolver } from '../conflict/resolver.js';
import { CONFIG } from '../config.js';

export class RedisServer {
  constructor(port = CONFIG.REDIS_PORT, host = CONFIG.HOST) {
    this.port = port;
    this.host = host;
    this.server = null;
    this.connections = new Set();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this._handleConnection(socket));

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[RedisServer] Port ${this.port} is already in use. Trying alternate port ${this.port + 10}...`);
          this.port += 10;
          this.server.listen(this.port, this.host);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`[RedisServer] RESP Server running on ${this.host}:${this.port}`);
        resolve(this);
      });
    });
  }

  _handleConnection(socket) {
    this.connections.add(socket);
    const parser = new RespParser();

    socket.on('data', async (chunk) => {
      try {
        parser.append(chunk);
        const commands = parser.parse();
        for (const cmd of commands) {
          await this._executeCommand(socket, cmd);
        }
      } catch (err) {
        console.error('[RedisServer] Error processing command:', err);
        socket.write(RespParser.error(`ERR ${err.message}`));
      }
    });

    socket.on('close', () => {
      pubSubEngine.unsubscribeAll(socket);
      this.connections.delete(socket);
    });

    socket.on('error', (err) => {
      console.warn('[RedisServer] Socket error:', err.message);
    });
  }

  async _executeCommand(socket, cmd) {
    if (!cmd || cmd.length === 0) return;

    const op = String(cmd[0]).toUpperCase();
    const args = cmd.slice(1);
    const kv = getKvCollection();

    switch (op) {
      case 'PING': {
        const reply = args.length > 0 ? args[0] : 'PONG';
        socket.write(RespParser.simpleString(reply));
        break;
      }

      case 'ECHO': {
        socket.write(RespParser.bulkString(args[0] || ''));
        break;
      }

      // KV Operations backed by MongoDB
      case 'SET': {
        const key = args[0];
        const val = args[1];
        let ttlMs = null;

        // Parse optional EX seconds
        if (args.length >= 4 && String(args[2]).toUpperCase() === 'EX') {
          const exSec = parseInt(args[3], 10);
          if (!isNaN(exSec)) ttlMs = exSec * 1000;
        }

        const expiresAt = ttlMs ? Date.now() + ttlMs : null;

        await kv.updateOne(
          { key },
          {
            $set: {
              key,
              type: 'string',
              value: val,
              expiresAt,
              updatedAt: new Date().toISOString()
            }
          },
          { upsert: true }
        );

        socket.write(RespParser.simpleString('OK'));
        break;
      }

      case 'GET': {
        const key = args[0];
        const doc = await kv.findOne({ key });
        if (!doc) {
          socket.write(RespParser.bulkString(null));
          break;
        }

        if (doc.expiresAt && doc.expiresAt <= Date.now()) {
          await kv.deleteOne({ key });
          socket.write(RespParser.bulkString(null));
          break;
        }

        socket.write(RespParser.bulkString(doc.value));
        break;
      }

      case 'DEL': {
        const keys = args;
        const res = await kv.deleteMany({ key: { $in: keys } });
        socket.write(RespParser.integer(res.deletedCount || 0));
        break;
      }

      case 'EXPIRE': {
        const key = args[0];
        const sec = parseInt(args[1], 10);
        if (isNaN(sec)) {
          socket.write(RespParser.error('value is not an integer or out of range'));
          break;
        }

        const expiresAt = Date.now() + (sec * 1000);
        const res = await kv.updateOne({ key }, { $set: { expiresAt } });
        socket.write(RespParser.integer(res.matchedCount > 0 ? 1 : 0));
        break;
      }

      case 'TTL': {
        const key = args[0];
        const doc = await kv.findOne({ key });
        if (!doc) {
          socket.write(RespParser.integer(-2));
          break;
        }
        if (!doc.expiresAt) {
          socket.write(RespParser.integer(-1));
          break;
        }
        const remainingSec = Math.ceil((doc.expiresAt - Date.now()) / 1000);
        if (remainingSec <= 0) {
          await kv.deleteOne({ key });
          socket.write(RespParser.integer(-2));
          break;
        }
        socket.write(RespParser.integer(remainingSec));
        break;
      }

      // Hash Operations
      case 'HSET': {
        const key = args[0];
        const field = args[1];
        const val = args[2];

        let doc = await kv.findOne({ key });
        const hashObj = doc && doc.type === 'hash' ? (doc.hash || {}) : {};
        const isNewField = !(field in hashObj);
        hashObj[field] = val;

        await kv.updateOne(
          { key },
          {
            $set: {
              key,
              type: 'hash',
              hash: hashObj,
              updatedAt: new Date().toISOString()
            }
          },
          { upsert: true }
        );

        socket.write(RespParser.integer(isNewField ? 1 : 0));
        break;
      }

      case 'HGET': {
        const key = args[0];
        const field = args[1];
        const doc = await kv.findOne({ key });
        if (!doc || doc.type !== 'hash' || !doc.hash || !(field in doc.hash)) {
          socket.write(RespParser.bulkString(null));
        } else {
          socket.write(RespParser.bulkString(doc.hash[field]));
        }
        break;
      }

      case 'HGETALL': {
        const key = args[0];
        const doc = await kv.findOne({ key });
        if (!doc || doc.type !== 'hash' || !doc.hash) {
          socket.write(RespParser.array([]));
        } else {
          const pairs = [];
          for (const [f, v] of Object.entries(doc.hash)) {
            pairs.push(f, String(v));
          }
          socket.write(RespParser.array(pairs));
        }
        break;
      }

      // List Operations
      case 'LPUSH':
      case 'RPUSH': {
        const key = args[0];
        const values = args.slice(1);
        let doc = await kv.findOne({ key });
        let list = doc && doc.type === 'list' ? (doc.list || []) : [];

        if (op === 'LPUSH') {
          list = [...values.reverse(), ...list];
        } else {
          list.push(...values);
        }

        await kv.updateOne(
          { key },
          {
            $set: {
              key,
              type: 'list',
              list,
              updatedAt: new Date().toISOString()
            }
          },
          { upsert: true }
        );

        socket.write(RespParser.integer(list.length));
        break;
      }

      case 'LRANGE': {
        const key = args[0];
        let start = parseInt(args[1], 10) || 0;
        let stop = parseInt(args[2], 10) || -1;

        const doc = await kv.findOne({ key });
        if (!doc || doc.type !== 'list' || !doc.list) {
          socket.write(RespParser.array([]));
          break;
        }

        const arr = doc.list;
        if (start < 0) start = Math.max(0, arr.length + start);
        if (stop < 0) stop = arr.length + stop;
        const slice = arr.slice(start, stop + 1);

        socket.write(RespParser.array(slice));
        break;
      }

      // Keys
      case 'KEYS': {
        const pattern = args[0] || '*';
        const docs = await kv.find({}).toArray();
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        const matching = docs.filter(d => regex.test(d.key)).map(d => d.key);
        socket.write(RespParser.array(matching));
        break;
      }

      // Pub/Sub
      case 'PUBLISH': {
        const channel = args[0];
        const message = args[1] || '';
        const receivers = pubSubEngine.publish(channel, message);
        socket.write(RespParser.integer(receivers));
        break;
      }

      case 'SUBSCRIBE': {
        const channels = args;
        for (const channel of channels) {
          const count = pubSubEngine.subscribe(channel, socket);
          // Subscribe confirmation response
          socket.write(RespParser.array(['subscribe', channel, String(count)]));
        }
        break;
      }

      case 'UNSUBSCRIBE': {
        const channels = args.length > 0 ? args : pubSubEngine.getSubscribedChannels(socket);
        for (const channel of channels) {
          pubSubEngine.unsubscribe(channel, socket);
          socket.write(RespParser.array(['unsubscribe', channel, '0']));
        }
        break;
      }

      // -------------------------------------------------------------
      // MESH PROTOCOL EXTENSIONS (For Distributed Code Coordination)
      // -------------------------------------------------------------
      case 'MESH.AGENT.REGISTER': {
        // MESH.AGENT.REGISTER <agentId> <role> <machineId> [metadataJson]
        const [agentId, role, machineId, metadataRaw] = args;
        let meta = {};
        if (metadataRaw) {
          try { meta = JSON.parse(metadataRaw); } catch (_) {}
        }
        const agent = await sharedContext.registerAgent(agentId, role, machineId, meta);
        socket.write(RespParser.bulkString(JSON.stringify(agent)));
        break;
      }

      case 'MESH.AGENT.HEARTBEAT': {
        const agentId = args[0];
        const updated = await sharedContext.heartbeatAgent(agentId);
        socket.write(RespParser.bulkString(updated ? 'PONG' : 'NOT_FOUND'));
        break;
      }

      case 'MESH.INTENT.ACQUIRE': {
        // MESH.INTENT.ACQUIRE <agentId> <filePath> <intentDescription> [ttlSec]
        const [agentId, filePath, desc, ttlSec] = args;
        const ttlMs = ttlSec ? parseInt(ttlSec, 10) * 1000 : undefined;
        const res = await intentManager.acquireIntent(agentId, filePath, desc, { ttlMs });
        socket.write(RespParser.bulkString(JSON.stringify(res)));
        break;
      }

      case 'MESH.INTENT.RELEASE': {
        const [agentId, filePath] = args;
        const res = await intentManager.releaseIntent(agentId, filePath);
        socket.write(RespParser.bulkString(JSON.stringify(res)));
        break;
      }

      case 'MESH.CONTEXT.GET': {
        const filePath = args[0];
        if (filePath) {
          const file = sharedContext.getFile(filePath);
          socket.write(RespParser.bulkString(file ? JSON.stringify(file) : null));
        } else {
          const pool = await sharedContext.getUnifiedContext();
          socket.write(RespParser.bulkString(JSON.stringify(pool)));
        }
        break;
      }

      case 'MESH.CHANGE.SUBMIT': {
        // MESH.CHANGE.SUBMIT <agentId> <filePath> <content> [baseHash]
        const [agentId, filePath, content, baseHash] = args;

        // Run conflict detection
        const evaluation = await conflictDetector.evaluateChange(agentId, filePath, content, baseHash);

        if (evaluation.hasConflict) {
          // Notify affected agents immediately
          const alert = await conflictNotifier.notifyConflict(evaluation);
          socket.write(RespParser.bulkString(JSON.stringify({
            status: 'CONFLICT_DETECTED',
            conflict: alert
          })));
        } else {
          // Commit cleanly
          const updated = await sharedContext.commitFileChange(filePath, content, agentId);
          socket.write(RespParser.bulkString(JSON.stringify({
            status: 'COMMITTED',
            file: updated
          })));
        }
        break;
      }

      case 'MESH.CONFLICT.RESOLVE': {
        // MESH.CONFLICT.RESOLVE <conflictId> <strategy> [customContent]
        const [conflictId, strategy, customContent] = args;
        try {
          const res = await conflictResolver.resolve(conflictId, strategy, { customContent });
          socket.write(RespParser.bulkString(JSON.stringify(res)));
        } catch (err) {
          socket.write(RespParser.error(err.message));
        }
        break;
      }

      case 'MESH.STATUS': {
        const agents = sharedContext.getAgents();
        const files = sharedContext.getAllFiles();
        const intents = intentManager.getAllIntents();
        socket.write(RespParser.bulkString(JSON.stringify({
          activeAgentsCount: agents.length,
          filesCount: files.length,
          activeIntentsCount: intents.length,
          timestamp: new Date().toISOString()
        })));
        break;
      }

      default: {
        socket.write(RespParser.error(`unknown command '${op}'`));
        break;
      }
    }
  }

  async stop() {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
  }
}
