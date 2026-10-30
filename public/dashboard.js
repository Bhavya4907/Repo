/**
 * MongoRedis AgentMesh - Live Dashboard Client
 */

let state = {
  agents: [],
  files: [],
  activeIntents: [],
  contracts: [],
  conflicts: [],
  selectedFile: null
};

// Elements
const elStatAgents = document.getElementById('stat-agents');
const elStatFiles = document.getElementById('stat-files');
const elStatIntents = document.getElementById('stat-intents');
const elStatConflicts = document.getElementById('stat-conflicts');
const elAgentsList = document.getElementById('agents-list');
const elIntentsList = document.getElementById('intents-list');
const elConflictsContainer = document.getElementById('conflicts-container');
const elConflictBadge = document.getElementById('conflict-badge');
const elFilesList = document.getElementById('files-list');
const elContractsList = document.getElementById('contracts-list');
const elCodePreview = document.getElementById('code-preview');
const elPreviewFilename = document.getElementById('preview-filename');
const elPreviewHash = document.getElementById('preview-hash');
const elEventLog = document.getElementById('event-log');
const elTerminalOutput = document.getElementById('terminal-output');
const elRedisForm = document.getElementById('redis-form');
const elRedisInput = document.getElementById('redis-input');
const elBtnSim = document.getElementById('btn-trigger-sim');
const elWsStatus = document.getElementById('ws-status');

// Init
window.addEventListener('DOMContentLoaded', () => {
  loadContext();
  loadConflicts();
  connectEventStream();
  setupRedisConsole();
  setupSimulationButton();
});

async function loadContext() {
  try {
    const res = await fetch('/api/context');
    const data = await res.json();
    state.agents = data.agents || [];
    state.files = data.files || [];
    state.activeIntents = data.activeIntents || [];
    state.contracts = data.contracts || [];
    render();
  } catch (err) {
    logEvent('Error fetching context: ' + err.message);
  }
}

async function loadConflicts() {
  try {
    const res = await fetch('/api/conflicts');
    const conflicts = await res.json();
    state.conflicts = conflicts || [];
    renderConflicts();
  } catch (_) {}
}

function render() {
  // Update Stats
  elStatAgents.textContent = state.agents.length;
  elStatFiles.textContent = state.files.length;
  elStatIntents.textContent = state.activeIntents.length;
  elStatConflicts.textContent = state.conflicts.length;

  document.getElementById('agent-count-badge').textContent = `${state.agents.length} active`;

  // Render Agents
  if (state.agents.length === 0) {
    elAgentsList.innerHTML = `<div class="empty-state">No agents registered yet.</div>`;
  } else {
    elAgentsList.innerHTML = state.agents.map(a => {
      const isFrontend = (a.role || '').toLowerCase().includes('front');
      const badgeClass = isFrontend ? 'badge-frontend' : 'badge-backend';
      return `
        <div class="agent-item">
          <div class="agent-header">
            <span class="agent-name">🤖 ${escapeHtml(a.agentId)}</span>
            <span class="badge ${badgeClass}">${escapeHtml(a.role)}</span>
          </div>
          <div class="agent-machine">💻 ${escapeHtml(a.machineId || 'localhost')}</div>
          <div class="agent-meta">${escapeHtml(a.metadata?.focus || 'Distributed Agent')}</div>
        </div>
      `;
    }).join('');
  }

  // Render Active Intents
  if (state.activeIntents.length === 0) {
    elIntentsList.innerHTML = `<div class="empty-state">No active intent locks. Files are free to edit.</div>`;
  } else {
    elIntentsList.innerHTML = state.activeIntents.map(i => `
      <div class="intent-row">
        <div>
          <div class="intent-file">📄 ${escapeHtml(i.filePath)}</div>
          <div class="intent-desc">${escapeHtml(i.description)}</div>
        </div>
        <div class="text-right">
          <div class="intent-holder">Held by: <strong>${escapeHtml(i.agentId)}</strong></div>
          <span class="badge badge-backend">Lock Active</span>
        </div>
      </div>
    `).join('');
  }

  // Render Files
  elFilesList.innerHTML = state.files.map(f => `
    <button class="file-pill ${state.selectedFile === f.path ? 'active' : ''}" onclick="selectFile('${escapeHtml(f.path)}')">
      📄 ${escapeHtml(f.path)}
    </button>
  `).join('');

  if (state.selectedFile) {
    fetchFileContent(state.selectedFile);
  } else if (state.files.length > 0) {
    selectFile(state.files[0].path);
  }

  // Render Contracts
  elContractsList.innerHTML = state.contracts.map(c => `
    <div class="contract-item">
      <div>
        <div class="contract-endpoint">${escapeHtml(c.endpoint)}</div>
        <div class="contract-layers">Producer: ${escapeHtml(c.producerFile)}</div>
      </div>
      <span class="badge badge-frontend">${c.consumerFiles?.length || 0} Consumers</span>
    </div>
  `).join('');

  renderConflicts();
}

