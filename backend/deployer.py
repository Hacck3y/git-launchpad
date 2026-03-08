"""
deployer.py — Controls how user repos are deployed inside Docker containers.
Accepts AI-generated deploy_config with custom Dockerfile and commands.
Always uses Docker. Writes .env file from user-provided env vars.
Detects stalled/failed builds with timeouts.
Auto-retries with AI-powered error fixing (up to 2 retries).
"""
import os
import subprocess
import threading
import tempfile
import time
import json
import urllib.request
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
BUILD_TIMEOUT = 600
RUN_TIMEOUT = 30
HEALTH_CHECK_TIMEOUT = 30

# Max AI fix retries
MAX_FIX_RETRIES = 2


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


def _call_ai_fix(error_log: str, dockerfile_content: str, repo_files: List[str],
                  language: str, framework: str, start_cmd: str, port: int, attempt: int) -> Optional[Dict]:
    """Call the fix-deploy-error edge function to get AI-powered fixes."""
    try:
        url = f"{SUPABASE_URL}/functions/v1/fix-deploy-error"
        payload = json.dumps({
            "error_log": error_log[:3000],
            "dockerfile_content": dockerfile_content,
            "repo_files": repo_files[:100],
            "language": language or "unknown",
            "framework": framework or "unknown",
            "start_cmd": start_cmd or "unknown",
            "port": port,
            "attempt": attempt,
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
            return data
    except Exception as e:
        print(f"[AI FIX] Failed to call AI fix endpoint: {e}")
        return None


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

    def _check_container_health(self, container_name: str) -> tuple:
        for attempt in range(6):
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
                    logs = subprocess.run(
                        ["docker", "logs", "--tail", "50", container_name],
                        capture_output=True, timeout=10,
                    )
                    error_log = logs.stderr.decode() or logs.stdout.decode()
                    return False, error_log[:1000]
            except Exception:
                continue
        return False, "Container health check timed out"

    def _cleanup_container(self, container_name: str):
        try:
            subprocess.run(["docker", "rm", "-f", container_name], capture_output=True, timeout=15)
        except Exception:
            pass

    def _cleanup_image(self, image_name: str):
        try:
            subprocess.run(["docker", "rmi", "-f", image_name], capture_output=True, timeout=15)
        except Exception:
            pass

    def _build_and_run(self, deploy_id: str, tmp_dir: str, env_vars: Dict[str, str],
                        port: int, app_port: int, attempt: int) -> tuple:
        """Build Docker image and run container. Returns (success, error_log)."""
        container_name = f"deploy-{deploy_id}"
        image_name = f"deploy-{deploy_id}:latest"

        # Clean up any previous attempts
        if attempt > 0:
            self._cleanup_container(container_name)
            self._cleanup_image(image_name)

        # Build
        self._update_status(deploy_id, "installing" if attempt == 0 else "ai_fixing")
        build_result = subprocess.run(
            ["docker", "build", "-t", image_name, tmp_dir],
            capture_output=True,
            timeout=BUILD_TIMEOUT,
        )

        if build_result.returncode != 0:
            error_output = build_result.stderr.decode()[-1000:]
            return False, f"BUILD_ERROR: {error_output}"

        self._update_status(deploy_id, "building" if attempt == 0 else "ai_fixing")
        time.sleep(1)

        # Run
        self._update_status(deploy_id, "starting" if attempt == 0 else "ai_retrying")
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
            error_output = run_result.stderr.decode()[-1000:]
            return False, f"RUN_ERROR: {error_output}"

        container_id = run_result.stdout.decode().strip()

        # Health check
        alive, error_log = self._check_container_health(container_name)
        if not alive:
            self._cleanup_container(container_name)
            return False, f"CRASH_ERROR: {error_log}"

        # Success!
        preview_url = f"http://{HOST_IP}:{port}"
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

            # --- Step 2: Detect / use AI config ---
            self._update_status(deploy_id, "detecting")
            dockerfile_content = None
            app_port = 3000

            if deploy_config:
                dockerfile_content = deploy_config.get("dockerfile_content")
                app_port = deploy_config.get("port", 3000)

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
                    deploy_id, tmp_dir, env_vars, port, app_port, attempt
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
            self._update_status(deploy_id, "error", error="Build timed out (exceeded 10 minute limit)")
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

        if os.path.exists(os.path.join(repo_dir, "package.json")):
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

        container_name = f"deploy-{deploy_id}"
        self._cleanup_container(container_name)

        with self._lock:
            if deploy_id in self.deployments:
                self.deployments[deploy_id]["status"] = "killed"

        return True

    def get_all_deployments(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return dict(self.deployments)
