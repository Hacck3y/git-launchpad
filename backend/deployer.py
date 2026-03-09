"""
deployer.py — Controls how user repos are deployed inside Docker containers.
Uses docker-py SDK for all container operations (build, run, health check, cleanup).
Accepts AI-generated deploy_config with custom Dockerfile and commands.
Always uses Docker. Writes .env file from user-provided env vars.
Detects stalled/failed builds with timeouts.
Auto-retries with AI-powered error fixing (up to 3 retries).
Supports pnpm/yarn/npm monorepos with workspace dependencies.
Auto-spins companion service containers (MySQL, Redis, Postgres, MongoDB) on a Docker network.
"""
import os
import subprocess
import threading
import tempfile
import time
import json
import socket
import secrets
import urllib.request
import urllib.error
import docker
from docker.errors import BuildError, APIError, ContainerError, ImageNotFound, NotFound
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any, List

# Host IP for constructing preview URLs
HOST_IP = os.getenv("HOST_IP", "157.245.109.239")

# Supabase config for AI fix calls
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://hpmzhxtezgqtslomftwp.supabase.co")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwbXpoeHRlemdxdHNsb21mdHdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5NzYzOTgsImV4cCI6MjA4ODU1MjM5OH0.vKqnuDLlKUcWa5U-xKPem8GQJiieyL08k3sjlu-vgDE")

# Port range for deployments
PORT_START = 10000
PORT_END = 11000
_next_port = PORT_START

# Timeouts (seconds)
CLONE_TIMEOUT = 120
BUILD_TIMEOUT = 900  # 15 min for complex monorepos
HEALTH_CHECK_TIMEOUT = 50  # 10 attempts x 5s

# Max AI fix retries
MAX_FIX_RETRIES = 3

# ─── Companion Service Map ────────────────────────────────────────
SERVICE_MAP = {
    "mongodb": {
        "image": "mongo:6",
        "port": 27017,
        "env": {},
        "inject": {
            "MONGO_URI": "mongodb://mongodb:27017/app",
            "MONGODB_URI": "mongodb://mongodb:27017/app",
            "MONGO_URL": "mongodb://mongodb:27017/app",
        },
        "health_timeout": 20,
    },
    "mysql": {
        "image": "mysql:8",
        "port": 3306,
        "env": {
            "MYSQL_ROOT_PASSWORD": "rootpass",
            "MYSQL_DATABASE": "app",
            "MYSQL_USER": "appuser",
            "MYSQL_PASSWORD": "apppass",
        },
        "inject": {
            "DB_HOST": "mysql",
            "DB_PORT": "3306",
            "DB_USER": "appuser",
            "DB_PASSWORD": "apppass",
            "DB_NAME": "app",
            "MYSQL_URI": "mysql://appuser:apppass@mysql:3306/app",
        },
        "health_cmd": ["mysqladmin", "ping", "-h", "localhost", "-u", "root", "-prootpass"],
        "health_timeout": 40,
    },
    "postgres": {
        "image": "postgres:15",
        "port": 5432,
        "env": {
            "POSTGRES_PASSWORD": "apppass",
            "POSTGRES_DB": "app",
            "POSTGRES_USER": "appuser",
        },
        "inject": {
            "DATABASE_URL": "postgresql://appuser:apppass@postgres:5432/app",
            "DB_HOST": "postgres",
            "DB_USER": "appuser",
            "DB_PASSWORD": "apppass",
            "DB_NAME": "app",
        },
        "health_cmd": ["pg_isready", "-U", "appuser"],
        "health_timeout": 20,
    },
    "redis": {
        "image": "redis:alpine",
        "port": 6379,
        "env": {},
        "inject": {
            "REDIS_URL": "redis://redis:6379",
            "REDIS_HOST": "redis",
            "REDIS_PORT": "6379",
        },
        "health_cmd": ["redis-cli", "ping"],
        "health_timeout": 10,
    },
}

# Env var patterns that indicate a service dependency (used when analyzing env keys from frontend)
SERVICE_DETECT_PATTERNS = {
    "mysql": ["MYSQL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME", "MYSQL_URL", "MYSQL_URI"],
    "postgres": ["POSTGRES", "DATABASE_URL", "PG_", "PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"],
    "redis": ["REDIS_URL", "REDIS_HOST", "REDIS_PORT", "IOREDIS"],
    "mongodb": ["MONGODB_URI", "MONGO_URL", "MONGO_URI", "MONGODB_URL"],
}

# Keywords to scan in package.json / .env files for local detection
SERVICE_FILE_INDICATORS = {
    "mongodb": ["mongoose", "mongodb", "mongo", "mongoclient"],
    "mysql": ["mysql", "mysql2", "sequelize", "knex", "typeorm"],
    "postgres": ["pg", "postgres", "sequelize", "knex", "typeorm", "prisma"],
    "redis": ["redis", "ioredis", "bull", "bullmq"],
}


def _detect_services_from_env(env_keys: List[str]) -> List[str]:
    """Detect which services are needed based on env var keys."""
    detected = set()
    for key in env_keys:
        key_upper = key.upper()
        for service, patterns in SERVICE_DETECT_PATTERNS.items():
            for pattern in patterns:
                if pattern in key_upper:
                    detected.add(service)
                    break
    return list(detected)


