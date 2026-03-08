"""
cleanup.py — Cleans up expired Docker containers based on user plan.
- Free plan: 20 minutes
- Premium plan: 1 hour
- Elite plan: unlimited
Runs a background cleanup loop every 60 seconds.
"""
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from deployer import Deployer

# Plan durations in seconds
PLAN_DURATIONS = {
    "free": 20 * 60,       # 20 minutes
    "premium": 60 * 60,    # 1 hour
    "elite": None,         # unlimited (no auto-cleanup)
}


class CleanupManager:
    def __init__(self, deployer: "Deployer", interval: int = 60):
        self.deployer = deployer
        self.interval = interval
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def start(self):
        """Start the cleanup loop in a background thread."""
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the cleanup loop."""
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)

    def _loop(self):
        while not self._stop_event.is_set():
            try:
                self._cleanup()
            except Exception as e:
                print(f"[cleanup] Error during cleanup: {e}")
            time.sleep(self.interval)

    def _cleanup(self):
        """Check all deployments and kill expired ones."""
        now = datetime.now(timezone.utc)
        deployments = self.deployer.get_all_deployments()

        for deploy_id, info in deployments.items():
            status = info.get("status")

            # Only clean up live/running containers
            if status not in ("live", "running", "ready"):
                continue

            # Check expiration
            expires_at_str = info.get("expires_at")
            if not expires_at_str:
                continue

            try:
                expires_at = datetime.fromisoformat(expires_at_str)
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue

            if now >= expires_at:
                print(f"[cleanup] Killing expired deployment: {deploy_id}")
                self.deployer.kill(deploy_id)

    @staticmethod
    def get_expiry_minutes(plan: str = "free") -> int | None:
        """Get the expiry duration in minutes for a given plan."""
        seconds = PLAN_DURATIONS.get(plan, PLAN_DURATIONS["free"])
        return seconds // 60 if seconds else None
