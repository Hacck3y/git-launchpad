export interface DeployConfig {
  language: string;
  framework: string;
  install_cmd: string;
  build_cmd: string;
  start_cmd: string;
  port: number;
  dockerfile_content: string;
}

interface DeployRequest {
  repo_url: string;
  env_vars: Record<string, string>;
  deploy_config?: DeployConfig;
  ttl_minutes?: number;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://157.245.109.239";

export async function analyzeRepo(repoUrl: string): Promise<{
  repo: {
    name: string;
    fullName: string;
    description: string;
    language: string;
    stars: number;
    defaultBranch: string;
  };
  deploy_config: DeployConfig;
  detected_stack: string[];
  files_analyzed: string[];
  required_env_vars: string[];
  env_vars: Array<{
    key: string;
    value: string;
    needs_user_input: boolean;
    description: string;
  }>;
}> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/functions/v1/analyze-repo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify({ repo_url: repoUrl }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error || `Analysis failed: HTTP ${res.status}`);
  }
  return res.json();
}

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