def _detect_services_from_files(repo_dir: str) -> List[str]:
    """Detect which services a repo needs by scanning package.json and .env files."""
    content = ""

    # Read package.json
    pkg_path = os.path.join(repo_dir, "package.json")
    if os.path.exists(pkg_path):
        try:
            with open(pkg_path, "r") as f:
                content += f.read().lower()
        except Exception:
            pass

    # Read .env example files
    for env_file in [".env.example", ".env.sample", ".env", ".env.local"]:
        p = os.path.join(repo_dir, env_file)
        if os.path.exists(p):
            try:
                with open(p, "r") as f:
                    content += "\n" + f.read().lower()
            except Exception:
                pass

    # Read requirements.txt for Python projects
    req_path = os.path.join(repo_dir, "requirements.txt")
    if os.path.exists(req_path):
        try:
            with open(req_path, "r") as f:
                content += "\n" + f.read().lower()
        except Exception:
            pass

    needed = []
    for service, keywords in SERVICE_FILE_INDICATORS.items():
        if any(k in content for k in keywords):
            needed.append(service)

    return needed


def _allocate_port() -> int:
    global _next_port
    port = _next_port
    _next_port += 1
    if _next_port > PORT_END:
        _next_port = PORT_START
    return port


DEFAULT_DOCKERFILES = {
    "node": """FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
{env_file_copy}
RUN if grep -q '"build"' package.json; then npm run build; fi
EXPOSE {port}
CMD {start_cmd}
""",
    "pnpm": """FROM node:20-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
{env_file_copy}
RUN pnpm install --no-frozen-lockfile
RUN pnpm run build || true
EXPOSE {port}
CMD {start_cmd}
""",
    "pnpm_workspace": """FROM node:20-slim
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
{env_file_copy}
RUN pnpm install --no-frozen-lockfile
RUN pnpm run build || true
EXPOSE {port}
CMD {start_cmd}
""",
    "yarn": """FROM node:20-slim
WORKDIR /app
COPY . .
{env_file_copy}
RUN yarn install --network-timeout 600000
RUN yarn build || true
EXPOSE {port}
CMD {start_cmd}
""",
    "python": """FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true
COPY . .
{env_file_copy}
EXPOSE {port}
CMD {start_cmd}
""",
    "generic": """FROM ubuntu:22.04
RUN apt-get update && apt-get install -y curl wget git build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
{env_file_copy}
EXPOSE {port}
CMD {start_cmd}
""",
}


def _detect_package_manager(repo_dir: str) -> str:
    """Detect which package manager the project uses."""
    if os.path.exists(os.path.join(repo_dir, "pnpm-lock.yaml")):
        return "pnpm"
    if os.path.exists(os.path.join(repo_dir, "yarn.lock")):
        return "yarn"
    if os.path.exists(os.path.join(repo_dir, "bun.lockb")) or os.path.exists(os.path.join(repo_dir, "bun.lock")):
        return "bun"
    return "npm"


def _is_monorepo(repo_dir: str) -> bool:
    """Check if the project is a monorepo with workspaces."""
    if os.path.exists(os.path.join(repo_dir, "pnpm-workspace.yaml")):
        return True
    pkg_path = os.path.join(repo_dir, "package.json")
    if os.path.exists(pkg_path):
        try:
            with open(pkg_path, "r") as f:
                pkg = json.load(f)
            if "workspaces" in pkg:
                return True
        except Exception:
            pass
    return False


def _call_ai_fix(error_log: str, dockerfile_content: str, repo_files: List[str],
                  language: str, framework: str, start_cmd: str, port: int, attempt: int,
                  package_manager: str = "npm", is_monorepo: bool = False) -> Optional[Dict]:
    """Call the fix-deploy-error edge function to get AI-powered fixes."""
    try:
        url = f"{SUPABASE_URL}/functions/v1/fix-deploy-error"
        payload = json.dumps({
            "error_log": error_log[:4000],
            "dockerfile_content": dockerfile_content,
            "repo_files": repo_files[:150],
            "language": language or "unknown",
            "framework": framework or "unknown",
            "start_cmd": start_cmd or "unknown",
            "port": port,
            "attempt": attempt,
            "package_manager": package_manager,
            "is_monorepo": is_monorepo,
        }).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception as e:
        print(f"[AI FIX] Failed to call AI fix endpoint: {e}")
        return None


