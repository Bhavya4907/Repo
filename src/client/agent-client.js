import http from 'node:http';
import { EventEmitter } from 'node:events';

/**
 * AgentMesh Client SDK
 * Used by agents running across distributed machines to coordinate,
 * fetch context, acquire intent locks, broadcast changes, and resolve conflicts.
 */
export class AgentMeshClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || 'http://localhost:8080';
    this.agentId = options.agentId || `agent_${Math.random().toString(36).slice(2, 8)}`;
    this.role = options.role || 'developer';
    this.machineId = options.machineId || 'localhost';
    this.metadata = options.metadata || {};
    this.heartbeatInterval = null;
    this.eventSource = null;
  }

  async _request(method, path, body = null) {
    const url = new URL(path, this.serverUrl);
    return new Promise((resolve, reject) => {
      const req = http.request(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              const err = new Error(parsed.error || parsed.reason || `HTTP ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.data = parsed;
              reject(err);
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Connect to the Mesh and start heartbeats
   */
  async connect() {
    // 1. Register agent
    const res = await this._request('POST', '/api/agents/register', {
      agentId: this.agentId,
      role: this.role,
      machineId: this.machineId,
      metadata: this.metadata
    });

    // 2. Start heartbeat
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this._request('POST', '/api/agents/heartbeat', { agentId: this.agentId });
      } catch (err) {
        this.emit('heartbeat_error', err);
      }
    }, 5000);

    // 3. Connect to SSE stream for real-time conflict & update notifications
    this._connectSSE();

    this.emit('connected', res.agent);
    return res.agent;
  }

  _connectSSE() {
    const url = new URL('/events', this.serverUrl);
    const req = http.request(url, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // keep last incomplete line
        for (const block of lines) {
          const match = block.match(/^data:\s*(.+)$/m);
          if (match) {
            try {
              const event = JSON.parse(match[1]);
              this._handleIncomingEvent(event);
            } catch (_) {}
          }
        }
      });
    });

    req.on('error', (err) => {
      this.emit('sse_error', err);
      // Reconnect after 3s
      setTimeout(() => this._connectSSE(), 3000);
    });

    req.end();
  }

  _handleIncomingEvent(event) {
    this.emit('event', event);

    let data = event.data || event.payload || event;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (_) {}
    }

    if (data && (data.type === 'CONFLICT_ALERT' || event.channel === 'agentmesh:conflicts')) {
      if (data.type === 'CONFLICT_ALERT') {
        this.emit('conflict', data);
      } else if (data.type === 'CONFLICT_RESOLVED') {
        this.emit('conflict_resolved', data);
      }
    }

    if (event.channel && event.channel.startsWith('agentmesh:file:')) {
      this.emit('file_event', data);
    }
  }

  /**
   * Fetch the shared context pool
   */
  async getContext() {
    return this._request('GET', '/api/context');
  }

  /**
   * Fetch a specific file content and current hash
   */
  async getFile(filePath) {
    return this._request('GET', `/api/files/content?path=${encodeURIComponent(filePath)}`);
  }

  /**
   * Acquire an intent lock on a file/component to prevent conflict before editing
   */
  async acquireIntent(filePath, description, options = {}) {
    return this._request('POST', '/api/intent/acquire', {
      agentId: this.agentId,
      machineId: this.machineId,
      role: this.role,
      filePath,
      description,
      ttlMs: options.ttlMs,
      symbols: options.symbols
    });
  }

  /**
   * Release intent lock
   */
  async releaseIntent(filePath) {
    return this._request('POST', '/api/intent/release', {
      agentId: this.agentId,
      filePath
    });
  }

  /**
   * Submit an update to a file with conflict check
   */
  async submitChange(filePath, content, baseHash) {
    try {
      return await this._request('POST', '/api/changes/submit', {
        agentId: this.agentId,
        filePath,
        content,
        baseHash
      });
    } catch (err) {
      if (err.statusCode === 409) {
        // Return structured conflict info
        return {
          status: 'CONFLICT_DETECTED',
          conflict: err.data?.conflict || err.data
        };
      }
      throw err;
    }
  }

  /**
   * Programmatically fix and resolve a conflict
   */
  async resolveConflict(conflictId, strategy = 'SMART_3WAY_MERGE', options = {}) {
    return this._request('POST', '/api/conflicts/resolve', {
      conflictId,
      strategy,
      customContent: options.customContent,
      resolvedBy: this.agentId
    });
  }

  /**
   * Disconnect cleanly
   */
  disconnect() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.removeAllListeners();
  }
}
