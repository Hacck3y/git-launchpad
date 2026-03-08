interface DeployRequest {
  repo_url: string;
  env_vars: Record<string, string>;
}

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || "";

function apiUrl(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

async function parseResponse(res: Response) {
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const message = data?.detail || data?.error || `HTTP ${res.status}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}

export async function deployRepo(req: DeployRequest) {
  const res = await fetch(apiUrl("/api/deploy"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  return parseResponse(res);
}

export async function getDeployment(deployId: string) {
  const res = await fetch(apiUrl(`/api/deploy/${deployId}`));
  return parseResponse(res);
}

export async function killDeployment(deployId: string) {
  const res = await fetch(apiUrl(`/api/deploy/${deployId}`), {
    method: "DELETE",
  });
  return parseResponse(res);
}
