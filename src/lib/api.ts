export interface DeployConfig {
  language: string;
  framework: string;
  install_cmd: string;
  build_cmd: string;
  start_cmd: string;
  port: number;
  dockerfile_content: string;
  detected_services?: string[];
  confidence?: number | null;
  confidence_notes?: string;
}

interface DeployRequest {
  repo_url: string;
  env_vars: Record<string, string>;
  deploy_config?: DeployConfig;
  ttl_minutes?: number;
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://157.245.109.239";
const WS_BASE_URL = BASE_URL.replace(/^https?:\/\//, (m: string) => m.startsWith("https") ? "wss://" : "ws://");

// ─── Retry helper ────────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 2,
  backoff = 1000,
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok || res.status < 500 || i === retries) return res;
    } catch (err: any) {
      if (i === retries) throw err;
    }
    await new Promise((r) => setTimeout(r, backoff * (i + 1)));
  }
  throw new Error("Request failed after retries");
}

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
  const res = await fetchWithRetry(`${supabaseUrl}/functions/v1/analyze-repo`, {
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
  const res = await fetchWithRetry(`${BASE_URL}/api/deploy`, {
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
  const res = await fetchWithRetry(`${BASE_URL}/api/deploy/${deployId}`, {}, 1, 2000);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function killDeployment(deployId: string) {
  const res = await fetchWithRetry(`${BASE_URL}/api/deploy/${deployId}`, {
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
  let reconnectAttempts = 0;
  const maxReconnects = 3;

  const connect = () => {
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onError(`Failed to connect WebSocket: ${e}`);
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
    };

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
        // Will attempt reconnect on close
      }
    };

    ws.onclose = () => {
      if (!closed && reconnectAttempts < maxReconnects) {
        reconnectAttempts++;
        setTimeout(connect, 2000 * reconnectAttempts);
      }
    };
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close();
      }
    },
  };
}