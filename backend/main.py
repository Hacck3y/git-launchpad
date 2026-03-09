"""
main.py — FastAPI server handling deploy requests from the frontend.
Includes WebSocket endpoint for real-time log streaming.
"""
import uuid
import asyncio
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, Dict
from deployer import Deployer
from cleanup import CleanupManager

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

import time, docker as _docker_mod

_start_time = time.time()


@app.get("/health")
async def health_check():
    """Health endpoint for uptime monitoring (UptimeRobot, Better Uptime, etc.)."""
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


@app.post("/api/deploy")
async def create_deploy(req: DeployRequest):
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
async def get_deploy(deploy_id: str):
    info = deployer.get_status(deploy_id)
    if not info:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return info


@app.delete("/api/deploy/{deploy_id}")
async def kill_deploy(deploy_id: str):
    success = deployer.kill(deploy_id)
    if not success:
        raise HTTPException(status_code=404, detail="Deployment not found")
    return {"status": "killed", "deploy_id": deploy_id}


@app.websocket("/ws/logs/{deploy_id}")
async def websocket_logs(websocket: WebSocket, deploy_id: str):
    """Stream real-time build + runtime logs via WebSocket."""
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
            # Non-blocking check for new log lines
            try:
                # Use asyncio to poll the queue without blocking the event loop
                line = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: log_queue.get(timeout=1.0)
                )
                await websocket.send_json({"type": "log", "line": line})
            except Exception:
                # Queue.get timeout — check if deployment is done
                status = deployer.get_status(deploy_id)
                if not status:
                    await websocket.send_json({"type": "end", "reason": "deployment_removed"})
                    break
                if status.get("status") in ("live", "error", "killed", "expired"):
                    # Drain remaining logs
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
