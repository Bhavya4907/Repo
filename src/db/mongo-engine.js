import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CONFIG } from '../config.js';

/**
 * High-performance, zero-dependency MongoDB-compatible Document Engine
 * Supports standard MongoDB CRUD API, Query Operators, Atomic Updates, and Change Streams.
 */
class MongoCollection extends EventEmitter {
  constructor(name, engine) {
    super();
    this.name = name;
    this.engine = engine;
    this.documents = new Map(); // _id -> doc
    this.indexes = new Map();   // fieldName -> Map(val -> Set(_id))
  }

  _clone(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  _matchesFilter(doc, filter = {}) {
    if (!filter || Object.keys(filter).length === 0) return true;

    for (const [key, expected] of Object.entries(filter)) {
      if (key === '$or' && Array.isArray(expected)) {
        const matchesOr = expected.some(subFilter => this._matchesFilter(doc, subFilter));
        if (!matchesOr) return false;
        continue;
      }

      if (key === '$and' && Array.isArray(expected)) {
        const matchesAnd = expected.every(subFilter => this._matchesFilter(doc, subFilter));
        if (!matchesAnd) return false;
        continue;
      }

      // Nested keys support: "metadata.role"
      const actualVal = this._getNestedValue(doc, key);

      if (expected !== null && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof RegExp)) {
        for (const [op, opVal] of Object.entries(expected)) {
          if (op === '$eq' && actualVal !== opVal) return false;
          if (op === '$ne' && actualVal === opVal) return false;
          if (op === '$gt' && !(actualVal > opVal)) return false;
          if (op === '$gte' && !(actualVal >= opVal)) return false;
          if (op === '$lt' && !(actualVal < opVal)) return false;
          if (op === '$lte' && !(actualVal <= opVal)) return false;
          if (op === '$in' && (!Array.isArray(opVal) || !opVal.includes(actualVal))) return false;
          if (op === '$nin' && (Array.isArray(opVal) && opVal.includes(actualVal))) return false;
          if (op === '$exists') {
            const exists = actualVal !== undefined;
            if (exists !== Boolean(opVal)) return false;
          }
          if (op === '$regex') {
            const regex = new RegExp(opVal, expected.$options || '');
            if (!regex.test(String(actualVal ?? ''))) return false;
          }
        }
      } else if (expected instanceof RegExp) {
        if (!expected.test(String(actualVal ?? ''))) return false;
      } else {
        if (actualVal !== expected) return false;
      }
    }
    return true;
  }

  _getNestedValue(obj, keyPath) {
    if (!obj) return undefined;
    if (!keyPath.includes('.')) return obj[keyPath];
    const parts = keyPath.split('.');
    let curr = obj;
    for (const p of parts) {
      if (curr === null || curr === undefined) return undefined;
      curr = curr[p];
    }
    return curr;
  }

