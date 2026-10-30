"""
Example Python Agent connecting to MongoRedis AgentMesh.
Works with either the HTTP REST/SSE endpoints or standard redis-py!
"""

import json
import urllib.request
import urllib.parse
import sys
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

SERVER_URL = "http://127.0.0.1:8080"
AGENT_ID = "python-backend-agent"
MACHINE_ID = "ubuntu-compute-cluster-01"
ROLE = "backend"

def post_json(path, data):
    url = f"{SERVER_URL}{path}"
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def get_json(path):
    url = f"{SERVER_URL}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def main():
    print("=" * 60)
    print(" [Python Agent] Connecting to MongoRedis AgentMesh")
    print("=" * 60)

    # 1. Register
    reg_resp = post_json("/api/agents/register", {
        "agentId": AGENT_ID,
        "role": ROLE,
        "machineId": MACHINE_ID,
        "metadata": {"engine": "Python 3.14", "framework": "AgentMesh-Py"}
    })
    print(f"[OK] Registered: {reg_resp.get('success')}")

    # 2. Query Shared Context Pool
    context = get_json("/api/context")
    print(f"[Context] {len(context['agents'])} agents online, {len(context['files'])} files tracked.")

    # 3. Acquire Intent Lease to avoid conflicts
    file_path = "src/backend/routes/userRoutes.js"
    print(f"[Lock] Requesting intent lease for '{file_path}'...")
    intent_resp = post_json("/api/intent/acquire", {
        "agentId": AGENT_ID,
        "role": ROLE,
        "machineId": MACHINE_ID,
        "filePath": file_path,
        "description": "Python agent adding user status filter endpoint"
    })
    print(f"[Lock] Intent response: {intent_resp.get('action')}")

    # 4. Fetch canonical file
    file_doc = get_json(f"/api/files/content?path={urllib.parse.quote(file_path)}")
    print(f"[File] Current canonical hash: {file_doc['hash']} (v{file_doc['version']})")

    # 5. Release lease
    post_json("/api/intent/release", {
        "agentId": AGENT_ID,
        "filePath": file_path
    })
    print("[Lock] Lease released successfully.")

if __name__ == "__main__":
    main()
