import crypto from 'node:crypto';
import { getCodebaseFilesCollection, getAgentsCollection, getAuditLogCollection } from '../db/collections.js';
import { intentManager } from './intent-manager.js';
import { contractGraph } from './contract-graph.js';
import { pubSubEngine } from '../redis/pubsub.js';

export class SharedContextPool {
  constructor() {
    this.files = new Map(); // path -> { path, content, hash, version, lastModifiedBy, updatedAt }
    this.agents = new Map(); // agentId -> { agentId, role, machineId, lastHeartbeat, metadata }
  }

  static computeHash(content) {
    return crypto.createHash('sha256').update(content || '').digest('hex').slice(0, 12);
  }

  async init() {
    await intentManager.init();
    await contractGraph.init();

    // Load files from MongoDB
    const fileColl = getCodebaseFilesCollection();
    const storedFiles = await fileColl.find({}).toArray();
    for (const f of storedFiles) {
      this.files.set(f.path, f);
    }

    // Load agents
    const agentColl = getAgentsCollection();
    const storedAgents = await agentColl.find({}).toArray();
    for (const a of storedAgents) {
      this.agents.set(a.agentId, a);
    }

    // Seed realistic multi-agent starter codebase if empty
    if (this.files.size === 0) {
      await this._seedStarterCodebase();
    }
  }

  async _seedStarterCodebase() {
    const starterFiles = [
      {
        path: 'src/shared/types.js',
        content: `// Common Types and Shared API Contracts\nexport const ROLES = ['admin', 'developer', 'viewer'];\n\nexport const API_ENDPOINTS = {\n  USERS: '/api/v1/users',\n  AUTH_LOGIN: '/api/v1/auth/login'\n};\n`,
        lastModifiedBy: 'system'
      },
      {
        path: 'src/backend/routes/userRoutes.js',
        content: `// Backend Users Route (Produced by Backend Agents)\nimport { Router } from 'express';\nimport { ROLES } from '../../shared/types.js';\n\nconst router = Router();\n\nrouter.get('/api/v1/users', (req, res) => {\n  res.json([\n    { id: '1', username: 'alice', role: 'admin', status: 'active' },\n    { id: '2', username: 'bob', role: 'developer', status: 'idle' }\n  ]);\n});\n\nexport default router;\n`,
        lastModifiedBy: 'system'
      },
      {
        path: 'src/backend/routes/authRoutes.js',
        content: `// Backend Auth Route (Produced by Backend Agents)\nimport { Router } from 'express';\n\nconst router = Router();\n\nrouter.post('/api/v1/auth/login', (req, res) => {\n  const { username, password } = req.body;\n  res.json({ token: 'mock-jwt-token-xyz', expiresIn: 3600 });\n});\n\nexport default router;\n`,
        lastModifiedBy: 'system'
      },
      {
        path: 'src/frontend/services/userService.js',
        content: `// Frontend Service (Consumed by Frontend Agents)\nimport { API_ENDPOINTS } from '../../shared/types.js';\n\nexport async function fetchUsers() {\n  const response = await fetch(API_ENDPOINTS.USERS);\n  return response.json();\n}\n`,
        lastModifiedBy: 'system'
      },
      {
        path: 'src/frontend/components/UserList.jsx',
        content: `// Frontend Component (Rendered by Frontend Agents)\nimport React, { useEffect, useState } from 'react';\nimport { fetchUsers } from '../services/userService.js';\n\nexport function UserList() {\n  const [users, setUsers] = useState([]);\n  useEffect(() => {\n    fetchUsers().then(data => setUsers(data));\n  }, []);\n\n  return (\n    <div className="user-list">\n      <h2>Team Members</h2>\n      {users.map(u => (\n        <div key={u.id}>{u.username} - {u.role}</div>\n      ))}\n    </div>\n  );\n}\n`,
        lastModifiedBy: 'system'
      }
    ];

    const fileColl = getCodebaseFilesCollection();
    for (const item of starterFiles) {
      const doc = {
        path: item.path,
        content: item.content,
        hash: SharedContextPool.computeHash(item.content),
        version: 1,
        lastModifiedBy: item.lastModifiedBy,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      this.files.set(item.path, doc);
      await fileColl.insertOne(doc);
    }
  }

  // Agent Management
  async registerAgent(agentId, role, machineId, metadata = {}) {
    const agent = {
      agentId,
      role: role || 'developer',
      machineId: machineId || 'unknown-host',
      metadata,
      lastHeartbeat: Date.now(),
      status: 'active',
      updatedAt: new Date().toISOString()
    };

    this.agents.set(agentId, agent);
    const coll = getAgentsCollection();
    await coll.updateOne({ agentId }, { $set: agent }, { upsert: true });

    pubSubEngine.publish('agentmesh:events', {
      type: 'AGENT_REGISTERED',
      agent
    });

    return agent;
  }

  async heartbeatAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    agent.lastHeartbeat = Date.now();
    agent.status = 'active';

    const coll = getAgentsCollection();
    await coll.updateOne({ agentId }, { $set: { lastHeartbeat: agent.lastHeartbeat, status: 'active' } });

    return agent;
  }

  getAgents() {
    return Array.from(this.agents.values());
  }

  // File & State Access
  getFile(filePath) {
    return this.files.get(filePath) || null;
  }

  getAllFiles() {
    return Array.from(this.files.values()).map(f => ({
      path: f.path,
      hash: f.hash,
      version: f.version,
      lastModifiedBy: f.lastModifiedBy,
      updatedAt: f.updatedAt,
      size: (f.content || '').length
    }));
  }

  /**
   * Commit a change to the shared context pool
   */
  async commitFileChange(filePath, newContent, agentId, options = {}) {
    const file = this.files.get(filePath);
    const oldContent = file ? file.content : '';
    const oldHash = file ? file.hash : null;
    const newHash = SharedContextPool.computeHash(newContent);
    const newVersion = file ? file.version + 1 : 1;

    const updatedDoc = {
      path: filePath,
      content: newContent,
      hash: newHash,
      version: newVersion,
      lastModifiedBy: agentId,
      updatedAt: new Date().toISOString()
    };

    this.files.set(filePath, updatedDoc);

    const coll = getCodebaseFilesCollection();
    await coll.updateOne({ path: filePath }, { $set: updatedDoc }, { upsert: true });

    const auditColl = getAuditLogCollection();
    await auditColl.insertOne({
      type: 'FILE_UPDATED',
      filePath,
      agentId,
      oldHash,
      newHash,
      version: newVersion,
      timestamp: new Date().toISOString()
    });

    // Broadcast file change across all connected machines
    const changeEvent = {
      type: 'FILE_CHANGED',
      filePath,
      agentId,
      version: newVersion,
      hash: newHash,
      timestamp: updatedDoc.updatedAt
    };

    pubSubEngine.publish('agentmesh:events', changeEvent);
    pubSubEngine.publish(`agentmesh:file:${filePath}`, changeEvent);

    return updatedDoc;
  }

  /**
   * Return the entire Shared Context Pool:
   * Codebase map, active leases, API contracts, online agents
   */
  async getUnifiedContext() {
    return {
      timestamp: new Date().toISOString(),
      agents: this.getAgents(),
      activeIntents: intentManager.getAllIntents(),
      contracts: contractGraph.getAllContracts(),
      files: this.getAllFiles()
    };
  }
}

export const sharedContext = new SharedContextPool();
