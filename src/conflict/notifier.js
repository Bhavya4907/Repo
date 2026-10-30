import { pubSubEngine } from '../redis/pubsub.js';
import { getAuditLogCollection } from '../db/collections.js';

export class ConflictNotifier {
  async notifyConflict(conflictData) {
    const conflictRecord = conflictData.conflictRecord || {};
    const payload = {
      type: 'CONFLICT_ALERT',
      timestamp: new Date().toISOString(),
      conflictId: conflictData._id || conflictRecord._id || 'unassigned',
      filePath: conflictData.filePath || conflictRecord.filePath,
      conflictType: conflictData.type,
      conflictingAgents: conflictData.conflictingAgents || conflictRecord.conflictingAgents || [],
      reason: conflictData.reason || 'Concurrent modification collision detected',
      canAutoMerge: Boolean(conflictData.canAutoMerge),
      resolutionOptions: [
        'SMART_3WAY_MERGE',
        'ACCEPT_PROPOSED',
        'REVERT_TO_CANONICAL',
        'AGENT_NEGOTIATE'
      ]
    };

    // 1. Publish to global conflict channel
    pubSubEngine.publish('agentmesh:conflicts', payload);

    // 2. Publish to each conflicting agent's dedicated channel
    for (const agentId of payload.conflictingAgents) {
      if (agentId && agentId !== 'system') {
        pubSubEngine.publish(`agentmesh:agent:${agentId}`, payload);
      }
    }

    // 3. Publish to file channel
    if (payload.filePath) {
      pubSubEngine.publish(`agentmesh:file:${payload.filePath}`, payload);
    }

    // 4. Record in audit log
    const auditColl = getAuditLogCollection();
    await auditColl.insertOne({
      type: 'CONFLICT_NOTIFIED',
      conflictId: payload.conflictId,
      conflictingAgents: payload.conflictingAgents,
      filePath: payload.filePath,
      timestamp: payload.timestamp
    });

    return payload;
  }

  async notifyResolution(resolutionData) {
    const payload = {
      type: 'CONFLICT_RESOLVED',
      timestamp: new Date().toISOString(),
      conflictId: resolutionData.conflictId,
      filePath: resolutionData.filePath,
      strategy: resolutionData.strategy,
      resolvedBy: resolutionData.resolvedBy,
      newVersion: resolutionData.newVersion,
      newHash: resolutionData.newHash
    };

    pubSubEngine.publish('agentmesh:conflicts', payload);
    pubSubEngine.publish('agentmesh:events', payload);

    if (resolutionData.filePath) {
      pubSubEngine.publish(`agentmesh:file:${resolutionData.filePath}`, payload);
    }

    return payload;
  }
}

export const conflictNotifier = new ConflictNotifier();
