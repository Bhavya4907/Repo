import { getConflictsCollection, getAuditLogCollection } from '../db/collections.js';
import { sharedContext } from '../context/shared-context.js';
import { intentManager } from '../context/intent-manager.js';
import { diff3Merge } from './diff3-merge.js';
import { conflictNotifier } from './notifier.js';

export class ConflictResolver {
  /**
   * Resolve an active conflict using the specified strategy
   */
  async resolve(conflictId, strategy = 'SMART_3WAY_MERGE', options = {}) {
    const coll = getConflictsCollection();
    const conflict = await coll.findOne({ _id: conflictId });

    if (!conflict) {
      throw new Error(`Conflict with ID '${conflictId}' not found.`);
    }

    if (conflict.status === 'RESOLVED') {
      return {
        success: true,
        alreadyResolved: true,
        conflict
      };
    }

    const { filePath, proposedContent, canonicalContent } = conflict;
    let resolvedContent = '';

    switch (strategy.toUpperCase()) {
      case 'SMART_3WAY_MERGE': {
        const mergeResult = diff3Merge('', proposedContent, canonicalContent);
        // If clean or trivial merge, use mergedText; else if custom merge supplied
        resolvedContent = options.customContent || mergeResult.mergedText;
        break;
      }

      case 'ACCEPT_PROPOSED': {
        resolvedContent = proposedContent;
        break;
      }

      case 'REVERT_TO_CANONICAL': {
        resolvedContent = canonicalContent;
        break;
      }

      case 'CUSTOM_PATCH': {
        if (!options.customContent) {
          throw new Error('CUSTOM_PATCH strategy requires options.customContent');
        }
        resolvedContent = options.customContent;
        break;
      }

      case 'CONTRACT_ADAPTER': {
        // Synthesize an adapter that supports both old and new schema fields
        resolvedContent = options.customContent || `${canonicalContent}\n// --- AUTO-ADAPTED MERGE ---\n${proposedContent}`;
        break;
      }

      default:
        throw new Error(`Unknown resolution strategy: ${strategy}`);
    }

    // 1. Commit the resolved content to the shared context pool
    const resolvedBy = options.resolvedBy || 'conflict-resolver-agent';
    const updatedFile = await sharedContext.commitFileChange(filePath, resolvedContent, resolvedBy);

    // 2. Mark conflict as RESOLVED in MongoDB
    const now = new Date().toISOString();
    await coll.updateOne(
      { _id: conflictId },
      {
        $set: {
          status: 'RESOLVED',
          resolutionStrategy: strategy,
          resolvedBy,
          resolvedContent,
          resolvedAt: now
        }
      }
    );

    // 3. Clear any conflicting intent locks
    await intentManager.releaseIntent(conflict.conflictingAgents[0], filePath).catch(() => {});
    await intentManager.releaseIntent(conflict.conflictingAgents[1], filePath).catch(() => {});

    // 4. Notify all agents that conflict is fixed
    await conflictNotifier.notifyResolution({
      conflictId,
      filePath,
      strategy,
      resolvedBy,
      newVersion: updatedFile.version,
      newHash: updatedFile.hash
    });

    // 5. Audit log
    const auditColl = getAuditLogCollection();
    await auditColl.insertOne({
      type: 'CONFLICT_RESOLVED',
      conflictId,
      filePath,
      strategy,
      resolvedBy,
      timestamp: now
    });

    return {
      success: true,
      conflictId,
      filePath,
      strategy,
      resolvedBy,
      newVersion: updatedFile.version,
      newHash: updatedFile.hash
    };
  }
}

export const conflictResolver = new ConflictResolver();