class Deployer:
    def __init__(self):
        self.deployments: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._log_subscribers: Dict[str, List[Any]] = {}  # deploy_id -> list of queues
        # Initialize docker-py client from local socket
        self.docker = docker.from_env()
        print(f"[DOCKER] Connected to Docker daemon: {self.docker.version().get('Version', 'unknown')}")

    def subscribe_logs(self, deploy_id: str):
        """Subscribe to real-time logs for a deployment. Returns a queue."""
        import queue
        q = queue.Queue()
        with self._lock:
            self._log_subscribers.setdefault(deploy_id, []).append(q)
            # Send existing build_logs as catch-up
            info = self.deployments.get(deploy_id, {})
            for line in info.get("build_logs", []):
                q.put(line)
        return q

    def unsubscribe_logs(self, deploy_id: str, q):
        """Remove a subscriber queue."""
        with self._lock:
            subs = self._log_subscribers.get(deploy_id, [])
            if q in subs:
                subs.remove(q)

    def _emit_log(self, deploy_id: str, line: str):
        """Send a log line to all subscribers and store it."""
        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id].setdefault("build_logs", []).append(line)
            for q in self._log_subscribers.get(deploy_id, []):
                try:
                    q.put_nowait(line)
                except Exception:
                    pass

    # ─── Companion Service Management ────────────────────────────────

    def _create_network(self, deploy_id: str) -> str:
        """Create an isolated Docker network for this deployment."""
        network_name = f"gitpreview_{deploy_id}_net"
        try:
            network = self.docker.networks.create(network_name, driver="bridge")
            self._emit_log(deploy_id, f"▶ Created network: {network_name}")
            print(f"[DOCKER] Created network: {network_name}")
            return network_name
        except APIError as e:
            # Network might already exist
            print(f"[DOCKER] Network create error (may exist): {e}")
            return network_name

    def _cleanup_network(self, network_name: str):
        """Remove a Docker network."""
        try:
            network = self.docker.networks.get(network_name)
            network.remove()
            print(f"[DOCKER] Removed network: {network_name}")
        except NotFound:
            pass
        except Exception as e:
            print(f"[DOCKER] Failed to remove network {network_name}: {e}")

    def _start_companion_services(self, deploy_id: str, network_name: str,
                                   needed_services: List[str]) -> Dict[str, Dict[str, Any]]:
        """Start companion service containers on the deployment network.
        Returns a dict of {service_name: {hostname, port, container_name, inject_env}}."""
        service_info = {}

        for svc_name in needed_services:
            svc_config = SERVICE_MAP.get(svc_name)
            if not svc_config:
                continue

            container_name = f"gitpreview_{deploy_id}_{svc_name}"
            hostname = svc_name  # Docker network alias

            # Use static env from SERVICE_MAP (deterministic credentials)
            env = dict(svc_config.get("env", {}))

            try:
                self._emit_log(deploy_id, f"▶ Starting {svc_name} ({svc_config['image']})...")

                container = self.docker.containers.run(
                    image=svc_config["image"],
                    name=container_name,
                    detach=True,
                    network=network_name,
                    mem_limit="256m",
                    nano_cpus=int(0.5e9),  # 0.5 CPU
                    environment=env,
                    remove=False,
                )

                # Set network alias so app can reach it by service name
                try:
                    network = self.docker.networks.get(network_name)
                    network.disconnect(container)
                    network.connect(container, aliases=[svc_name])
                except Exception:
                    pass  # Already connected with alias during run

                # Inject env vars are static — copy directly from SERVICE_MAP
                inject_env = dict(svc_config.get("inject", {}))

                service_info[svc_name] = {
                    "hostname": hostname,
                    "port": svc_config["port"],
                    "container_name": container_name,
                    "container_id": container.id,
                    "inject_env": inject_env,
                    "image": svc_config["image"],
                    "credentials": env,  # pass back the env used (passwords etc.)
                }

                self._emit_log(deploy_id, f"  ✓ {svc_name} container started")
                print(f"[DOCKER] Started companion: {container_name} ({svc_config['image']})")

            except Exception as e:
                self._emit_log(deploy_id, f"✗ Failed to start {svc_name}: {str(e)[:200]}")
                print(f"[DOCKER] Failed to start companion {svc_name}: {e}")

        return service_info

    def _wait_for_companion_services(self, deploy_id: str, service_info: Dict[str, Dict[str, Any]],
                                      network_name: str):
        """Wait for all companion services to be fully ready before starting the app.
        Uses TCP connection checks and container health commands."""
        if not service_info:
            return

        self._emit_log(deploy_id, "▶ Waiting for services to be ready...")

        for svc_name, svc_data in service_info.items():
            svc_config = SERVICE_MAP.get(svc_name, {})
            container_name = svc_data["container_name"]
            svc_port = svc_data["port"]
            health_timeout = svc_config.get("health_timeout", 30)
            health_cmd = svc_config.get("health_cmd")

            self._emit_log(deploy_id, f"  ⏳ Waiting for {svc_name} (max {health_timeout}s)...")
            ready = False
            start_time = time.time()

            while time.time() - start_time < health_timeout:
                try:
                    container = self.docker.containers.get(container_name)
                    container.reload()

                    if container.status in ("exited", "dead"):
                        logs = container.logs(tail=20).decode("utf-8", errors="replace")
                        self._emit_log(deploy_id, f"  ✗ {svc_name} exited unexpectedly:\n{logs[-500:]}")
                        break

                    if container.status != "running":
                        time.sleep(1)
                        continue

                    # Try health command first (more reliable than TCP for initialization)
                    if health_cmd:
                        exit_code, output = container.exec_run(health_cmd)
                        if exit_code == 0:
                            ready = True
                            break
                    else:
                        # No health check command — use TCP probe via exec
                        # We can't TCP from host to container by name, so use exec
                        tcp_check_cmd = ["sh", "-c", f"(echo > /dev/tcp/localhost/{svc_port}) 2>/dev/null"]
                        exit_code, _ = container.exec_run(tcp_check_cmd)
                        if exit_code == 0:
                            ready = True
                            break

                except NotFound:
                    self._emit_log(deploy_id, f"  ✗ {svc_name} container disappeared")
                    break
                except Exception as e:
                    print(f"[HEALTH] {svc_name} check error: {e}")

                time.sleep(2)

            if ready:
                elapsed = round(time.time() - start_time, 1)
                self._emit_log(deploy_id, f"  ✓ {svc_name} ready ({elapsed}s)")
            else:
                self._emit_log(deploy_id, f"  ⚠ {svc_name} may not be fully ready after {health_timeout}s (proceeding anyway)")


    def _cleanup_companion_services(self, deploy_id: str):
        """Stop and remove all companion service containers for a deployment."""
        for svc_name in SERVICE_MAP:
            container_name = f"gitpreview_{deploy_id}_{svc_name}"
            self._cleanup_container(container_name)

        network_name = f"gitpreview_{deploy_id}_net"
        self._cleanup_network(network_name)

    # ─── Deploy lifecycle ────────────────────────────────────────────

    def start_deploy(
        self,
        deploy_id: str,
        repo_url: str,
        env_vars: Dict[str, str],
        deploy_config: Optional[Dict[str, Any]] = None,
    ):
        port = _allocate_port()
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=20)

        with self._lock:
            self.deployments[deploy_id] = {
                "deploy_id": deploy_id,
                "status": "cloning",
                "repo_url": repo_url,
                "port": port,
                "container_id": None,
                "preview_url": None,
                "error": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "expires_at": expires_at.isoformat(),
                "deploy_config": deploy_config,
                "ai_fix_attempts": 0,
                "ai_fix_log": [],
                "build_logs": [],
                "companion_services": {},  # filled later
            }

        thread = threading.Thread(
            target=self._run_deploy,
            args=(deploy_id, repo_url, env_vars, port, deploy_config),
            daemon=True,
        )
        thread.start()

    def _update_status(self, deploy_id: str, status: str, **kwargs):
        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id]["status"] = status
                self.deployments[deploy_id].update(kwargs)

    def _add_fix_log(self, deploy_id: str, message: str):
        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id].setdefault("ai_fix_log", []).append(message)

    def _write_env_file(self, repo_dir: str, env_vars: Dict[str, str]):
        if not env_vars:
            return
        env_path = os.path.join(repo_dir, ".env")
        with open(env_path, "w") as f:
            for key, value in env_vars.items():
                escaped = value.replace('"', '\\"')
                f.write(f'{key}="{escaped}"\n')

    def _get_repo_files(self, repo_dir: str) -> List[str]:
        """List files in the repo directory."""
        files = []
        for root, _, filenames in os.walk(repo_dir):
            for fn in filenames:
                rel = os.path.relpath(os.path.join(root, fn), repo_dir)
                if not rel.startswith(".git/") and not rel.startswith("node_modules/"):
                    files.append(rel)
        return files[:200]

    def _read_dockerfile(self, repo_dir: str) -> str:
        dockerfile_path = os.path.join(repo_dir, "Dockerfile")
        if os.path.exists(dockerfile_path):
            with open(dockerfile_path, "r") as f:
                return f.read()
        return ""

    def _read_package_json(self, repo_dir: str) -> Dict:
        """Read and parse package.json."""
        pkg_path = os.path.join(repo_dir, "package.json")
        if os.path.exists(pkg_path):
            try:
                with open(pkg_path, "r") as f:
                    return json.load(f)
            except Exception:
                pass
        return {}

    # ─── Health checks ───────────────────────────────────────────────

    def _check_port_open(self, port: int, timeout: float = 2.0) -> bool:
        """Check if a port is actually accepting TCP connections."""
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=timeout):
                return True
        except (ConnectionRefusedError, OSError, socket.timeout):
            return False

    def _check_http_health(self, port: int, timeout: float = 3.0) -> bool:
        """Try an HTTP GET to the port — accept any response (even 404/500) as 'alive'."""
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/", method="GET")
            with urllib.request.urlopen(req, timeout=timeout):
                return True
        except urllib.error.HTTPError:
            return True  # 404, 500 etc. — server IS responding
        except Exception:
            return False

    def _get_container_logs(self, container_name: str, tail: int = 80) -> str:
        """Get recent container logs via docker-py."""
        try:
            container = self.docker.containers.get(container_name)
            logs = container.logs(tail=tail, timestamps=False)
            return logs.decode("utf-8", errors="replace")[-2000:]
        except Exception as e:
            return f"Failed to fetch logs: {e}"

    def _check_container_health(self, container_name: str, app_port: int = None) -> tuple:
        """Verify container is running AND port is actually accepting connections."""
        for attempt in range(10):  # up to 50s total
            time.sleep(5)
            try:
                container = self.docker.containers.get(container_name)
                container.reload()  # refresh state from daemon
                state = container.status  # "running", "exited", "created", etc.

                if state == "exited" or state == "dead":
                    error_log = self._get_container_logs(container_name, tail=50)
                    exit_code = container.attrs.get("State", {}).get("ExitCode", "?")
                    return False, f"Container exited with code {exit_code}:\n{error_log}"

                if state != "running":
                    print(f"[HEALTH] Container state: {state} (attempt {attempt+1})")
                    continue

                # Container is running — check port
                if app_port and self._check_port_open(app_port):
                    self._check_http_health(app_port)
                    return True, ""

                if app_port:
                    print(f"[HEALTH] Container running but port {app_port} not open yet (attempt {attempt+1})")
                    continue
                else:
                    return True, ""

            except NotFound:
                return False, "Container not found — may have been removed"
            except Exception as e:
                print(f"[HEALTH] Check error: {e}")
                continue

        # Timed out
        if app_port:
            error_log = self._get_container_logs(container_name, tail=80)
            return False, f"PORT_NOT_OPEN: Container is running but port {app_port} never started accepting connections.\n{error_log}"
        return False, "Container health check timed out"

    # ─── Container lifecycle ─────────────────────────────────────────

    def _cleanup_container(self, container_name: str):
        """Force remove a container by name."""
        try:
            container = self.docker.containers.get(container_name)
            container.remove(force=True)
            print(f"[DOCKER] Removed container: {container_name}")
        except NotFound:
            pass  # Already gone
        except Exception as e:
            print(f"[DOCKER] Failed to remove container {container_name}: {e}")

    def _cleanup_image(self, image_name: str):
        """Force remove an image by name."""
        try:
            self.docker.images.remove(image_name, force=True)
            print(f"[DOCKER] Removed image: {image_name}")
        except ImageNotFound:
            pass
        except Exception as e:
            print(f"[DOCKER] Failed to remove image {image_name}: {e}")

    def _build_image(self, deploy_id: str, tmp_dir: str, image_name: str) -> tuple:
        """Build a Docker image using docker-py with real-time log streaming. Returns (success, error_log)."""
        try:
            self._emit_log(deploy_id, f"▶ Building image {image_name}...")
            # Use low-level API for streaming build output
            resp = self.docker.api.build(
                path=tmp_dir,
                tag=image_name,
                rm=True,
                forcerm=True,
                timeout=BUILD_TIMEOUT,
                decode=True,  # Auto-decode JSON chunks
            )
            for chunk in resp:
                if "stream" in chunk:
                    line = chunk["stream"].rstrip("\n")
                    if line.strip():
                        self._emit_log(deploy_id, line)
                        print(f"[BUILD] {line}")
                elif "error" in chunk:
                    error_msg = chunk["error"].strip()
                    self._emit_log(deploy_id, f"✗ {error_msg}")
                    return False, f"BUILD_ERROR: {error_msg}"

            self._emit_log(deploy_id, "✓ Image built successfully")
            print(f"[DOCKER] Image built successfully: {image_name}")
            return True, ""
        except BuildError as e:
            error_lines = []
            for chunk in e.build_log:
                if "error" in chunk:
                    error_lines.append(chunk["error"])
                elif "stream" in chunk:
                    error_lines.append(chunk["stream"])
            error_log = "".join(error_lines)[-2000:]
            self._emit_log(deploy_id, f"✗ Build failed")
            return False, f"BUILD_ERROR: {error_log}"
        except APIError as e:
            self._emit_log(deploy_id, f"✗ Docker API error: {str(e)[:200]}")
            return False, f"BUILD_ERROR: Docker API error: {str(e)[:1000]}"
        except Exception as e:
            self._emit_log(deploy_id, f"✗ Build error: {str(e)[:200]}")
            return False, f"BUILD_ERROR: {str(e)[:1000]}"

    def _run_container(self, deploy_id: str, image_name: str, container_name: str,
                       env_vars: Dict[str, str], app_port: int,
                       network_name: str = None) -> tuple:
        """Run a container using docker-py. Returns (container_id, error_log).
        If network_name is given, uses bridge network with port mapping instead of host network."""
        env = {**env_vars, "PORT": str(app_port), "HOST": "0.0.0.0"}

        try:
            self._emit_log(deploy_id, f"▶ Starting container on port {app_port}...")

            if network_name:
                # Use bridge network with companion services
                host_port = _allocate_port()
                container = self.docker.containers.run(
                    image=image_name,
                    name=container_name,
                    detach=True,
                    network=network_name,
                    ports={f"{app_port}/tcp": host_port},
                    mem_limit="512m",
                    nano_cpus=int(1e9),  # 1.0 CPU
                    environment=env,
                    remove=False,
                )
                # Store the host port mapping
                with self._lock:
                    if deploy_id in self.deployments:
                        self.deployments[deploy_id]["host_port"] = host_port
            else:
                # No companion services — use host network (original behavior)
                container = self.docker.containers.run(
                    image=image_name,
                    name=container_name,
                    detach=True,
                    network_mode="host",
                    mem_limit="512m",
                    nano_cpus=int(1e9),  # 1.0 CPU
                    environment=env,
                    remove=False,
                )

            self._emit_log(deploy_id, f"✓ Container started: {container.short_id}")

            # Start background thread to stream container stdout/stderr
            self._start_runtime_log_stream(deploy_id, container_name)

            return container.id, ""
        except ContainerError as e:
            self._emit_log(deploy_id, f"✗ Container error: {str(e)[:200]}")
            return None, f"RUN_ERROR: Container exited with error: {str(e)[:1000]}"
        except APIError as e:
            self._emit_log(deploy_id, f"✗ Docker API error: {str(e)[:200]}")
            return None, f"RUN_ERROR: Docker API error: {str(e)[:1000]}"
        except Exception as e:
            self._emit_log(deploy_id, f"✗ Run error: {str(e)[:200]}")
            return None, f"RUN_ERROR: {str(e)[:1000]}"

    def _start_runtime_log_stream(self, deploy_id: str, container_name: str):
        """Stream runtime logs from a running container in a background thread."""
        def _stream():
            try:
                container = self.docker.containers.get(container_name)
                for line in container.logs(stream=True, follow=True, timestamps=False):
                    text = line.decode("utf-8", errors="replace").rstrip("\n")
                    if text.strip():
                        self._emit_log(deploy_id, f"  {text}")
                    # Stop if deployment is no longer live
                    with self._lock:
                        info = self.deployments.get(deploy_id, {})
                        if info.get("status") in ("killed", "error", "expired"):
                            break
            except NotFound:
                pass
            except Exception as e:
                print(f"[LOG STREAM] Error for {deploy_id}: {e}")

        t = threading.Thread(target=_stream, daemon=True)
        t.start()

    def _build_and_run(self, deploy_id: str, tmp_dir: str, env_vars: Dict[str, str],
                        port: int, app_port: int, attempt: int,
                        network_name: str = None) -> tuple:
        """Build Docker image and run container. Returns (success, error_log)."""
        container_name = f"deploy-{deploy_id}"
        image_name = f"deploy-{deploy_id}:latest"

        # Clean up any previous attempts
        if attempt > 0:
            self._cleanup_container(container_name)
            self._cleanup_image(image_name)

        # Build
        self._update_status(deploy_id, "installing" if attempt == 0 else "ai_fixing")
        success, error_log = self._build_image(deploy_id, tmp_dir, image_name)
        if not success:
            return False, error_log

        self._update_status(deploy_id, "building" if attempt == 0 else "ai_fixing")
        time.sleep(1)

        # Run
        self._update_status(deploy_id, "starting" if attempt == 0 else "ai_retrying")
        container_id, error_log = self._run_container(
            deploy_id, image_name, container_name, env_vars, app_port,
            network_name=network_name,
        )
        if not container_id:
            return False, error_log

        # Determine the port to health-check
        if network_name:
            # With bridge network, check the mapped host port
            with self._lock:
                check_port = self.deployments.get(deploy_id, {}).get("host_port", app_port)
        else:
            check_port = app_port

        # Health check — verify container AND port are actually alive
        alive, error_log = self._check_container_health(container_name, app_port=check_port)
        if not alive:
            self._cleanup_container(container_name)
            return False, f"CRASH_ERROR: {error_log}"

        # Success!
        preview_url = f"http://{HOST_IP}:{check_port}"
        self._update_status(
            deploy_id, "live",
            container_id=container_id,
            preview_url=preview_url,
        )
        return True, ""

    def _apply_ai_fix(self, deploy_id: str, tmp_dir: str, env_vars: Dict[str, str],
                       fix_config: Dict, attempt: int):
        """Apply fixes suggested by AI."""
        diagnosis = fix_config.get("diagnosis", "Unknown issue")
        self._add_fix_log(deploy_id, f"[Attempt {attempt}] AI diagnosis: {diagnosis}")

        # Apply pre-build commands
        pre_cmds = fix_config.get("pre_build_commands", [])
        for cmd in pre_cmds:
            self._add_fix_log(deploy_id, f"Running: {cmd}")
            try:
                subprocess.run(
                    cmd, shell=True, cwd=tmp_dir,
                    capture_output=True, timeout=60,
                )
            except Exception as e:
                self._add_fix_log(deploy_id, f"Pre-build cmd failed: {e}")

        # Write fixed Dockerfile
        fixed_dockerfile = fix_config.get("fixed_dockerfile")
        if fixed_dockerfile:
            dockerfile_path = os.path.join(tmp_dir, "Dockerfile")
            with open(dockerfile_path, "w") as f:
                f.write(fixed_dockerfile)
            self._add_fix_log(deploy_id, "Wrote fixed Dockerfile")

        # Add any missing env vars
        env_additions = fix_config.get("env_file_additions", {})
        if env_additions:
            env_path = os.path.join(tmp_dir, ".env")
            with open(env_path, "a") as f:
                for key, value in env_additions.items():
                    if key not in env_vars:
                        f.write(f'{key}="{value}"\n')
                        env_vars[key] = value
            self._add_fix_log(deploy_id, f"Added {len(env_additions)} env var(s)")

        # Update port/start_cmd if AI suggests different ones
        new_port = fix_config.get("port")
        new_cmd = fix_config.get("start_cmd")
        return new_port, new_cmd

    def _run_deploy(
        self,
        deploy_id: str,
        repo_url: str,
        env_vars: Dict[str, str],
        port: int,
        deploy_config: Optional[Dict[str, Any]],
    ):
        tmp_dir = None
        network_name = None
        try:
            # --- Step 1: Clone ---
            self._update_status(deploy_id, "cloning")
            tmp_dir = tempfile.mkdtemp(prefix=f"deploy-{deploy_id}-")
            subprocess.run(
                ["git", "clone", "--depth", "1", repo_url, tmp_dir],
                check=True, capture_output=True, timeout=CLONE_TIMEOUT,
            )

            # Write .env file
            self._write_env_file(tmp_dir, env_vars)

            # --- Step 2: Detect project type ---
            self._update_status(deploy_id, "detecting")
            package_manager = _detect_package_manager(tmp_dir)
            monorepo = _is_monorepo(tmp_dir)
            pkg_json = self._read_package_json(tmp_dir)

            dockerfile_content = None
            app_port = 3000

            if deploy_config:
                dockerfile_content = deploy_config.get("dockerfile_content")
                app_port = deploy_config.get("port", 3000)

            # --- Detect and start companion services ---
            env_keys = list(env_vars.keys())
            # Also check deploy_config detected_services if provided
            detected_services = []
            if deploy_config and deploy_config.get("detected_services"):
                detected_services = deploy_config["detected_services"]
            else:
                detected_services = _detect_services_from_env(env_keys)

            companion_info = {}
            if detected_services:
                self._update_status(deploy_id, "services")
                self._emit_log(deploy_id, f"▶ Detected service dependencies: {', '.join(detected_services)}")
                network_name = self._create_network(deploy_id)

                companion_info = self._start_companion_services(deploy_id, network_name, detected_services)

                # Wait for all services to be fully initialized before starting the app
                self._wait_for_companion_services(deploy_id, companion_info, network_name)

                # Inject companion env vars into the app's env
                for svc_name, svc_data in companion_info.items():
                    for env_key, env_val in svc_data.get("inject_env", {}).items():
                        # Only inject if user hasn't manually set this var
                        if env_key not in env_vars or not env_vars[env_key]:
                            env_vars[env_key] = env_val
                            self._emit_log(deploy_id, f"  → Injected {env_key}")

                # Re-write .env file with injected vars
                self._write_env_file(tmp_dir, env_vars)

                # Store companion info in deployment state (sanitized for frontend)
                with self._lock:
                    if deploy_id in self.deployments:
                        self.deployments[deploy_id]["companion_services"] = {
                            name: {
                                "service": name,
                                "image": data["image"],
                                "hostname": data["hostname"],
                                "port": data["port"],
                                "password": data.get("password"),
                                "inject_env": data.get("inject_env", {}),
                                "container_name": data["container_name"],
                            }
                            for name, data in companion_info.items()
                        }

            # For pnpm monorepos, override the AI-generated Dockerfile with our proven template
            if package_manager == "pnpm" and monorepo and (not dockerfile_content or "npm install" in (dockerfile_content or "")):
                start_cmd_str = deploy_config.get("start_cmd", "pnpm start") if deploy_config else "pnpm start"
                env_file_copy = "COPY .env .env" if env_vars else ""
                def format_cmd(cmd: str) -> str:
                    parts = cmd.split()
                    return "[" + ", ".join(f'"{p}"' for p in parts) + "]"
                dockerfile_content = DEFAULT_DOCKERFILES["pnpm_workspace"].format(
                    port=app_port, start_cmd=format_cmd(start_cmd_str), env_file_copy=env_file_copy,
                )
                self._add_fix_log(deploy_id, f"Detected pnpm monorepo — using workspace-aware Dockerfile")
            elif package_manager == "pnpm" and not dockerfile_content:
                start_cmd_str = deploy_config.get("start_cmd", "pnpm start") if deploy_config else "pnpm start"
                env_file_copy = "COPY .env .env" if env_vars else ""
                def format_cmd(cmd: str) -> str:
                    parts = cmd.split()
                    return "[" + ", ".join(f'"{p}"' for p in parts) + "]"
                dockerfile_content = DEFAULT_DOCKERFILES["pnpm"].format(
                    port=app_port, start_cmd=format_cmd(start_cmd_str), env_file_copy=env_file_copy,
                )

            if not dockerfile_content:
                dockerfile_content = self._detect_dockerfile(tmp_dir, deploy_config, bool(env_vars))

            # Write Dockerfile
            dockerfile_path = os.path.join(tmp_dir, "Dockerfile")
            if dockerfile_content and (not os.path.exists(dockerfile_path) or deploy_config):
                with open(dockerfile_path, "w") as f:
                    f.write(dockerfile_content)

            if not os.path.exists(dockerfile_path):
                with open(dockerfile_path, "w") as f:
                    fallback = DEFAULT_DOCKERFILES["generic"].format(
                        port=app_port, start_cmd='["bash"]', env_file_copy=""
                    )
                    f.write(fallback)

            # --- Step 3+4: Build & Run (with AI retry loop) ---
            repo_files = self._get_repo_files(tmp_dir)
            language = deploy_config.get("language", "") if deploy_config else ""
            framework = deploy_config.get("framework", "") if deploy_config else ""
            start_cmd = deploy_config.get("start_cmd", "") if deploy_config else ""

            for attempt in range(MAX_FIX_RETRIES + 1):
                success, error_log = self._build_and_run(
                    deploy_id, tmp_dir, env_vars, port, app_port, attempt,
                    network_name=network_name,
                )

                if success:
                    return  # Deployed successfully!

                # If this was the last attempt, give up
                if attempt >= MAX_FIX_RETRIES:
                    self._update_status(deploy_id, "error", error=error_log[:500])
                    self._add_fix_log(deploy_id, f"Gave up after {attempt + 1} attempt(s)")
                    return

                # --- AI Fix attempt ---
                self._update_status(deploy_id, "ai_fixing")
                self._add_fix_log(deploy_id, f"Build/run failed, asking AI to fix (attempt {attempt + 1})...")

                current_dockerfile = self._read_dockerfile(tmp_dir)
                fix_config = _call_ai_fix(
                    error_log=error_log,
                    dockerfile_content=current_dockerfile,
                    repo_files=repo_files,
                    language=language,
                    framework=framework,
                    start_cmd=start_cmd,
                    port=app_port,
                    attempt=attempt + 1,
                    package_manager=package_manager,
                    is_monorepo=monorepo,
                )

                if not fix_config or "error" in fix_config:
                    err_msg = fix_config.get("error", "AI fix service unavailable") if fix_config else "AI fix service unavailable"
                    self._add_fix_log(deploy_id, f"AI fix failed: {err_msg}")
                    self._update_status(deploy_id, "error", error=f"{error_log[:300]}\n\nAI fix unavailable: {err_msg}")
                    return

                # Apply the fix
                new_port, new_cmd = self._apply_ai_fix(deploy_id, tmp_dir, env_vars, fix_config, attempt + 1)
                if new_port:
                    app_port = new_port
                if new_cmd:
                    start_cmd = new_cmd

                with self._lock:
                    if deploy_id in self.deployments:
                        self.deployments[deploy_id]["ai_fix_attempts"] = attempt + 1

                self._add_fix_log(deploy_id, f"Retrying build with AI fixes...")

        except subprocess.TimeoutExpired:
            self._update_status(deploy_id, "error", error="Build timed out (exceeded 15 minute limit)")
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            self._update_status(deploy_id, "error", error=error_msg[:500])
        except Exception as e:
            self._update_status(deploy_id, "error", error=str(e)[:500])

    def _detect_dockerfile(self, repo_dir: str, deploy_config: Optional[Dict] = None, has_env: bool = False) -> str:
        port = deploy_config.get("port", 3000) if deploy_config else 3000
        start_cmd = None

        if deploy_config and deploy_config.get("start_cmd"):
            start_cmd = deploy_config["start_cmd"]

        env_file_copy = "COPY .env .env" if has_env else ""

        def format_cmd(cmd: str) -> str:
            parts = cmd.split()
            return "[" + ", ".join(f'"{p}"' for p in parts) + "]"

        pkg_manager = _detect_package_manager(repo_dir)

        if os.path.exists(os.path.join(repo_dir, "package.json")):
            if pkg_manager == "pnpm":
                cmd = start_cmd or "pnpm start"
                template = "pnpm_workspace" if _is_monorepo(repo_dir) else "pnpm"
                return DEFAULT_DOCKERFILES[template].format(
                    port=port, start_cmd=format_cmd(cmd), env_file_copy=env_file_copy,
                )
            elif pkg_manager == "yarn":
                cmd = start_cmd or "yarn start"
                return DEFAULT_DOCKERFILES["yarn"].format(
                    port=port, start_cmd=format_cmd(cmd), env_file_copy=env_file_copy,
                )
            else:
                cmd = start_cmd or "npm start"
                return DEFAULT_DOCKERFILES["node"].format(
                    port=port, start_cmd=format_cmd(cmd), env_file_copy=env_file_copy,
                )

        if os.path.exists(os.path.join(repo_dir, "requirements.txt")):
            cmd = start_cmd or "python app.py"
            return DEFAULT_DOCKERFILES["python"].format(
                port=port, start_cmd=format_cmd(cmd), env_file_copy=env_file_copy,
            )

        cmd = start_cmd or "bash"
        return DEFAULT_DOCKERFILES["generic"].format(
            port=port, start_cmd=format_cmd(cmd), env_file_copy=env_file_copy,
        )

    def get_status(self, deploy_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.deployments.get(deploy_id)

    def kill(self, deploy_id: str) -> bool:
        with self._lock:
            info = self.deployments.get(deploy_id)
            if not info:
                return False

        # Kill main app container
        container_name = f"deploy-{deploy_id}"
        self._cleanup_container(container_name)

        # Kill companion service containers and network
        self._cleanup_companion_services(deploy_id)

        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id]["status"] = "killed"

        return True

    def get_all_deployments(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return dict(self.deployments)
