# ⚡ MongoRedis AgentMesh

> **A Redis-compatible server-based data fetching and context synchronization mesh powered by MongoDB for distributed AI agents working concurrently on the same codebase across different machines.**

---

## 🎯 The Problem & Vision

When multiple AI agents (e.g. 2 Frontend agents and 2 Backend agents) work simultaneously on the same repository across different machines, classic Git-based or isolated approaches suffer from:
1. **Blind Collisions**: Agents overwrite each other's code without knowing what another machine is editing.
2. **Contract Desynchronization**: A backend agent changes an API endpoint or database schema, breaking frontend components being constructed simultaneously on another machine.
3. **Stale Base Divergence**: Two agents make independent modifications to the same file from a shared initial revision, causing merge nightmares.

**MongoRedis AgentMesh** solves this by unifying:
- **Redis RESP Protocol & Ultra-Low Latency Pub/Sub**: Drop-in compatible with standard Redis clients (`redis-cli`, `ioredis`, `redis-py`).
- **MongoDB Persistence & Rich Document Engine**: Stores canonical codebase files, change logs, contract interface graphs, and active work leases.
- **Shared Context Pool**: A real-time synchronized view of the codebase, active agent tasks, exported endpoints, and dependency graphs.
- **Conflict Prevention Engine**: Proactive Intent Leases that prevent collisions before a single line is written.
- **Conflict Detection & Auto-Resolution**: Real-time 3-way semantic diffs, instant alerts pushed to affected machines, and automated conflict healing (`SMART_3WAY_MERGE`).

---

## 🏗️ Architecture

```
                                    +-----------------------------------------+
                                    |        Distributed Machines / Hosts     |
                                    +-----------------------------------------+
                                    | Machine A: Frontend Agent 1 (React UI)  |
                                    | Machine B: Frontend Agent 2 (Services)  |
                                    | Machine C: Backend Agent 1 (Users API)  |
                                    | Machine D: Backend Agent 2 (Auth API)   |
                                    +-----------------------------------------+
                                                         │
                        ┌────────────────────────────────┴────────────────────────────────┐
                        │ TCP :6379 (Redis RESP)             HTTP/WS :8080 (REST + Events)│
                        ▼                                                                 ▼
    +─────────────────────────────────────────────────────────────────────────────────────────────+
    |                                   MONGOREDIS AGENTMESH SERVER                               |
    |                                                                                             |
    |  +─────────────────────────+  +──────────────────────────+  +────────────────────────────+  |
    |  |    Redis RESP Engine    |  |     Shared Context Pool  |  |    Conflict & Intent Engine|  |
    |  |  PING, SET, GET, HSET,  |  |  - Canonical Code Files  |  |  - Intent Leases (Locks)   |  |
    |  |  KEYS, PUBLISH, SUB     |  |  - Symbol & AST Graph    |  |  - Stale Divergence Check  |  |
    |  |  + MESH Protocol Cmds   |  |  - Cross-Layer Contracts |  |  - Diff3 3-Way Auto-Merge  |  |
    |  +─────────────────────────+  +──────────────────────────+  +────────────────────────────+  |
    |                                                                                             |
    |  +───────────────────────────────────────────────────────────────────────────────────────+  |
    |  |                                  MongoDB Document Store                               |  |
    |  |   [kv_store]      [agents]      [intents]      [codebase_files]     [conflicts]       |  |
    |  +───────────────────────────────────────────────────────────────────────────────────────+  |
    +─────────────────────────────────────────────────────────────────────────────────────────────+
                                                         │
                                                         ▼
                                            +--------------------------+
                                            |   Live Visual Dashboard  |
                                            |   http://localhost:8080  |
                                            +--------------------------+
```

---

## 🚀 Quick Start

### 1. Requirements
- Node.js 18+ (tested on Node.js v24)
- Zero external package dependencies needed! The entire engine runs natively out of the box.

### 2. Run the Server
```bash
cd y:\mongo-redis-agentmesh
npm start
```
By default, the server listens on:
- **Redis TCP**: `tcp://0.0.0.0:6379`
- **Web Dashboard & API**: `http://localhost:8080`
- **WebSocket Event Bus**: `ws://localhost:8080/ws`
- **SSE Stream**: `http://localhost:8080/events`

