import assert from 'node:assert';
import net from 'node:net';
import { mongoEngine } from '../db/mongo-engine.js';
import { sharedContext } from '../context/shared-context.js';
import { intentManager } from '../context/intent-manager.js';
import { diff3Merge } from '../conflict/diff3-merge.js';
import { conflictDetector } from '../conflict/detector.js';
import { conflictResolver } from '../conflict/resolver.js';
import { RedisServer } from '../redis/redis-server.js';
import { HttpServer } from '../api/http-server.js';
import { RespParser } from '../redis/resp-parser.js';

let passed = 0;
let failed = 0;

function it(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(err);
      failed++;
    }
  };
}

async function runTests() {
  console.log('================================================================');
  console.log('   🧪 Running MongoRedis AgentMesh Integration Test Suite');
  console.log('================================================================\n');

  // 1. MongoEngine Tests
  const testMongo = it('MongoEngine: CRUD operations and operators', async () => {
    await mongoEngine.init();
    const coll = mongoEngine.collection('test_coll');
    await coll.deleteMany({});

    // insertOne
    const insertRes = await coll.insertOne({ name: 'agent-1', score: 10, role: 'frontend' });
    assert.ok(insertRes.insertedId);

    // findOne
    const doc = await coll.findOne({ name: 'agent-1' });
    assert.strictEqual(doc.role, 'frontend');

    // updateOne with $inc and $set
    await coll.updateOne({ name: 'agent-1' }, { $inc: { score: 5 }, $set: { status: 'busy' } });
    const updated = await coll.findOne({ name: 'agent-1' });
    assert.strictEqual(updated.score, 15);
    assert.strictEqual(updated.status, 'busy');

    // Query operators: $gt, $in
    const queryRes = await coll.find({ score: { $gt: 10 }, role: { $in: ['frontend', 'backend'] } }).toArray();
    assert.strictEqual(queryRes.length, 1);
  });

  // 2. Diff3 3-Way Merge
  const testDiff3 = it('Conflict Engine: 3-Way Merge reconciliation', async () => {
    const base = `line1\nline2\nline3`;
    const our = `line1_MODIFIED_BY_AGENT_A\nline2\nline3`;
    const their = `line1\nline2\nline3_MODIFIED_BY_AGENT_B`;

    const result = diff3Merge(base, our, their);
    assert.strictEqual(result.hasConflicts, false);
    assert.ok(result.mergedText.includes('line1_MODIFIED_BY_AGENT_A'));
    assert.ok(result.mergedText.includes('line3_MODIFIED_BY_AGENT_B'));
  });

  // 3. Shared Context Pool & Starter Files
  const testContext = it('SharedContext: File tracking and versioning', async () => {
    await sharedContext.init();
    const files = sharedContext.getAllFiles();
    assert.ok(files.length >= 5);

    const initialFile = sharedContext.getFile('src/shared/types.js');
    assert.ok(initialFile);
    const initialHash = initialFile.hash;

    // Agent commits update
    const commit = await sharedContext.commitFileChange(
      'src/shared/types.js',
      initialFile.content + '\n// Test comment\n',
      'test-agent'
    );

    assert.notStrictEqual(commit.hash, initialHash);
    assert.strictEqual(commit.version, initialFile.version + 1);
  });

  // 4. Intent Locking & Conflict Avoidance
  const testIntent = it('IntentManager: Avoids conflicts by preventing concurrent locks', async () => {
    const filePath = 'src/backend/routes/authRoutes.js';

    // Agent 1 acquires intent
    const lock1 = await intentManager.acquireIntent('agent-backend-1', filePath, 'Refactoring auth');
    assert.strictEqual(lock1.success, true);
    assert.strictEqual(lock1.action, 'ACQUIRED');

    // Agent 2 tries to acquire intent on same file
    const lock2 = await intentManager.acquireIntent('agent-backend-2', filePath, 'Fixing password regex');
    assert.strictEqual(lock2.success, false);
    assert.strictEqual(lock2.action, 'CONFLICT_PREVENTED');

    // Agent 1 releases intent
    const release = await intentManager.releaseIntent('agent-backend-1', filePath);
    assert.strictEqual(release.success, true);

    // Now Agent 2 can acquire
    const lock3 = await intentManager.acquireIntent('agent-backend-2', filePath, 'Fixing password regex');
    assert.strictEqual(lock3.success, true);
    await intentManager.releaseIntent('agent-backend-2', filePath);
  });

  // 5. Conflict Detection & Resolution Loop
  const testConflictResolution = it('ConflictDetector & Resolver: Detects stale divergence and auto-resolves', async () => {
    const file = sharedContext.getFile('src/frontend/services/userService.js');
    const staleHash = '000000stale';

    // Submit with stale hash -> Trigger conflict
    const evalRes = await conflictDetector.evaluateChange(
      'agent-frontend-2',
      'src/frontend/services/userService.js',
      file.content + '\n// concurrent change',
      staleHash
    );

    assert.strictEqual(evalRes.hasConflict, true);
    assert.ok(evalRes.conflictRecord?._id);

    // Auto-resolve conflict
    const resolveRes = await conflictResolver.resolve(
      evalRes.conflictRecord._id,
      'SMART_3WAY_MERGE',
      { customContent: file.content + '\n// resolved version' }
    );

    assert.strictEqual(resolveRes.success, true);
    assert.strictEqual(resolveRes.strategy, 'SMART_3WAY_MERGE');

    const updated = sharedContext.getFile('src/frontend/services/userService.js');
    assert.ok(updated.content.includes('// resolved version'));
  });

  // 6. Redis TCP Protocol Server
  const testRedisProtocol = it('RedisServer: TCP RESP protocol commands (PING, SET, GET, KEYS)', async () => {
    const redis = new RedisServer(6399, '127.0.0.1');
    await redis.start();

    const client = new net.Socket();
    await new Promise((resolve) => client.connect(6399, '127.0.0.1', resolve));

    const sendCmd = (cmdStr) => {
      return new Promise((resolve) => {
        client.once('data', (buf) => resolve(buf.toString('utf8')));
        client.write(cmdStr);
      });
    };

    // PING
    const pong = await sendCmd('*1\r\n$4\r\nPING\r\n');
    assert.strictEqual(pong, '+PONG\r\n');

    // SET testkey "hello"
    const setRes = await sendCmd('*3\r\n$3\r\nSET\r\n$7\r\ntestkey\r\n$5\r\nhello\r\n');
    assert.strictEqual(setRes, '+OK\r\n');

    // GET testkey
    const getRes = await sendCmd('*2\r\n$3\r\nGET\r\n$7\r\ntestkey\r\n');
    assert.strictEqual(getRes, '$5\r\nhello\r\n');

    client.destroy();
    await redis.stop();
  });

  // Run all
  await testMongo();
  await testDiff3();
  await testContext();
  await testIntent();
  await testConflictResolution();
  await testRedisProtocol();

  console.log('\n================================================================');
  console.log(` 🏁 TESTS COMPLETE: ${passed} Passed, ${failed} Failed`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
