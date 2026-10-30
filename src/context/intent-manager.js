import { getIntentsCollection, getAuditLogCollection } from '../db/collections.js';
import { pubSubEngine } from '../redis/pubsub.js';
import { CONFIG } from '../config.js';

export class IntentManager {
  constructor() {
    this.activeIntents = new Map(); // file -> intent
    this.cleanupTimer = null;
  }

  async init() {
    const coll = getIntentsCollection();
    const now = Date.now();
    // Load non-expired intents
    const stored = await coll.find({ expiresAt: { $gt: now } }).toArray();
    for (const intent of stored) {
      this.activeIntents.set(intent.filePath, intent);
    }

    // Start background lease cleaner
    this.cleanupTimer = setInterval(() => this.cleanupExpiredIntents(), 5000);
  }

  /**
   * Acquire a working intent / lease on a file or component
   */
  async acquireIntent(agentId, filePath, description, options = {}) {
    this.cleanupExpiredIntents();

    const ttlMs = options.ttlMs || CONFIG.DEFAULT_LEASE_TTL_MS;
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const existing = this.activeIntents.get(filePath);

    if (existing) {
      if (existing.agentId === agentId) {
        // Renew lease
        existing.expiresAt = expiresAt;
        existing.description = description || existing.description;
        existing.updatedAt = new Date().toISOString();

        const coll = getIntentsCollection();
        await coll.updateOne({ _id: existing._id }, { $set: existing });

        return {
          success: true,
          action: 'RENEWED',
          intent: existing
        };
      }

      // Conflict avoided! File is currently leased by another agent
      return {
        success: false,
        action: 'CONFLICT_PREVENTED',
        reason: `File '${filePath}' is actively locked by agent '${existing.agentId}' (${existing.role || 'unknown'})`,
        currentHolder: existing
      };
    }

    // Grant new lease
    const intent = {
      _id: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      agentId,
      machineId: options.machineId || 'unknown',
      role: options.role || 'general',
      filePath,
      description: description || 'Modifying file',
      symbols: options.symbols || [],
      acquiredAt: now,
      expiresAt,
      createdAt: new Date().toISOString()
    };

    this.activeIntents.set(filePath, intent);

    const coll = getIntentsCollection();
    await coll.insertOne(intent);

    // Audit log
    const auditColl = getAuditLogCollection();
    await auditColl.insertOne({
      type: 'INTENT_ACQUIRED',
      agentId,
      filePath,
      expiresAt,
      timestamp: new Date().toISOString()
    });

    // Notify all agents via Redis Pub/Sub
    pubSubEngine.publish('agentmesh:events', {
      type: 'INTENT_ACQUIRED',
      intent
    });

    pubSubEngine.publish(`agentmesh:file:${filePath}`, {
      type: 'INTENT_ACQUIRED',
      intent
    });

    return {
      success: true,
      action: 'ACQUIRED',
      intent
    };
  }

  /**
   * Release an acquired intent
   */
  async releaseIntent(agentId, filePath) {
    const existing = this.activeIntents.get(filePath);
    if (!existing) {
      return { success: true, message: 'No active intent to release' };
    }

    if (existing.agentId !== agentId) {
      return {
        success: false,
        error: `Cannot release intent held by agent '${existing.agentId}'`
      };
    }

    this.activeIntents.delete(filePath);

    const coll = getIntentsCollection();
    await coll.deleteOne({ _id: existing._id });

    // Audit log
    const auditColl = getAuditLogCollection();
    await auditColl.insertOne({
      type: 'INTENT_RELEASED',
      agentId,
      filePath,
      timestamp: new Date().toISOString()
    });

    // Notify agents
    pubSubEngine.publish('agentmesh:events', {
      type: 'INTENT_RELEASED',
      filePath,
      agentId
    });

    pubSubEngine.publish(`agentmesh:file:${filePath}`, {
      type: 'INTENT_RELEASED',
      filePath,
      agentId
    });

    return { success: true, released: existing };
  }

  /**
   * Check if a file is currently locked
   */
  getIntentForFile(filePath) {
    this.cleanupExpiredIntents();
    return this.activeIntents.get(filePath) || null;
  }

  /**
   * List all active intents across the mesh
   */
  getAllIntents() {
    this.cleanupExpiredIntents();
    return Array.from(this.activeIntents.values());
  }

  /**
   * Expire old leases automatically
   */
  cleanupExpiredIntents() {
    const now = Date.now();
    for (const [filePath, intent] of this.activeIntents.entries()) {
      if (intent.expiresAt <= now) {
        this.activeIntents.delete(filePath);
        getIntentsCollection().deleteOne({ _id: intent._id }).catch(() => {});

        pubSubEngine.publish('agentmesh:events', {
          type: 'INTENT_EXPIRED',
          filePath,
          agentId: intent.agentId
        });
      }
    }
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const intentManager = new IntentManager();