### 3. Run the Distributed Multi-Agent Simulation
Experience 4 agents across different machines in a realistic frontend/backend workflow:
```bash
npm run simulate
```

### 4. Run the Test Suite
```bash
npm test
```

---

## 🛠️ Key Capabilities & Workflow

### 1. Conflict Avoidance (Intent Locking)
Before modifying a file or route, an agent registers an **Intent Lease** with a TTL:
```javascript
const lease = await agent.acquireIntent(
  'src/backend/routes/userRoutes.js',
  'Adding avatar and bio fields to User model',
  { ttlMs: 45000 }
);

if (!lease.success) {
  console.log(`Avoided collision! Locked by ${lease.currentHolder.agentId}`);
}
```
If another agent on a different machine attempts to touch the same file, the server returns `CONFLICT_PREVENTED`, alerting the second agent to choose another task or coordinate with the holder.

### 2. Cross-Layer Context Synchronization
When a backend agent modifies an API route:
1. The backend agent submits the change: `agent.submitChange(filePath, newContent, baseHash)`.
2. The server updates the canonical codebase version in MongoDB.
3. The server checks the **Contract Graph** (`GET /api/v1/users`).
4. Instant Pub/Sub notifications are dispatched to all **Frontend Agents** registered on other machines.
5. Frontend agents receive the updated API schema definition before broken assumptions cause bugs!

### 3. Automated Conflict Detection & 3-Way Resolution
If two agents submit concurrent edits to the same file without acquiring a lease:
1. **Divergence Detected**: The server notices the second agent's `baseHash` does not match the latest canonical hash.
2. **Real-time Alert Dispatched**: Both agents receive a `CONFLICT_ALERT` via WebSockets and Redis channel `agentmesh:conflicts`.
3. **Automated 3-Way Semantic Merge**:
   - The conflict engine runs `diff3Merge(base, our, their)`.
   - If changes are in disjoint sections (e.g. Agent A added `THEMES` and Agent B added `LOCALES`), the engine **automatically reconciles both changes with zero data loss**!
   - If conflicting lines overlap, structured conflict markers are generated and agents can negotiate or accept proposed versions.

---

## 📡 API Reference

### Redis RESP Commands
Connect any Redis client to `localhost:6379`:

| Command | Description | Example |
|---|---|---|
| `PING` | Health check | `PING` -> `+PONG` |
| `SET <key> <val> [EX sec]` | Store key-value in MongoDB | `SET task:1 "Refactor" EX 60` |
| `GET <key>` | Retrieve value from MongoDB | `GET task:1` |
| `HSET <key> <field> <val>` | Hash map set | `HSET agent:1 machine "aws-ec2"` |
| `HGETALL <key>` | Get all hash entries | `HGETALL agent:1` |
| `PUBLISH <channel> <msg>` | Publish real-time message | `PUBLISH agentmesh:events "ping"` |
| `SUBSCRIBE <channel>` | Subscribe to real-time events | `SUBSCRIBE agentmesh:conflicts` |
| `MESH.AGENT.REGISTER` | Register agent in mesh | `MESH.AGENT.REGISTER ag1 frontend host-1` |
| `MESH.INTENT.ACQUIRE` | Lock file intent lease | `MESH.INTENT.ACQUIRE ag1 src/api.js "edit" 45` |
| `MESH.CONTEXT.GET` | Get shared context pool | `MESH.CONTEXT.GET` |
| `MESH.CHANGE.SUBMIT` | Submit file change with check | `MESH.CHANGE.SUBMIT ag1 src/api.js "..." hash` |
| `MESH.CONFLICT.RESOLVE` | Resolve active conflict | `MESH.CONFLICT.RESOLVE conf_123 SMART_3WAY_MERGE` |

