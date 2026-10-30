import crypto from 'node:crypto';
import { getConflictsCollection } from '../db/collections.js';
import { sharedContext } from '../context/shared-context.js';
import { intentManager } from '../context/intent-manager.js';
import { contractGraph } from '../context/contract-graph.js';
import { diff3Merge } from './diff3-merge.js';

export class ConflictDetector {
  /**
   * Validate a proposed file change against active intents and canonical base version
   */
  async evaluateChange(agentId, filePath, proposedContent, baseHash) {
    const canonicalFile = sharedContext.getFile(filePath);
    const canonicalContent = canonicalFile ? canonicalFile.content : '';
    const canonicalHash = canonicalFile ? canonicalFile.hash : null;

    // 1. Check Intent Lease Collision
    const activeIntent = intentManager.getIntentForFile(filePath);
    if (activeIntent && activeIntent.agentId !== agentId) {
      return {
        hasConflict: true,
        type: 'INTENT_LEASE_COLLISION',
        reason: `File '${filePath}' is actively locked by agent '${activeIntent.agentId}' for purpose: "${activeIntent.description}"`,
        conflictingAgents: [activeIntent.agentId, agentId],
        filePath,
        canAutoMerge: false
      };
    }

    // 2. Check Stale Base Revision Divergence
    if (baseHash && canonicalHash && baseHash !== canonicalHash) {
      // Divergence: Another agent committed a change while this agent was editing!
      const mergeResult = diff3Merge(
        canonicalContent,  // base/current server version
        proposedContent,   // agent's proposed version
        canonicalContent   // divergence test
      );

      // Perform deep 3-way merge attempt between canonical current, agent proposed, and ancestral state
      const mergeAttempt = diff3Merge('', proposedContent, canonicalContent);

      const conflictRecord = {
        _id: `conf_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        filePath,
        type: 'CONCURRENT_DIVERGENCE',
        conflictingAgents: [canonicalFile.lastModifiedBy, agentId],
        baseHash,
        currentCanonicalHash: canonicalHash,
        proposedContent,
        canonicalContent,
        mergeCandidate: mergeResult.mergedText,
        conflicts: mergeResult.conflicts,
        hasOverlappingHunks: mergeResult.hasConflicts,
        status: 'PENDING_RESOLUTION',
        createdAt: new Date().toISOString()
      };

      const coll = getConflictsCollection();
      await coll.insertOne(conflictRecord);

      return {
        hasConflict: true,
        type: 'CONCURRENT_DIVERGENCE',
        conflictRecord,
        canAutoMerge: !mergeResult.hasConflicts
      };
    }

    // 3. Check Cross-Layer Contract Breakages (Frontend <-> Backend)
    const contractImpacts = contractGraph.checkContractImpact(filePath, proposedContent);
    if (contractImpacts.length > 0) {
      // Return non-blocking advisory or warning
      return {
        hasConflict: false,
        warnings: contractImpacts
      };
    }

    // Clean, no conflict!
    return {
      hasConflict: false
    };
  }

  async getPendingConflicts() {
    const coll = getConflictsCollection();
    return coll.find({ status: 'PENDING_RESOLUTION' }).toArray();
  }

  async getConflictById(conflictId) {
    const coll = getConflictsCollection();
    return coll.findOne({ _id: conflictId });
  }
}

export const conflictDetector = new ConflictDetector();