function renderConflicts() {
  elStatConflicts.textContent = state.conflicts.length;
  elConflictBadge.textContent = `${state.conflicts.length} Pending`;

  if (state.conflicts.length === 0) {
    elConflictsContainer.innerHTML = `
      <div class="empty-state success">
        ✅ All code changes harmonized! Common context pool is conflict-free.
      </div>
    `;
    return;
  }

  elConflictsContainer.innerHTML = state.conflicts.map(c => `
    <div class="conflict-card">
      <div class="conflict-header">
        <div>
          <span class="conflict-title">⚠️ Conflict on ${escapeHtml(c.filePath)}</span>
          <div class="text-muted" style="font-size:0.8rem; margin-top:4px;">
            Conflicting Agents: <strong>${c.conflictingAgents.join(' ↔ ')}</strong>
          </div>
        </div>
        <span class="badge badge-alert">${escapeHtml(c.type)}</span>
      </div>
      <div style="font-size:0.85rem; margin-bottom:8px;">
        Base Revision Hash: <code>${escapeHtml(c.baseHash)}</code> ↔ Server Canonical: <code>${escapeHtml(c.currentCanonicalHash)}</code>
      </div>
      <div class="conflict-actions">
        <button class="btn btn-sm btn-primary" onclick="resolveConflict('${c._id}', 'SMART_3WAY_MERGE')">
          ⚡ Auto 3-Way Merge
        </button>
        <button class="btn btn-sm btn-outline" onclick="resolveConflict('${c._id}', 'ACCEPT_PROPOSED')">
          Accept Proposed
        </button>
        <button class="btn btn-sm btn-outline" onclick="resolveConflict('${c._id}', 'REVERT_TO_CANONICAL')">
          Revert to Canonical
        </button>
      </div>
    </div>
  `).join('');
}

window.selectFile = async function(filePath) {
  state.selectedFile = filePath;
  document.querySelectorAll('.file-pill').forEach(el => {
    el.classList.toggle('active', el.textContent.includes(filePath));
  });
  await fetchFileContent(filePath);
};

async function fetchFileContent(filePath) {
  try {
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(filePath)}`);
    const doc = await res.json();
    elPreviewFilename.textContent = doc.path;
    elPreviewHash.textContent = `v${doc.version} [${doc.hash}]`;
    elCodePreview.textContent = doc.content;
  } catch (_) {}
}

window.resolveConflict = async function(conflictId, strategy) {
  try {
    const res = await fetch('/api/conflicts/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conflictId, strategy, resolvedBy: 'dashboard-admin' })
    });
    const result = await res.json();
    logEvent(`Resolved conflict ${conflictId} via ${strategy}`);
    await loadContext();
    await loadConflicts();
  } catch (err) {
    alert('Resolution error: ' + err.message);
  }
};

function connectEventStream() {
  const eventSource = new EventSource('/events');

  eventSource.onopen = () => {
    elWsStatus.innerHTML = '<span class="indicator live"></span> SSE/WS Live';
  };

  eventSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      const data = payload.data || payload;
      logEvent(`[${payload.channel || 'mesh'}] ${data.type || 'EVENT'}: ${JSON.stringify(data).slice(0, 100)}`);

      // Refresh on state changes
      if (['FILE_CHANGED', 'INTENT_ACQUIRED', 'INTENT_RELEASED', 'AGENT_REGISTERED', 'CONFLICT_ALERT', 'CONFLICT_RESOLVED'].includes(data.type)) {
        loadContext();
        loadConflicts();
      }
    } catch (_) {}
  };

  eventSource.onerror = () => {
    elWsStatus.innerHTML = '<span class="indicator"></span> Reconnecting...';
  };
}

function logEvent(msg) {
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="log-time">[${time}]</span> ${escapeHtml(msg)}`;
  elEventLog.prepend(entry);
}

function setupRedisConsole() {
  elRedisForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cmd = elRedisInput.value.trim();
    if (!cmd) return;

    appendTermLine(`redis> ${cmd}`, 'term-cmd');
    elRedisInput.value = '';

    try {
      const res = await fetch('/api/redis/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const data = await res.json();
      appendTermLine(JSON.stringify(data.result, null, 2), 'term-res');
    } catch (err) {
      appendTermLine(`ERR: ${err.message}`, 'term-err');
    }
  });
}

function appendTermLine(text, className = '') {
  const div = document.createElement('div');
  div.className = `term-line ${className}`;
  div.textContent = text;
  elTerminalOutput.appendChild(div);
  elTerminalOutput.scrollTop = elTerminalOutput.scrollHeight;
}

function setupSimulationButton() {
  elBtnSim.addEventListener('click', async () => {
    elBtnSim.disabled = true;
    elBtnSim.textContent = '⏳ Running simulation...';
    logEvent('Triggered 4-Agent cross-machine simulation...');

    try {
      // Simulate frontend and backend operations
      // Register demo agents
      await fetch('/api/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-frontend-alpha', role: 'frontend', machineId: 'macbook-pro.lan' })
      });
      await fetch('/api/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-frontend-beta', role: 'frontend', machineId: 'thinkpad-x1.vpn' })
      });
      await fetch('/api/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-backend-gamma', role: 'backend', machineId: 'aws-ec2-01' })
      });
      await fetch('/api/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent-backend-delta', role: 'backend', machineId: 'gcp-compute-02' })
      });

      // Acquire intent
      await fetch('/api/intent/acquire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'agent-backend-gamma',
          filePath: 'src/backend/routes/userRoutes.js',
          description: 'Adding avatar field to users'
        })
      });

      await loadContext();
      logEvent('Simulation phase complete! 4 agents active.');
    } catch (err) {
      logEvent('Simulation error: ' + err.message);
    } finally {
      elBtnSim.disabled = false;
      elBtnSim.textContent = '🚀 Run 4-Agent Simulation';
    }
  });

  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    elEventLog.innerHTML = '';
  });
  document.getElementById('btn-refresh-intents').addEventListener('click', loadContext);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