  _setNestedValue(obj, keyPath, val) {
    const parts = keyPath.split('.');
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!curr[p] || typeof curr[p] !== 'object') {
        curr[p] = {};
      }
      curr = curr[p];
    }
    curr[parts[parts.length - 1]] = val;
  }

  _applyUpdate(doc, update) {
    let modified = false;

    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        this._setNestedValue(doc, k, this._clone(v));
        modified = true;
      }
    }

    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        const curr = this._getNestedValue(doc, k) || 0;
        this._setNestedValue(doc, k, curr + v);
        modified = true;
      }
    }

    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) {
        const parts = k.split('.');
        let curr = doc;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!curr) break;
          curr = curr[parts[i]];
        }
        if (curr) {
          delete curr[parts[parts.length - 1]];
          modified = true;
        }
      }
    }

    if (update.$push) {
      for (const [k, v] of Object.entries(update.$push)) {
        let arr = this._getNestedValue(doc, k);
        if (!Array.isArray(arr)) {
          arr = [];
          this._setNestedValue(doc, k, arr);
        }
        if (v && v.$each && Array.isArray(v.$each)) {
          arr.push(...v.$each.map(x => this._clone(x)));
        } else {
          arr.push(this._clone(v));
        }
        modified = true;
      }
    }

    if (update.$pull) {
      for (const [k, v] of Object.entries(update.$pull)) {
        let arr = this._getNestedValue(doc, k);
        if (Array.isArray(arr)) {
          const originalLen = arr.length;
          arr = arr.filter(item => {
            if (typeof v === 'object' && v !== null) {
              return !this._matchesFilter(item, v);
            }
            return item !== v;
          });
          this._setNestedValue(doc, k, arr);
          if (arr.length !== originalLen) modified = true;
        }
      }
    }

    if (modified) {
      doc.updatedAt = new Date().toISOString();
    }
    return modified;
  }

  async findOne(filter = {}) {
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        return this._clone(doc);
      }
    }
    return null;
  }

  find(filter = {}, options = {}) {
    const results = [];
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        results.push(this._clone(doc));
      }
    }

    return {
      sort: (sortObj) => {
        if (sortObj && Object.keys(sortObj).length > 0) {
          results.sort((a, b) => {
            for (const [k, direction] of Object.entries(sortObj)) {
              const valA = a[k] ?? '';
              const valB = b[k] ?? '';
              if (valA < valB) return direction === 1 ? -1 : 1;
              if (valA > valB) return direction === 1 ? 1 : -1;
            }
            return 0;
          });
        }
        return this.find(filter, options);
      },
      limit: (num) => {
        const sliced = results.slice(0, num);
        return {
          toArray: async () => sliced
        };
      },
      toArray: async () => results
    };
  }

  async insertOne(doc) {
    const cloned = this._clone(doc);
    if (!cloned._id) {
      cloned._id = crypto.randomUUID();
    }
    if (!cloned.createdAt) cloned.createdAt = new Date().toISOString();
    if (!cloned.updatedAt) cloned.updatedAt = cloned.createdAt;

    this.documents.set(cloned._id, cloned);
    this.engine.scheduleSave();

    const changeEvent = {
      operationType: 'insert',
      documentKey: { _id: cloned._id },
      fullDocument: this._clone(cloned),
      ns: { coll: this.name }
    };
    this.emit('change', changeEvent);
    this.engine.emit('change', changeEvent);

    return { acknowledged: true, insertedId: cloned._id };
  }

  async insertMany(docs) {
    const insertedIds = [];
    for (const doc of docs) {
      const res = await this.insertOne(doc);
      insertedIds.push(res.insertedId);
    }
    return { acknowledged: true, insertedCount: docs.length, insertedIds };
  }

  async updateOne(filter, update, options = {}) {
    let target = null;
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        target = doc;
        break;
      }
    }

    if (!target) {
      if (options.upsert) {
        const newDoc = { ...(filter || {}) };
        if (update.$set) Object.assign(newDoc, update.$set);
        newDoc._id = newDoc._id || crypto.randomUUID();
        newDoc.createdAt = new Date().toISOString();
        newDoc.updatedAt = newDoc.createdAt;
        this.documents.set(newDoc._id, newDoc);
        this.engine.scheduleSave();

        const changeEvent = {
          operationType: 'insert',
          documentKey: { _id: newDoc._id },
          fullDocument: this._clone(newDoc),
          ns: { coll: this.name }
        };
        this.emit('change', changeEvent);
        this.engine.emit('change', changeEvent);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 1, upsertedId: newDoc._id };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }

    const modified = this._applyUpdate(target, update);
    if (modified) {
      this.engine.scheduleSave();
      const changeEvent = {
        operationType: 'update',
        documentKey: { _id: target._id },
        updateDescription: { updatedFields: update.$set || {} },
        fullDocument: this._clone(target),
        ns: { coll: this.name }
      };
      this.emit('change', changeEvent);
      this.engine.emit('change', changeEvent);
    }

    return { acknowledged: true, matchedCount: 1, modifiedCount: modified ? 1 : 0 };
  }

  async findOneAndUpdate(filter, update, options = { returnDocument: 'after' }) {
    let target = null;
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        target = doc;
        break;
      }
    }

    if (!target) {
      if (options.upsert) {
        const newDoc = { ...(filter || {}) };
        if (update.$set) Object.assign(newDoc, update.$set);
        newDoc._id = newDoc._id || crypto.randomUUID();
        newDoc.createdAt = new Date().toISOString();
        newDoc.updatedAt = newDoc.createdAt;
        this.documents.set(newDoc._id, newDoc);
        this.engine.scheduleSave();

        const changeEvent = {
          operationType: 'insert',
          documentKey: { _id: newDoc._id },
          fullDocument: this._clone(newDoc),
          ns: { coll: this.name }
        };
        this.emit('change', changeEvent);
        this.engine.emit('change', changeEvent);
        return this._clone(newDoc);
      }
      return null;
    }

    const before = this._clone(target);
    this._applyUpdate(target, update);
    this.engine.scheduleSave();

    const changeEvent = {
      operationType: 'update',
      documentKey: { _id: target._id },
      fullDocument: this._clone(target),
      ns: { coll: this.name }
    };
    this.emit('change', changeEvent);
    this.engine.emit('change', changeEvent);

    return options.returnDocument === 'before' ? before : this._clone(target);
  }

  async updateMany(filter, update) {
    let count = 0;
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        if (this._applyUpdate(doc, update)) {
          count++;
        }
      }
    }
    if (count > 0) this.engine.scheduleSave();
    return { acknowledged: true, matchedCount: count, modifiedCount: count };
  }

  async deleteOne(filter) {
    for (const [id, doc] of this.documents.entries()) {
      if (this._matchesFilter(doc, filter)) {
        this.documents.delete(id);
        this.engine.scheduleSave();

        const changeEvent = {
          operationType: 'delete',
          documentKey: { _id: id },
          ns: { coll: this.name }
        };
        this.emit('change', changeEvent);
        this.engine.emit('change', changeEvent);
        return { acknowledged: true, deletedCount: 1 };
      }
    }
    return { acknowledged: true, deletedCount: 0 };
  }

  async deleteMany(filter) {
    let count = 0;
    for (const [id, doc] of Array.from(this.documents.entries())) {
      if (this._matchesFilter(doc, filter)) {
        this.documents.delete(id);
        count++;
        const changeEvent = {
          operationType: 'delete',
          documentKey: { _id: id },
          ns: { coll: this.name }
        };
        this.emit('change', changeEvent);
        this.engine.emit('change', changeEvent);
      }
    }
    if (count > 0) this.engine.scheduleSave();
    return { acknowledged: true, deletedCount: count };
  }

  async countDocuments(filter = {}) {
    let count = 0;
    for (const doc of this.documents.values()) {
      if (this._matchesFilter(doc, filter)) {
        count++;
      }
    }
    return count;
  }

  /**
   * MongoDB Change Stream simulation
   */
  watch(pipeline = []) {
    const emitter = new EventEmitter();
    const listener = (change) => {
      emitter.emit('change', change);
    };
    this.on('change', listener);
    emitter.close = () => {
      this.off('change', listener);
      emitter.removeAllListeners();
    };
    return emitter;
  }
}

