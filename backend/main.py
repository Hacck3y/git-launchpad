"""
main.py — FastAPI server handling deploy requests from the frontend.
"""
import uuid
from fastapi import FastAPI, HTTPException
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
