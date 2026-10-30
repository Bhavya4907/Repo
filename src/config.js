import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CONFIG = {
  // Network Ports
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
  HTTP_PORT: parseInt(process.env.HTTP_PORT || '8080', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // MongoDB Configuration
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/agentmesh',
  DATA_DIR: process.env.DATA_DIR || path.resolve(__dirname, '../data'),
  
  // Leases and Heartbeats (in milliseconds)
  DEFAULT_LEASE_TTL_MS: 45 * 1000, // 45 seconds default intent lock lease
  AGENT_HEARTBEAT_INTERVAL_MS: 5 * 1000,
  AGENT_OFFLINE_THRESHOLD_MS: 20 * 1000,

  // Conflict Settings
  AUTO_RESOLVE_TRIVIAL_MERGES: true,
  CONFLICT_NOTIFICATION_CHANNEL: 'agentmesh:conflicts',
  GLOBAL_EVENT_CHANNEL: 'agentmesh:events'
};
