import { mongoEngine } from './mongo-engine.js';

export const COLLECTIONS = {
  KV_STORE: 'kv_store',
  AGENTS: 'agents',
  INTENTS: 'intents',
  CODEBASE_FILES: 'codebase_files',
  CONTRACT_GRAPH: 'contract_graph',
  CONFLICTS: 'conflicts',
  AUDIT_LOG: 'audit_log'
};

export function getKvCollection() {
  return mongoEngine.collection(COLLECTIONS.KV_STORE);
}

export function getAgentsCollection() {
  return mongoEngine.collection(COLLECTIONS.AGENTS);
}

export function getIntentsCollection() {
  return mongoEngine.collection(COLLECTIONS.INTENTS);
}

export function getCodebaseFilesCollection() {
  return mongoEngine.collection(COLLECTIONS.CODEBASE_FILES);
}

export function getContractGraphCollection() {
  return mongoEngine.collection(COLLECTIONS.CONTRACT_GRAPH);
}

export function getConflictsCollection() {
  return mongoEngine.collection(COLLECTIONS.CONFLICTS);
}

export function getAuditLogCollection() {
  return mongoEngine.collection(COLLECTIONS.AUDIT_LOG);
}
