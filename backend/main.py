"""
main.py — FastAPI server handling deploy requests from the frontend.
Includes WebSocket endpoint for real-time log streaming and rate limiting.
"""
import uuid
import asyncio
import time
import json
import os
from collections import defaultdict
from pathlib import Path
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, Dict, Set
from deployer import Deployer
from cleanup import CleanupManager
import docker as _docker_mod

BLOCKLIST_FILE = Path(__file__).parent / "blocked_ips.json"


# ─── IP Blocklist ─────────────────────────────────────────────────
class IPBlocklist:
    """Persistent IP blocklist backed by a JSON file."""

    def __init__(self, path: Path = BLOCKLIST_FILE):
        self._path = path
        self._blocked: Dict[str, dict] = {}  # ip -> {reason, blocked_at}
        self._load()

    def _load(self):
        if self._path.exists():
            try:
                self._blocked = json.loads(self._path.read_text())
            except (json.JSONDecodeError, OSError):
                self._blocked = {}

    def _save(self):
        try:
            self._path.write_text(json.dumps(self._blocked, indent=2))
        except OSError:
            pass

    def is_blocked(self, ip: str) -> bool:
        return ip in self._blocked

    def block(self, ip: str, reason: str = "manual") -> None:
        self._blocked[ip] = {"reason": reason, "blocked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self._save()

    def unblock(self, ip: str) -> bool:
        if ip in self._blocked:
            del self._blocked[ip]
            self._save()
            return True
        return False

    def list_all(self) -> Dict[str, dict]:
        return dict(self._blocked)


ip_blocklist = IPBlocklist()


# ─── Rate Limiter ─────────────────────────────────────────────────
class RateLimiter:
    """In-memory sliding-window rate limiter per IP with auto-ban support."""

    def __init__(self, auto_ban_threshold: int = 50, auto_ban_window: int = 60):
        self._hits: Dict[str, list[float]] = defaultdict(list)
        self._violations: Dict[str, list[float]] = defaultdict(list)
        self._auto_ban_threshold = auto_ban_threshold
        self._auto_ban_window = auto_ban_window

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> bool:
        now = time.time()
        cutoff = now - window_seconds
        self._hits[key] = [t for t in self._hits[key] if t > cutoff]
        if len(self._hits[key]) >= max_requests:
            # Track violation for auto-ban
            ip = key.split(":", 1)[-1] if ":" in key else key
            self._record_violation(ip)
            return False
        self._hits[key].append(now)
        return True

    def _record_violation(self, ip: str):
        now = time.time()
        cutoff = now - self._auto_ban_window
        self._violations[ip] = [t for t in self._violations[ip] if t > cutoff]
        self._violations[ip].append(now)
        if len(self._violations[ip]) >= self._auto_ban_threshold:
            ip_blocklist.block(ip, reason="auto-banned: excessive rate limit violations")
            self._violations.pop(ip, None)

    def remaining(self, key: str, max_requests: int, window_seconds: int) -> int:
        now = time.time()
        cutoff = now - window_seconds
        recent = [t for t in self._hits[key] if t > cutoff]
        return max(0, max_requests - len(recent))

    def cleanup(self, max_age: int = 300):
        now = time.time()
        for store in (self._hits, self._violations):
            stale = [k for k, v in store.items() if not v or v[-1] < now - max_age]
            for k in stale:
                del store[k]


rate_limiter = RateLimiter()

# Rate limit tiers (max_requests, window_seconds)
RATE_LIMITS = {
    "deploy":  (5, 60),      # 5 deploys per minute per IP
    "status":  (60, 60),     # 60 status checks per minute
    "delete":  (10, 60),     # 10 deletes per minute
    "health":  (30, 60),     # 30 health checks per minute
    "ws":      (10, 60),     # 10 WebSocket connections per minute
}


def get_client_ip(request: Request) -> str:
    """Extract client IP, respecting X-Forwarded-For from reverse proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate_limit(request: Request, tier: str) -> None:
    """Raise 429 if rate limit exceeded."""
    ip = get_client_ip(request)
    max_req, window = RATE_LIMITS[tier]
    if not rate_limiter.is_allowed(f"{tier}:{ip}", max_req, window):
        remaining = 0
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded. Max {max_req} requests per {window}s. Try again later.",
            headers={
                "Retry-After": str(window),
                "X-RateLimit-Limit": str(max_req),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(window),
            },
        )


# ─── App Setup ────────────────────────────────────────────────────
app = FastAPI(title="Git Launchpad API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

deployer = Deployer()
cleanup_manager = CleanupManager(deployer)
cleanup_manager.start()

_start_time = time.time()


# Periodic cleanup of stale rate limiter entries (every 5 min)
async def _rate_limiter_cleanup():
    while True:
        await asyncio.sleep(300)
        rate_limiter.cleanup()


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(_rate_limiter_cleanup())


# ─── Health ───────────────────────────────────────────────────────
@app.get("/health")
async def health_check(request: Request):
    """Health endpoint for uptime monitoring (UptimeRobot, Better Uptime, etc.)."""
    check_rate_limit(request, "health")
    uptime = time.time() - _start_time
    active = deployer.get_all_deployments() if hasattr(deployer, "get_all_deployments") else {}
    docker_ok = False
    try:
        _docker_mod.from_env().ping()
        docker_ok = True
    except Exception:
        pass
    return {
        "status": "healthy" if docker_ok else "degraded",
        "uptime_seconds": round(uptime, 1),
        "docker": "connected" if docker_ok else "unavailable",
        "active_deployments": len(active) if isinstance(active, (dict, list)) else 0,
    }


# ─── Models ───────────────────────────────────────────────────────
class DeployConfig(BaseModel):
    language: Optional[str] = None
    framework: Optional[str] = None
    install_cmd: Optional[str] = None
    build_cmd: Optional[str] = None
    start_cmd: Optional[str] = None
    port: Optional[int] = 3000
    dockerfile_content: Optional[str] = None


class DeployRequest(BaseModel):
    repo_url: str
    env_vars: Dict[str, str] = {}
    deploy_config: Optional[DeployConfig] = None


# ─── Deploy Endpoints ─────────────────────────────────────────────
@app.post("/api/deploy")
async def create_deploy(req: DeployRequest, request: Request):
    check_rate_limit(request, "deploy")
    deploy_id = str(uuid.uuid4())[:8]
    try:
        deployer.start_deploy(
            deploy_id=deploy_id,
            repo_url=req.repo_url,
            env_vars=req.env_vars,
            deploy_config=req.deploy_config.dict() if req.deploy_config else None,
        )
        return {"deploy_id": deploy_id, "status": "cloning"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/deploy/{deploy_id}")
async def get_deploy(deploy_id: str, request: Request):
    check_rate_limit(request, "status")
    info = deployer.get_status(deploy_id)
    if not info:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return info


@app.delete("/api/deploy/{deploy_id}")
async def kill_deploy(deploy_id: str, request: Request):
    check_rate_limit(request, "delete")
    success = deployer.kill(deploy_id)
    if not success:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return {"status": "killed", "deploy_id": deploy_id}


# ─── WebSocket Logs ───────────────────────────────────────────────
@app.websocket("/ws/logs/{deploy_id}")
async def websocket_logs(websocket: WebSocket, deploy_id: str):
    """Stream real-time build + runtime logs via WebSocket."""
    # Rate limit WebSocket connections
    ip = websocket.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not ip and websocket.client:
        ip = websocket.client.host
    max_req, window = RATE_LIMITS["ws"]
    if not rate_limiter.is_allowed(f"ws:{ip}", max_req, window):
        await websocket.close(code=1008, reason="Rate limit exceeded")
        return

    await websocket.accept()

    # Check deployment exists
    info = deployer.get_status(deploy_id)
    if not info:
        await websocket.send_json({"type": "error", "message": "Deployment not found"})
        await websocket.close()
        return

    # Subscribe to log stream
    log_queue = deployer.subscribe_logs(deploy_id)

    try:
        while True:
            try:
                line = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: log_queue.get(timeout=1.0)
                )
                await websocket.send_json({"type": "log", "line": line})
            except Exception:
                status = deployer.get_status(deploy_id)
                if not status:
                    await websocket.send_json({"type": "end", "reason": "deployment_removed"})
                    break
                if status.get("status") in ("live", "error", "killed", "expired"):
                    while not log_queue.empty():
                        try:
                            line = log_queue.get_nowait()
                            await websocket.send_json({"type": "log", "line": line})
                        except Exception:
                            break
                    await websocket.send_json({
                        "type": "end",
                        "reason": status.get("status"),
                        "preview_url": status.get("preview_url"),
                    })
                    break
    except WebSocketDisconnect:
        pass
    finally:
        deployer.unsubscribe_logs(deploy_id, log_queue)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
