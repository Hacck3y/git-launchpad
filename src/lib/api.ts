interface DeployRequest {
  repo_url: string;
  env_vars: Record<string, string>;
}

const BASE_URL = "http://157.245.109.239:3000";

export async function deployRepo(req: DeployRequest) {
  const res = await fetch(`${BASE_URL}/api/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getDeployment(deployId: string) {
  const res = await fetch(`${BASE_URL}/api/deploy/${deployId}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function killDeployment(deployId: string) {
  const res = await fetch(`${BASE_URL}/api/deploy/${deployId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}