/**
 * MongoDB Database & Client Manager
 */
export class MongoEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || CONFIG.DATA_DIR;
    this.storageFile = path.join(this.dataDir, 'mongodb_store.json');
    this.collections = new Map();
    this.saveTimeout = null;
    this.isLoaded = false;
  }

  async init() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    this.loadFromDisk();
    this.isLoaded = true;
    return this;
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MongoCollection(name, this));
    }
    return this.collections.get(name);
  }

  scheduleSave() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveToDisk();
    }, 100);
  }

  saveToDisk() {
    try {
      const data = {};
      for (const [name, coll] of this.collections.entries()) {
        data[name] = Array.from(coll.documents.values());
      }
      const tmpFile = `${this.storageFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.storageFile);
    } catch (err) {
      console.error('[MongoEngine] Error saving to disk:', err.message);
    }
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, 'utf8');
        const data = JSON.parse(raw);
        for (const [collName, docs] of Object.entries(data)) {
          const coll = this.collection(collName);
          coll.documents.clear();
          if (Array.isArray(docs)) {
            for (const doc of docs) {
              if (doc && doc._id) {
                coll.documents.set(doc._id, doc);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('[MongoEngine] Could not load previous state from disk, starting fresh:', err.message);
    }
  }

  async flushAll() {
    for (const coll of this.collections.values()) {
      coll.documents.clear();
    }
    this.saveToDisk();
  }

  async close() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.saveToDisk();
  }
}

// Global Singleton Instance
export const mongoEngine = new MongoEngine();
