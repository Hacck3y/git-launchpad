"""
deployer.py — Controls how user repos are deployed inside Docker containers.
Now accepts AI-generated deploy_config with custom Dockerfile and commands.
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
RUN if grep -q '"build"' package.json; then npm run build; fi
EXPOSE {port}
CMD {start_cmd}
""",
    "python": """FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt* ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true
COPY . .
EXPOSE {port}
CMD {start_cmd}
""",
}


class Deployer:
    def __init__(self):
        # deploy_id -> deployment info dict
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
                check=True,
                capture_output=True,
                timeout=120,
            )

            # --- Step 2: Detect / use AI config ---
            self._update_status(deploy_id, "detecting")
            dockerfile_content = None
            app_port = port

            if deploy_config:
                # Use AI-generated config
                dockerfile_content = deploy_config.get("dockerfile_content")
                app_port = deploy_config.get("port", 3000)
            
            if not dockerfile_content:
                # Fallback: detect from files
                dockerfile_content = self._detect_dockerfile(tmp_dir, deploy_config)

            # Write Dockerfile if repo doesn't have one
            dockerfile_path = os.path.join(tmp_dir, "Dockerfile")
            if not os.path.exists(dockerfile_path) and dockerfile_content:
                with open(dockerfile_path, "w") as f:
                    f.write(dockerfile_content)

            # --- Step 3: Build ---
            self._update_status(deploy_id, "installing")
            container_name = f"deploy-{deploy_id}"
            image_name = f"deploy-{deploy_id}:latest"

            subprocess.run(
                ["docker", "build", "-t", image_name, tmp_dir],
                check=True,
                capture_output=True,
                timeout=300,
            )

            self._update_status(deploy_id, "building")
            time.sleep(1)  # brief pause between stages

            # --- Step 4: Run ---
            self._update_status(deploy_id, "starting")

            env_flags = []
            for k, v in env_vars.items():
                env_flags.extend(["-e", f"{k}={v}"])

            result = subprocess.run(
                [
                    "docker", "run", "-d",
                    "--name", container_name,
                    "-p", f"{port}:{app_port}",
                    "--memory", "256m",
                    "--cpus", "0.5",
                    *env_flags,
                    image_name,
                ],
                check=True,
                capture_output=True,
                timeout=30,
            )
            container_id = result.stdout.decode().strip()

            # Wait for container to be healthy
            time.sleep(3)

            preview_url = f"http://{HOST_IP}:{port}"
            self._update_status(
                deploy_id,
                "live",
                container_id=container_id,
                preview_url=preview_url,
            )

        except subprocess.CalledProcessError as e:
            error_msg = e.stderr.decode() if e.stderr else str(e)
            self._update_status(deploy_id, "error", error=error_msg[:500])
        except Exception as e:
            self._update_status(deploy_id, "error", error=str(e)[:500])

    def _detect_dockerfile(self, repo_dir: str, deploy_config: Optional[Dict] = None) -> str:
        """Generate a Dockerfile based on detected files or AI config."""
        port = deploy_config.get("port", 3000) if deploy_config else 3000
        start_cmd = None

        if deploy_config and deploy_config.get("start_cmd"):
            start_cmd = deploy_config["start_cmd"]

        # Check for package.json (Node.js)
        if os.path.exists(os.path.join(repo_dir, "package.json")):
            cmd = start_cmd or "npm start"
            return DEFAULT_DOCKERFILES["node"].format(
                port=port,
                start_cmd=f'["{cmd.split()[0]}", "{" ".join(cmd.split()[1:])}"]' if " " in cmd else f'["{cmd}"]',
            )

        # Check for requirements.txt (Python)
        if os.path.exists(os.path.join(repo_dir, "requirements.txt")):
            cmd = start_cmd or "python app.py"
            return DEFAULT_DOCKERFILES["python"].format(
                port=port,
                start_cmd=f'["{cmd.split()[0]}", "{" ".join(cmd.split()[1:])}"]' if " " in cmd else f'["{cmd}"]',
            )

        # Generic fallback
        return f"""FROM ubuntu:22.04
WORKDIR /app
COPY . .
EXPOSE {port}
CMD ["bash"]
"""

    def get_status(self, deploy_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self.deployments.get(deploy_id)

    def kill(self, deploy_id: str) -> bool:
        with self._lock:
            info = self.deployments.get(deploy_id)
            if not info:
                return False

        container_id = info.get("container_id")
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