### HTTP REST Endpoints
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/context` | Returns full common context pool (agents, files, contracts, intents) |
| `GET` | `/api/files` | Lists all tracked codebase files and versions |
| `GET` | `/api/files/content?path=...` | Retrieves specific file content and canonical hash |
| `POST` | `/api/agents/register` | Registers an agent on a machine |
| `POST` | `/api/agents/heartbeat` | Agent keepalive |
| `POST` | `/api/intent/acquire` | Acquires intent lock on a file |
| `POST` | `/api/intent/release` | Releases intent lock |
| `POST` | `/api/changes/submit` | Submits file change with conflict checking |
| `GET` | `/api/conflicts` | Returns all pending conflicts |
| `POST` | `/api/conflicts/resolve` | Triggers resolution (`SMART_3WAY_MERGE`, etc.) |
| `GET` | `/events` | Server-Sent Events stream for real-time notifications |
| `WS` | `/ws` | WebSocket bidirectional event stream |

---

## 💻 Agent Client SDK Example (Node.js)

```javascript
import { AgentMeshClient } from './src/client/agent-client.js';

const client = new AgentMeshClient({
  serverUrl: 'http://central-mesh-server:8080',
  agentId: 'agent-frontend-alpha',
  role: 'frontend',
  machineId: 'dev-laptop-01'
});

// 1. Connect
await client.connect();

// 2. Listen for conflict alerts
client.on('conflict', (alert) => {
  console.log('Conflict alert on:', alert.filePath);
  // Trigger auto-resolve or negotiate
});

// 3. Check shared context pool
const context = await client.getContext();
console.log('Online agents:', context.agents);

// 4. Acquire intent lease before editing
const lease = await client.acquireIntent('src/shared/types.js', 'Adding user themes');
if (lease.success) {
  // Fetch current file
  const file = await client.getFile('src/shared/types.js');
  
  // Make modifications
  const newContent = file.content + '\nexport const THEMES = ["dark", "light"];\n';
  
  // Submit with conflict check
  const res = await client.submitChange('src/shared/types.js', newContent, file.hash);
  console.log('Commit status:', res.status);
  
  // Release intent
  await client.releaseIntent('src/shared/types.js');
}
```

---

## 🖥️ Live Web Dashboard

Open `http://localhost:8080` in your browser to inspect:
- **Fleet View**: Live health badges of agents across machines.
- **Shared Context Tree**: Canonical file versions, hashes, and AST contracts.
- **Conflict Monitor**: Real-time side-by-side diffs with 1-click **Auto 3-Way Merge**.
- **Interactive Redis Console**: Execute native Redis commands directly in the browser!

---

## 🗺️ Implementation Plan & Production Roadmap

For the complete, exhaustive implementation guide, see [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

### Phased Engineering Plan Overview

| Phase | Focus Area | Core Deliverables | Status |
|---|---|---|---|
| **Phase 1** | **Storage & Redis RESP Core** | MongoDB collections (`kv_store`, `agents`, `codebase_files`), custom RESP wire parser, atomic TTL expiry, Redis Pub/Sub engine. | ✅ Complete |
| **Phase 2** | **Context & Contract Graph** | Centralized codebase tree, SHA-256 versioning, cross-layer contract mapping (Frontend ↔ Backend route dependencies). | ✅ Complete |
| **Phase 3** | **Conflict Avoidance (Intent Leases)** | Hierarchical intention locking, TTL leases with auto-eviction on agent crash, pre-flight conflict shields (`CONFLICT_PREVENTED`). | ✅ Complete |
| **Phase 4** | **Conflict Detection & Alerts** | Stale base divergence detector, real-time alert broadcasts over WebSockets, SSE, and Redis channel `agentmesh:conflicts`. | ✅ Complete |
| **Phase 5** | **Self-Healing Merge Engine** | Zero-data-loss 3-way semantic line merge (`SMART_3WAY_MERGE`), contract adapter synthesis, agent negotiation protocol. | ✅ Complete |
| **Phase 6** | **Distributed Deployment & SDKs** | Docker Compose blueprints, Tailscale/WireGuard overlay networking, Node.js and Python Client SDKs. | ✅ Complete |
| **Phase 7** | **Verification & Simulation** | Automated test suite (`npm test`), 4-agent distributed cross-machine simulation (`npm run simulate`). | ✅ Complete |

