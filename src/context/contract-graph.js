import { getContractGraphCollection } from '../db/collections.js';
import { pubSubEngine } from '../redis/pubsub.js';

export class ContractGraph {
  constructor() {
    this.contracts = new Map(); // endpointKey -> contract
  }

  async init() {
    const coll = getContractGraphCollection();
    const stored = await coll.find({}).toArray();
    for (const c of stored) {
      this.contracts.set(c.endpoint, c);
    }

    // Seed default sample contracts if empty
    if (this.contracts.size === 0) {
      await this.registerContract({
        endpoint: 'GET /api/v1/users',
        layer: 'backend',
        producerFile: 'src/backend/routes/userRoutes.js',
        consumerFiles: ['src/frontend/services/userService.js', 'src/frontend/components/UserList.jsx'],
        schema: {
          response: {
            id: 'string',
            username: 'string',
            role: 'string',
            status: 'string'
          }
        },
        version: 1
      });

      await this.registerContract({
        endpoint: 'POST /api/v1/auth/login',
        layer: 'backend',
        producerFile: 'src/backend/routes/authRoutes.js',
        consumerFiles: ['src/frontend/services/authService.js', 'src/frontend/components/LoginForm.jsx'],
        schema: {
          request: { username: 'string', password: 'string' },
          response: { token: 'string', user: 'object', expiresIn: 'number' }
        },
        version: 1
      });
    }
  }

  async registerContract(contract) {
    const coll = getContractGraphCollection();
    contract.updatedAt = new Date().toISOString();
    this.contracts.set(contract.endpoint, contract);
    await coll.updateOne({ endpoint: contract.endpoint }, { $set: contract }, { upsert: true });

    pubSubEngine.publish('agentmesh:contracts', {
      type: 'CONTRACT_REGISTERED',
      contract
    });

    return contract;
  }

  getContract(endpoint) {
    return this.contracts.get(endpoint);
  }

  getAllContracts() {
    return Array.from(this.contracts.values());
  }

  findContractsByFile(filePath) {
    const results = [];
    for (const c of this.contracts.values()) {
      if (c.producerFile === filePath || (c.consumerFiles && c.consumerFiles.includes(filePath))) {
        results.push(c);
      }
    }
    return results;
  }

  /**
   * Check if a proposed change to a producer file impacts consumer agents
   */
  checkContractImpact(filePath, proposedChanges) {
    const relatedContracts = this.findContractsByFile(filePath);
    const impacts = [];

    for (const contract of relatedContracts) {
      if (contract.producerFile === filePath) {
        impacts.push({
          endpoint: contract.endpoint,
          producerFile: contract.producerFile,
          consumerFiles: contract.consumerFiles || [],
          warning: `Modifying ${filePath} may impact consumers of ${contract.endpoint}`
        });
      }
    }

    return impacts;
  }
}

export const contractGraph = new ContractGraph();
