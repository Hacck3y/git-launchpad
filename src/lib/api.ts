export interface DeployConfig {
  language: string;
  framework: string;
  install_cmd: string;
  build_cmd: string;
  start_cmd: string;
  port: number;
  dockerfile_content: string;
  detected_services?: string[];
}

interface DeployRequest {
  repo_url: string;
  env_vars: Record<string, string>;
  deploy_config?: DeployConfig;
  ttl_minutes?: number;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://157.245.109.239";
const WS_BASE_URL = BASE_URL.replace(/^https?:\/\//, (m: string) => m.startsWith("https") ? "wss://" : "ws://");

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
    platform_provided?: boolean;
    platform_service?: string;
    platform_display_name?: string;
    platform_running?: boolean;
  }>;
  detected_services?: string[];
  platform_services?: Array<{
    service_type: string;
    display_name: string;
    is_running: boolean;
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

// ─── WebSocket log streaming ─────────────────────────────────────

export interface LogMessage {
  type: "log" | "end" | "error";
  line?: string;
  reason?: string;
  message?: string;
  preview_url?: string;
}

export function connectLogStream(
  deployId: string,
  onLog: (line: string) => void,
  onEnd: (reason: string, previewUrl?: string) => void,
  onError: (err: string) => void,
): { close: () => void } {
  const url = `${WS_BASE_URL}/ws/logs/${deployId}`;
  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(url);
  } catch (e) {
    onError(`Failed to connect WebSocket: ${e}`);
    return { close: () => {} };
  }

  ws.onmessage = (event) => {
    try {
      const msg: LogMessage = JSON.parse(event.data);
      if (msg.type === "log" && msg.line) {
        onLog(msg.line);
      } else if (msg.type === "end") {
        onEnd(msg.reason || "unknown", msg.preview_url);
      } else if (msg.type === "error") {
        onError(msg.message || "Unknown error");
      }
    } catch {
      // ignore parse errors
    }
  };

  ws.onerror = () => {
    if (!closed) {
      onError("WebSocket connection error");
    }
  };

  ws.onclose = () => {
    if (!closed) {
      // Silent close is fine — deployment may have ended
    }
  };

  return {
    close: () => {
      closed = true;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close();
      }
    },
  };
}
