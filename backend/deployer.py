"""
deployer.py — Controls how user repos are deployed inside Docker containers.
Accepts AI-generated deploy_config with custom Dockerfile and commands.
Always uses Docker. Writes .env file from user-provided env vars.
Detects stalled/failed builds with timeouts.
"""
import os
import subprocess
import threading
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

# Host IP for constructing preview URLs
HOST_IP = os.getenv("HOST_IP", "157.245.109.239")

# Port range for deployments
PORT_START = 10000
PORT_END = 11000
_next_port = PORT_START

# Timeouts (seconds)
CLONE_TIMEOUT = 120
BUILD_TIMEOUT = 600   # 10 min max for docker build
RUN_TIMEOUT = 30
HEALTH_CHECK_TIMEOUT = 30  # wait up to 30s for container to stay alive


def _allocate_port() -> int:
    global _next_port
    port = _next_port
    _next_port += 1
    if _next_port > PORT_END:
        _next_port = PORT_START
    return port


# Default Dockerfiles when AI doesn't provide one
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


class Deployer:
    def __init__(self):
        self.deployments: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def start_deploy(
        self,
        deploy_id: str,
        repo_url: str,
        env_vars: Dict[str, str],
        deploy_config: Optional[Dict[str, Any]] = None,
    ):
        """Start a deployment in a background thread."""
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

    def _write_env_file(self, repo_dir: str, env_vars: Dict[str, str]):
        """Write user-provided env vars as a .env file inside the cloned repo."""
        if not env_vars:
            return
        env_path = os.path.join(repo_dir, ".env")
        with open(env_path, "w") as f:
            for key, value in env_vars.items():
                # Escape quotes in values
                escaped = value.replace('"', '\\"')
                f.write(f'{key}="{escaped}"\n')

    def _check_container_health(self, container_name: str) -> tuple[bool, str]:
        """Check if the container is still running after startup. Returns (alive, error_log)."""
        for attempt in range(6):  # check every 5s for 30s total
            time.sleep(5)
            try:
                result = subprocess.run(
                    ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
                    capture_output=True, timeout=10,
                )
                state = result.stdout.decode().strip()
                if state == "true":
                    return True, ""
                elif state == "false":
                    # Container exited — grab logs
                    logs = subprocess.run(
                        ["docker", "logs", "--tail", "50", container_name],
                        capture_output=True, timeout=10,
                    )
                    error_log = logs.stderr.decode() or logs.stdout.decode()
                    return False, error_log[:500]
            except Exception:
                continue
        return False, "Container health check timed out"

    def _run_deploy(
        self,
        deploy_id: str,
        repo_url: str,
        env_vars: Dict[str, str],
        port: int,
        deploy_config: Optional[Dict[str, Any]],
    ):
        tmp_dir = None
        try:
            # --- Step 1: Clone ---
            self._update_status(deploy_id, "cloning")
            tmp_dir = tempfile.mkdtemp(prefix=f"deploy-{deploy_id}-")
            result = subprocess.run(
                ["git", "clone", "--depth", "1", repo_url, tmp_dir],
                check=True,
                capture_output=True,
                timeout=CLONE_TIMEOUT,
            )

            # --- Step 1.5: Write .env file from user-provided vars ---
            self._write_env_file(tmp_dir, env_vars)

            # --- Step 2: Detect / use AI config ---
            self._update_status(deploy_id, "detecting")
            dockerfile_content = None
            app_port = 3000

            if deploy_config:
                dockerfile_content = deploy_config.get("dockerfile_content")
                app_port = deploy_config.get("port", 3000)

            if not dockerfile_content:
                dockerfile_content = self._detect_dockerfile(tmp_dir, deploy_config, bool(env_vars))

            # Always write Dockerfile (overwrite if AI-generated is better)
            dockerfile_path = os.path.join(tmp_dir, "Dockerfile")
            if dockerfile_content and (not os.path.exists(dockerfile_path) or deploy_config):
                with open(dockerfile_path, "w") as f:
                    f.write(dockerfile_content)

            # If STILL no Dockerfile (shouldn't happen), create generic one
            if not os.path.exists(dockerfile_path):
                with open(dockerfile_path, "w") as f:
                    f.write(DEFAULT_DOCKERFILES["generic"].format(
                        port=app_port,
                        start_cmd='["bash"]',
                        env_file_copy="",
                    ))

            # --- Step 3: Build ---
            self._update_status(deploy_id, "installing")
            container_name = f"deploy-{deploy_id}"
            image_name = f"deploy-{deploy_id}:latest"

            build_result = subprocess.run(
                ["docker", "build", "-t", image_name, tmp_dir],
                capture_output=True,
                timeout=BUILD_TIMEOUT,
            )

            if build_result.returncode != 0:
                error_output = build_result.stderr.decode()[-500:]
                self._update_status(deploy_id, "error", error=f"Docker build failed:\n{error_output}")
                return

            self._update_status(deploy_id, "building")
            time.sleep(1)

            # --- Step 4: Run ---
            self._update_status(deploy_id, "starting")

            # Pass env vars both as -e flags AND as .env file (belt and suspenders)
            env_flags = []
            for k, v in env_vars.items():
                env_flags.extend(["-e", f"{k}={v}"])

            run_result = subprocess.run(
                [
                    "docker", "run", "-d",
                    "--name", container_name,
                    "-p", f"{port}:{app_port}",
                    "--memory", "256m",
                    "--cpus", "0.5",
                    *env_flags,
                    image_name,
                ],
                capture_output=True,
                timeout=RUN_TIMEOUT,
            )

            if run_result.returncode != 0:
                error_output = run_result.stderr.decode()[-500:]
                self._update_status(deploy_id, "error", error=f"Container failed to start:\n{error_output}")
                return

            container_id = run_result.stdout.decode().strip()

            # --- Step 5: Health check — wait and verify container stays alive ---
            alive, error_log = self._check_container_health(container_name)
            if not alive:
                self._update_status(
                    deploy_id, "error",
                    container_id=container_id,
                    error=f"Container crashed after starting:\n{error_log}",
                )
                # Clean up crashed container
                try:
                    subprocess.run(["docker", "rm", "-f", container_name], capture_output=True, timeout=15)
                except Exception:
                    pass
                return

            preview_url = f"http://{HOST_IP}:{port}"
            self._update_status(
                deploy_id,
                "live",
                container_id=container_id,
                preview_url=preview_url,
            )

        except subprocess.TimeoutExpired:
            self._update_status(deploy_id, "error", error="Build timed out (exceeded 10 minute limit)")
        except subprocess.CalledProcessError as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            self._update_status(deploy_id, "error", error=error_msg[:500])
        except Exception as e:
            self._update_status(deploy_id, "error", error=str(e)[:500])

    def _detect_dockerfile(self, repo_dir: str, deploy_config: Optional[Dict] = None, has_env: bool = False) -> str:
        """Generate a Dockerfile based on detected files or AI config."""
        port = deploy_config.get("port", 3000) if deploy_config else 3000
        start_cmd = None

        if deploy_config and deploy_config.get("start_cmd"):
            start_cmd = deploy_config["start_cmd"]

        env_file_copy = "COPY .env .env" if has_env else ""

        def format_cmd(cmd: str) -> str:
            parts = cmd.split()
            return "[" + ", ".join(f'"{p}"' for p in parts) + "]"

        # Check for package.json (Node.js)
        if os.path.exists(os.path.join(repo_dir, "package.json")):
            cmd = start_cmd or "npm start"
            return DEFAULT_DOCKERFILES["node"].format(
                port=port,
                start_cmd=format_cmd(cmd),
                env_file_copy=env_file_copy,
            )

        # Check for requirements.txt (Python)
        if os.path.exists(os.path.join(repo_dir, "requirements.txt")):
            cmd = start_cmd or "python app.py"
            return DEFAULT_DOCKERFILES["python"].format(
                port=port,
                start_cmd=format_cmd(cmd),
                env_file_copy=env_file_copy,
            )

        # Generic fallback — always runs in Docker
        cmd = start_cmd or "bash"
        return DEFAULT_DOCKERFILES["generic"].format(
            port=port,
            start_cmd=format_cmd(cmd),
            env_file_copy=env_file_copy,
        )

    def get_status(self, deploy_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.deployments.get(deploy_id)

    def kill(self, deploy_id: str) -> bool:
        with self._lock:
            info = self.deployments.get(deploy_id)
            if not info:
                return False

        container_name = f"deploy-{deploy_id}"

        try:
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                capture_output=True,
                timeout=15,
            )
        except Exception:
            pass

        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id]["status"] = "killed"

        return True

    def get_all_deployments(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return dict(self.deployments)
