import { mongoEngine } from './db/mongo-engine.js';
import { sharedContext } from './context/shared-context.js';
import { RedisServer } from './redis/redis-server.js';
import { HttpServer } from './api/http-server.js';
import { CONFIG } from './config.js';

export class AgentMeshServer {
  constructor(options = {}) {
    this.redisPort = options.redisPort || CONFIG.REDIS_PORT;
    this.httpPort = options.httpPort || CONFIG.HTTP_PORT;
    this.host = options.host || CONFIG.HOST;
    this.redisServer = null;
    this.httpServer = null;
  }

  async start() {
    console.log('================================================================');
    console.log('   🚀 MongoRedis-AgentMesh Server Initializing...   ');
    console.log('================================================================');

    // 1. Initialize MongoDB Document Engine
    console.log(`[MongoEngine] Initializing storage at: ${CONFIG.DATA_DIR}`);
    await mongoEngine.init();
    console.log('[MongoEngine] Database initialized successfully.');

    // 2. Initialize Shared Context Pool & Subsystems
    console.log('[SharedContext] Initializing codebase pool, contracts, and intent locks...');
    await sharedContext.init();
    console.log(`[SharedContext] Codebase pool ready with ${sharedContext.files.size} starter files.`);

    // 3. Start Redis RESP TCP Server
    this.redisServer = new RedisServer(this.redisPort, this.host);
    await this.redisServer.start();

    // 4. Start HTTP REST & WebSocket Server
    this.httpServer = new HttpServer(this.httpPort, this.host);
    await this.httpServer.start();

    console.log('================================================================');
    console.log(` ✅ AgentMesh Server is LIVE!`);
    console.log(`    - Redis RESP Protocol: tcp://${CONFIG.HOST}:${this.redisServer.port}`);
    console.log(`    - Web Dashboard & API: http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${this.httpServer.port}`);
    console.log(`    - WebSocket Live Bus:  ws://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${this.httpServer.port}/ws`);
    console.log(`    - SSE Event Stream:    http://${CONFIG.HOST === '0.0.0.0' ? 'localhost' : CONFIG.HOST}:${this.httpServer.port}/events`);
    console.log('================================================================');

    return this;
  }

  async stop() {
    console.log('[AgentMeshServer] Shutting down...');
    if (this.redisServer) await this.redisServer.stop();
    if (this.httpServer) await this.httpServer.stop();
    await mongoEngine.close();
    console.log('[AgentMeshServer] Clean shutdown complete.');
  }
}

// Direct execution
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = new AgentMeshServer();
  server.start().catch((err) => {
    console.error('[AgentMeshServer] Fatal startup error:', err);
    process.exit(1);
  });

  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
}
