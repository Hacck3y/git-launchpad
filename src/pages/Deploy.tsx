import { useState, useEffect, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Terminal,
  GitBranch,
  Star,
  Code2,
  Loader2,
  ExternalLink,
  Copy,
  AlertTriangle,
  Rocket,
  Plus,
  Trash2,
  Timer,
  Server,
  Download,
  Shield,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { deployRepo, getDeployment, killDeployment, analyzeRepo, connectLogStream, type DeployConfig } from "@/lib/api";

// Types
interface RepoInfo {
  name: string;
  fullName: string;
  description: string;
  language: string;
  stars: number;
  defaultBranch: string;
}

interface EnvVar {
  key: string;
  value: string;
  needs_user_input?: boolean;
  description?: string;
  auto_filled?: boolean;
  platform_provided?: boolean;
  platform_service?: string;
  platform_display_name?: string;
  platform_running?: boolean;
  use_platform?: boolean; // toggle: true = use platform cred, false = manual
}

interface PlatformServiceInfo {
  service_type: string;
  display_name: string;
  is_running: boolean;
}

interface CompanionService {
  service: string;
  image: string;
  hostname: string;
  port: number;
  password: string | null;
  inject_env: Record<string, string>;
  container_name: string;
}

interface DeployStep {
  label: string;
  status: "pending" | "running" | "done";
}

const INITIAL_STEPS: DeployStep[] = [
  { label: "Cloning repository...", status: "pending" },
  { label: "Detecting stack...", status: "pending" },
  { label: "Starting companion services...", status: "pending" },
  { label: "Installing dependencies...", status: "pending" },
  { label: "Building project...", status: "pending" },
  { label: "Starting server...", status: "pending" },
  { label: "AI auto-fix (if needed)...", status: "pending" },
];

const languageColors: Record<string, string> = {
  TypeScript: "hsl(210, 80%, 55%)",
  JavaScript: "hsl(50, 95%, 50%)",
  Python: "hsl(210, 60%, 45%)",
  Rust: "hsl(25, 80%, 50%)",
  Go: "hsl(195, 70%, 50%)",
};

const Deploy = () => {
  const [searchParams] = useSearchParams();
  const initialRepo = searchParams.get("repo") || "";
  const { user } = useAuth();

  const [step, setStep] = useState(1);
  const [repoUrl, setRepoUrl] = useState(initialRepo);
  const [urlError, setUrlError] = useState("");
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [envVars, setEnvVars] = useState<EnvVar[]>([{ key: "", value: "" }]);
  const [skipEnvVars, setSkipEnvVars] = useState(false);
  const [detectedStack, setDetectedStack] = useState<string[]>([]);
  const [deploySteps, setDeploySteps] = useState<DeployStep[]>(INITIAL_STEPS);
  const [deployProgress, setDeployProgress] = useState(0);
  const [previewUrl, setPreviewUrl] = useState("");
  const [countdown, setCountdown] = useState(900); // 15 min
  const [deployId, setDeployId] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployConfig, setDeployConfig] = useState<DeployConfig | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState(20);
  const [destroying, setDestroying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployLogs, setDeployLogs] = useState<string[]>([]);
  const [pollFailCount, setPollFailCount] = useState(0);
  const [lastStatusChange, setLastStatusChange] = useState<number>(Date.now());
  const [lastStatus, setLastStatus] = useState<string>("");
  const [platformServices, setPlatformServices] = useState<PlatformServiceInfo[]>([]);
  const [showPlatformValues, setShowPlatformValues] = useState<Record<string, boolean>>({});
  const [detectedServices, setDetectedServices] = useState<string[]>([]);
  const [companionServices, setCompanionServices] = useState<Record<string, CompanionService>>({});

  const validateUrl = (url: string) => {
    const githubRegex = /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;
    return githubRegex.test(url);
  };

  const fetchRepoInfo = useCallback(async () => {
    if (!validateUrl(repoUrl)) {
      setUrlError("Please enter a valid GitHub repository URL");
      setRepoInfo(null);
      return;
    }
    setUrlError("");
    setLoadingRepo(true);
    setAnalyzing(true);

    try {
      const result = await analyzeRepo(repoUrl);
      
      setRepoInfo({
        name: result.repo.name,
        fullName: result.repo.fullName,
        description: result.repo.description,
        language: result.repo.language,
        stars: result.repo.stars,
        defaultBranch: result.repo.defaultBranch,
      });
      setDetectedStack(result.detected_stack);
      setDeployConfig(result.deploy_config);

      // Pre-populate env vars from analysis with platform + AI defaults
      if (result.env_vars && result.env_vars.length > 0) {
        setEnvVars(result.env_vars.map((v: any) => ({
          key: v.key,
          value: v.value || "",
          needs_user_input: v.needs_user_input || false,
          description: v.description || "",
          auto_filled: !v.needs_user_input && !!v.value,
          platform_provided: v.platform_provided || false,
          platform_service: v.platform_service || "",
          platform_display_name: v.platform_display_name || "",
          platform_running: v.platform_running || false,
          use_platform: v.platform_provided && v.platform_running ? true : false,
        })));
        const hasUserInputNeeded = result.env_vars.some((v: any) => v.needs_user_input && !v.platform_provided);
        setSkipEnvVars(!hasUserInputNeeded && result.env_vars.every((v: any) => v.value));
      } else if (result.required_env_vars && result.required_env_vars.length > 0) {
        setEnvVars(result.required_env_vars.map((key: string) => ({ key, value: "" })));
        setSkipEnvVars(false);
      }

      // Store platform services info
      if (result.platform_services) {
        setPlatformServices(result.platform_services);
      }

      // Store detected companion services
      if (result.detected_services && result.detected_services.length > 0) {
        setDetectedServices(result.detected_services);
      } else if (result.deploy_config?.detected_services) {
        setDetectedServices(result.deploy_config.detected_services);
      }

      toast.success("AI analyzed your repo successfully!");
    } catch (err: any) {
      setUrlError(err.message || "Failed to analyze repository");
      setRepoInfo(null);
    } finally {
      setLoadingRepo(false);
      setAnalyzing(false);
    }
  }, [repoUrl]);

  useEffect(() => {
    if (initialRepo && validateUrl(initialRepo)) {
      fetchRepoInfo();
    }
  }, []);

  // Start deploy API call
  const startDeploy = async () => {
    setDeploying(true);
    setDeploySteps(INITIAL_STEPS);
    setDeployProgress(0);
    setDeployError(null);
    setDeployLogs([]);
    setPollFailCount(0);
    setLastStatusChange(Date.now());
    setLastStatus("");
    setStep(3);

    try {
      const envVarsObj: Record<string, string> = {};
      if (!skipEnvVars) {
        envVars.forEach((ev) => {
          if (ev.key.trim()) envVarsObj[ev.key.trim()] = ev.value;
        });
      }
      setDeployLogs(prev => [...prev, `→ Sending deploy request to server...`]);
      const result = await deployRepo({
        repo_url: repoUrl,
        env_vars: envVarsObj,
        deploy_config: deployConfig || undefined,
        ttl_minutes: ttlMinutes,
      });
      const newDeployId = result.deploy_id || result.deployment_id || result.id;
      if (newDeployId) {
        setDeployId(newDeployId);
        setDeployLogs(prev => [...prev, `→ Deploy ID: ${newDeployId}`, `→ Polling for status updates...`]);

        // Save deployment to database
        if (user) {
          await supabase.from("deployments").insert({
            user_id: user.id,
            deploy_id: newDeployId,
            repo_url: repoUrl,
            repo_name: repoInfo?.fullName || repoUrl.split("/").slice(-2).join("/"),
            status: "deploying",
            language: deployConfig?.language || repoInfo?.language || null,
            framework: deployConfig?.framework || null,
          } as any);
        }
      } else {
        const errMsg = result.error || "No deploy ID returned from server";
        setDeployError(errMsg);
        setDeployLogs(prev => [...prev, `✗ Error: ${errMsg}`]);
        toast.error("Deploy failed: " + errMsg);
        setDeploying(false);
      }
    } catch (err: any) {
      const errMsg = err.message || "Could not reach deploy server";
      setDeployError(errMsg);
      setDeployLogs(prev => [...prev, `✗ Request failed: ${errMsg}`]);
      toast.error("Deploy request failed: " + errMsg);
      setDeploying(false);
    }
  };

  // Poll deployment status
  useEffect(() => {
    if (!deployId || step !== 3) return;

    const poll = setInterval(async () => {
      try {
        const data = await getDeployment(deployId);
        const status = data.status;
        setPollFailCount(0);

        // Track status changes for stall detection
        if (status !== lastStatus) {
          setLastStatus(status);
          setLastStatusChange(Date.now());
        } else {
          // If stuck on same status for 90s, report as failed
          const stalledMs = Date.now() - lastStatusChange;
          if (stalledMs > 90000 && status !== "live" && status !== "ready") {
            clearInterval(poll);
            const errMsg = `Deployment stalled on "${status}" for over 90 seconds. The build may have failed silently.`;
            setDeployError(errMsg);
            setDeployLogs(prev => [...prev, `✗ ${errMsg}`]);
            toast.error("Deployment appears stalled");
            setDeploying(false);
            return;
          }
        }

        // Add log for status changes
        setDeployLogs(prev => {
          const lastLog = prev[prev.length - 1];
          const newLog = `→ Status: ${status}`;
          if (lastLog !== newLog) return [...prev, newLog];
          return prev;
        });

        // Append AI fix logs if present
        const aiFixLog: string[] = data.ai_fix_log || [];
        if (aiFixLog.length > 0) {
          setDeployLogs(prev => {
            const newLogs = aiFixLog.filter(l => !prev.includes(`🤖 ${l}`)).map(l => `🤖 ${l}`);
            return newLogs.length > 0 ? [...prev, ...newLogs] : prev;
          });
        }

        // Map API status to deploy steps
        const statusMap: Record<string, number> = {
          cloning: 0,
          detecting: 1,
          installing: 2,
          building: 3,
          starting: 4,
          ai_fixing: 5,
          ai_retrying: 5,
          live: 6,
        };

        const stepIndex = statusMap[status] ?? -1;

        if (stepIndex >= 0) {
          setDeploySteps((prev) =>
            prev.map((s, i) => ({
              ...s,
              status: i < stepIndex ? "done" : i === stepIndex ? (status === "live" ? "done" : "running") : "pending",
            }))
          );
          setDeployProgress(Math.min((stepIndex / INITIAL_STEPS.length) * 100, 100));
        }

        if (status === "live" || status === "running" || status === "ready") {
          clearInterval(poll);
          setDeploySteps((prev) => prev.map((s) => ({ ...s, status: "done" as const })));
          setDeployProgress(100);
          const liveUrl = data.preview_url || data.url || "";
          setPreviewUrl(liveUrl);
          setDeployLogs(prev => [...prev, `✓ Live at: ${liveUrl}`]);

          // Capture companion services info
          if (data.companion_services) {
            setCompanionServices(data.companion_services);
          }

          if (data.expires_at) {
            const expiresAt = new Date(data.expires_at).getTime();
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            setCountdown(remaining);
          }

          if (user) {
            await supabase
              .from("deployments")
              .update({
                status: "live",
                preview_url: liveUrl,
                expires_at: data.expires_at || null,
              } as any)
              .eq("deploy_id", deployId);
          }

          setTimeout(() => {
            setStep(4);
            setDeploying(false);
          }, 600);
        }

        if (status === "error" || status === "failed") {
          clearInterval(poll);
          const errMsg = data.error || data.message || data.detail || "Deployment failed on server";
          setDeployError(errMsg);
          setDeployLogs(prev => [...prev, `✗ Failed: ${errMsg}`]);
          toast.error("Deployment failed: " + errMsg);
          setDeploying(false);
        }
      } catch (err: any) {
        setPollFailCount(prev => {
          const newCount = prev + 1;
          setDeployLogs(logs => [...logs, `⚠ Poll error (${newCount}/10): ${err.message || "Network error"}`]);
          if (newCount >= 10) {
            clearInterval(poll);
            setDeployError("Lost connection to deploy server after 10 retries");
            setDeployLogs(logs => [...logs, `✗ Gave up after 10 failed poll attempts`]);
            setDeploying(false);
          }
          return newCount;
        });
      }
    }, 3000);

    return () => clearInterval(poll);
  }, [deployId, step]);

  // WebSocket real-time log streaming
  useEffect(() => {
    if (!deployId || step !== 3) return;

    const logStream = connectLogStream(
      deployId,
      (line) => {
        setDeployLogs(prev => {
          // Avoid duplicates
          if (prev[prev.length - 1] === `📦 ${line}`) return prev;
          return [...prev, `📦 ${line}`];
        });
      },
      (reason, previewUrl) => {
        if (reason === "live" && previewUrl) {
          setDeployLogs(prev => [...prev, `✓ Stream ended: deployment is live`]);
        }
      },
      (err) => {
        console.warn("[WS] Log stream error:", err);
        // WebSocket is optional — polling handles the main flow
      },
    );

    return () => logStream.close();
  }, [deployId, step]);

  // Countdown timer for live step
  useEffect(() => {
    if (step !== 4) return;
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 0) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [step]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const addEnvVar = () => setEnvVars([...envVars, { key: "", value: "", needs_user_input: false }]);
  const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
  const updateEnvVar = (index: number, field: "key" | "value", val: string) => {
    const updated = [...envVars];
    updated[index][field] = val;
    setEnvVars(updated);
  };
  const togglePlatformUse = (index: number) => {
    const updated = [...envVars];
    updated[index].use_platform = !updated[index].use_platform;
    setEnvVars(updated);
  };
  const toggleShowPlatformValue = (key: string) => {
    setShowPlatformValues(prev => ({ ...prev, [key]: !prev[key] }));
  };
  const maskValue = (val: string) => {
    if (val.length <= 8) return "••••••••";
    return val.slice(0, 4) + "••••••••" + val.slice(-4);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(previewUrl);
    toast.success("Preview link copied!");
  };

  const stepIndicator = (num: number, label: string) => {
    const isActive = step === num;
    const isDone = step > num;
    return (
      <div className="flex items-center gap-2">
        <div
          className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${
            isDone
              ? "bg-primary text-primary-foreground"
              : isActive
              ? "border-2 border-primary text-primary animate-pulse-ring"
              : "border border-border text-muted-foreground"
          }`}
        >
          {isDone ? <CheckCircle2 className="h-4 w-4" /> : num}
        </div>
        <span className={`text-sm hidden sm:inline ${isActive ? "text-foreground font-medium" : "text-muted-foreground"}`}>
          {label}
        </span>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      <main className="container mx-auto px-6 pt-28 pb-16 max-w-2xl">
        {/* Step indicators */}
        <div className="flex items-center justify-between mb-10">
          {stepIndicator(1, "Repo")}
          <div className="flex-1 h-px bg-border mx-2" />
          {stepIndicator(2, "Config")}
          <div className="flex-1 h-px bg-border mx-2" />
          {stepIndicator(3, "Deploy")}
          <div className="flex-1 h-px bg-border mx-2" />
          {stepIndicator(4, "Live")}
        </div>

        <AnimatePresence mode="wait">
          {/* STEP 1: Paste URL */}
          {step === 1 && (
            <motion.div
              key="step1"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3 }}
            >
              <h2 className="text-2xl font-bold mb-2">Paste your GitHub repo URL</h2>
              <p className="text-muted-foreground mb-6">We'll fetch the repo info and prepare it for deployment.</p>

              <div className="relative">
                <Terminal className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={repoUrl}
                  onChange={(e) => {
                    setRepoUrl(e.target.value);
                    setUrlError("");
                    setRepoInfo(null);
                  }}
                  onBlur={() => repoUrl && fetchRepoInfo()}
                  onKeyDown={(e) => e.key === "Enter" && fetchRepoInfo()}
                  placeholder="https://github.com/user/repo"
                  className="h-12 pl-10 font-mono text-sm bg-card border-border focus:border-primary"
                />
              </div>
              {urlError && (
                <p className="mt-2 text-sm text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" /> {urlError}
                </p>
              )}

              {(loadingRepo || analyzing) && (
                <div className="mt-6 flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {analyzing ? "AI is analyzing your repo..." : "Fetching repo info..."}
                </div>
              )}

              {repoInfo && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 rounded-xl border border-border bg-card/80 p-5"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-mono font-semibold text-lg">{repoInfo.fullName}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{repoInfo.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="h-3 w-3 rounded-full"
                        style={{ backgroundColor: languageColors[repoInfo.language] || "hsl(var(--muted-foreground))" }}
                      />
                      {repoInfo.language}
                    </span>
                    <span className="flex items-center gap-1">
                      <Star className="h-3.5 w-3.5" />
                      {repoInfo.stars.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3.5 w-3.5" />
                      {repoInfo.defaultBranch}
                    </span>
                  </div>
                </motion.div>
              )}

              {repoInfo && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
                  <Button
                    onClick={() => setStep(2)}
                    className="mt-6 gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm"
                  >
                    Looks good? Deploy
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* STEP 2: Environment Setup */}
          {step === 2 && (
            <motion.div
              key="step2"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3 }}
            >
              <h2 className="text-2xl font-bold mb-2">Environment Setup</h2>
              <p className="text-muted-foreground mb-6">We detected the following stack. Add env vars if needed.</p>

              {/* Detected stack */}
              <div className="mb-6">
                <p className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Code2 className="h-4 w-4 text-primary" /> Detected Stack
                </p>
                <div className="flex flex-wrap gap-2">
                  {detectedStack.map((tech) => (
                    <span
                      key={tech}
                      className="inline-flex items-center rounded-md border border-border bg-secondary px-3 py-1 text-xs font-mono font-medium text-secondary-foreground"
                    >
                      {tech}
                    </span>
                  ))}
                </div>

                {/* Detected companion services */}
                {detectedServices.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Server className="h-3.5 w-3.5 text-primary" /> Auto-provisioned services
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {detectedServices.map((svc) => (
                        <span
                          key={svc}
                          className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-mono font-medium text-primary"
                        >
                          🐳 {svc}
                        </span>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      These will be automatically started as companion containers during deploy.
                    </p>
                  </div>
                )}
              </div>

              {/* Env vars section */}
              {(() => {
                const platformVars = envVars.filter(v => v.platform_service);
                const userInputVars = envVars.filter(v => v.needs_user_input && !v.platform_service);
                const autoFilledVars = envVars.filter(v => !v.needs_user_input && v.key && !v.platform_service);
                
                // All services not currently running (show install option)
                const notRunning = platformServices.filter(s => !s.is_running);
                // Services needed by this project but not running
                const neededNotRunning = notRunning.filter(s => 
                  envVars.some(v => v.platform_service === s.service_type)
                );
                
                return (
                  <>
                    {/* Platform-provided services */}
                    {platformVars.length > 0 && (
                      <div className="mb-4">
                        <p className="text-sm font-medium mb-2 flex items-center gap-2 text-primary">
                          <Server className="h-4 w-4" /> Platform Services ({platformVars.length})
                        </p>
                        <p className="text-xs text-muted-foreground mb-3">
                          These credentials are provided by your server. Toggle off to enter custom values.
                        </p>
                        <div className="space-y-3">
                          {platformVars.map((envVar) => {
                            const originalIdx = envVars.findIndex(v => v.key === envVar.key);
                            const isUsingPlatform = envVar.use_platform && envVar.platform_running;
                            const isVisible = showPlatformValues[envVar.key];
                            
                            return (
                              <div key={envVar.key} className={`rounded-lg border p-3 transition-all ${
                                isUsingPlatform 
                                  ? "border-primary/30 bg-primary/5" 
                                  : envVar.platform_running 
                                    ? "border-border bg-card/50"
                                    : "border-destructive/30 bg-destructive/5"
                              }`}>
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <Shield className="h-3.5 w-3.5 text-primary" />
                                    <span className="font-mono text-xs font-semibold text-foreground">{envVar.key}</span>
                                    <span className="text-xs rounded-full px-2 py-0.5 bg-primary/10 text-primary font-medium">
                                      {envVar.platform_display_name}
                                    </span>
                                    {envVar.platform_running ? (
                                      <span className="text-xs rounded-full px-2 py-0.5 bg-emerald-500/10 text-emerald-400">● Running</span>
                                    ) : (
                                      <span className="text-xs rounded-full px-2 py-0.5 bg-destructive/10 text-destructive">● Not installed</span>
                                    )}
                                  </div>
                                  {envVar.platform_running && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-muted-foreground">Auto</span>
                                      <Switch 
                                        checked={envVar.use_platform || false}
                                        onCheckedChange={() => togglePlatformUse(originalIdx)}
                                      />
                                    </div>
                                  )}
                                </div>
                                
                                {isUsingPlatform ? (
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 font-mono text-xs h-9 flex items-center px-3 rounded-md bg-card/50 border border-border text-muted-foreground">
                                      {isVisible ? envVar.value : maskValue(envVar.value)}
                                    </div>
                                    <Button 
                                      variant="ghost" 
                                      size="sm" 
                                      onClick={() => toggleShowPlatformValue(envVar.key)}
                                      className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                    >
                                      {isVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                                    </Button>
                                  </div>
                                ) : envVar.platform_running ? (
                                  <Input
                                    value={envVar.value}
                                    onChange={(e) => updateEnvVar(originalIdx, "value", e.target.value)}
                                    placeholder="Enter custom value..."
                                    type="password"
                                    className="font-mono text-xs h-9 bg-card border-border"
                                  />
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <Input
                                      value={envVar.value}
                                      onChange={(e) => updateEnvVar(originalIdx, "value", e.target.value)}
                                      placeholder={`Enter ${envVar.platform_display_name} connection URL...`}
                                      type="password"
                                      className="flex-1 font-mono text-xs h-9 bg-card border-border"
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    

                    {/* User-required API keys */}
                    {userInputVars.length > 0 && (
                      <div className="mb-4">
                        <p className="text-sm font-medium mb-2 flex items-center gap-2 text-amber-400">
                          <AlertTriangle className="h-4 w-4" /> API Keys Required ({userInputVars.length})
                        </p>
                        <p className="text-xs text-muted-foreground mb-3">
                          These secrets are needed for the app to work. Enter them below.
                        </p>
                        <div className="space-y-3">
                          {userInputVars.map((envVar) => {
                            const originalIdx = envVars.findIndex(v => v.key === envVar.key);
                            return (
                              <div key={envVar.key} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-mono text-xs font-semibold text-amber-300">{envVar.key}</span>
                                  {envVar.description && (
                                    <span className="text-xs text-muted-foreground">— {envVar.description}</span>
                                  )}
                                </div>
                                <Input
                                  value={envVar.value}
                                  onChange={(e) => updateEnvVar(originalIdx, "value", e.target.value)}
                                  placeholder="Paste your key here..."
                                  type="password"
                                  className="font-mono text-xs h-9 bg-card border-border"
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Auto-filled vars */}
                    {autoFilledVars.length > 0 && (
                      <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-sm font-medium flex items-center gap-2 text-emerald-400">
                            <CheckCircle2 className="h-4 w-4" /> Auto-configured ({autoFilledVars.length})
                          </p>
                          <span className="text-xs text-muted-foreground">Values auto-generated by AI</span>
                        </div>
                        <div className="space-y-2 rounded-lg border border-border bg-card/30 p-3">
                          {autoFilledVars.map((envVar) => {
                            const originalIdx = envVars.findIndex(v => v.key === envVar.key);
                            return (
                              <div key={envVar.key} className="flex items-center gap-2">
                                <span className="font-mono text-xs text-emerald-300 min-w-[180px] truncate" title={envVar.key}>
                                  {envVar.key}
                                </span>
                                <Input
                                  value={envVar.value}
                                  onChange={(e) => updateEnvVar(originalIdx, "value", e.target.value)}
                                  placeholder="value"
                                  className="flex-1 font-mono text-xs h-8 bg-card/50 border-border text-muted-foreground"
                                />
                                <Button variant="ghost" size="sm" onClick={() => removeEnvVar(originalIdx)} className="text-muted-foreground hover:text-destructive h-8 w-8 p-0">
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* No env vars needed */}
                    {envVars.filter(v => v.key).length === 0 && (
                      <div className="flex items-center justify-between mb-4 rounded-lg border border-border bg-card/50 p-4">
                        <span className="text-sm flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-400" /> No environment variables needed
                        </span>
                      </div>
                    )}

                    {/* Add custom var */}
                    <Button variant="ghost" size="sm" onClick={addEnvVar} className="gap-1.5 text-xs text-muted-foreground hover:text-primary mb-2">
                      <Plus className="h-3.5 w-3.5" /> Add custom variable
                    </Button>
                  </>
                );
              })()}

              {/* Duration picker */}
              <div className="mt-6 mb-6">
                <p className="text-sm font-medium mb-3 flex items-center gap-2">
                  <Timer className="h-4 w-4 text-primary" /> Preview Duration
                </p>
                <div className="flex gap-2">
                  {[
                    { value: 5, label: "5 min" },
                    { value: 20, label: "20 min" },
                    { value: 30, label: "30 min" },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setTtlMinutes(opt.value)}
                      className={`flex-1 rounded-lg border px-4 py-3 text-sm font-mono font-medium transition-all ${
                        ttlMinutes === opt.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-card/50 text-muted-foreground hover:border-primary/50"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Your preview will auto-expire after {ttlMinutes} minutes.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="ghost" onClick={() => setStep(1)} className="gap-1.5 text-muted-foreground">
                  <ArrowLeft className="h-4 w-4" /> Back
                </Button>
                <Button
                  onClick={startDeploy}
                  className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm"
                >
                  <Rocket className="h-4 w-4" />
                  Start Deploy
                </Button>
              </div>
            </motion.div>
          )}

          {/* STEP 3: Deploying */}
          {step === 3 && (
            <motion.div
              key="step3"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.3 }}
            >
              <h2 className="text-2xl font-bold mb-2">
                {deployError ? "Deploy Failed" : "Deploying..."}
              </h2>
              <p className="text-muted-foreground mb-6 font-mono text-sm">{repoInfo?.fullName || "your-repo"}</p>

              <Progress value={deployProgress} className={`h-2 mb-8 ${deployError ? "[&>div]:bg-destructive" : ""}`} />

              <div className="rounded-xl border border-border bg-card/80 p-5 font-mono text-sm space-y-3">
                {deploySteps.map((s, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="flex items-center gap-3"
                  >
                    {s.status === "done" && <CheckCircle2 className="h-4 w-4 text-success shrink-0" />}
                    {s.status === "running" && <Loader2 className="h-4 w-4 text-primary animate-spin shrink-0" />}
                    {s.status === "pending" && <Circle className="h-4 w-4 text-muted-foreground/30 shrink-0" />}
                    <span
                      className={
                        s.status === "done"
                          ? "text-foreground"
                          : s.status === "running"
                          ? "text-primary"
                          : "text-muted-foreground/40"
                      }
                    >
                      {s.status === "done" ? "✓" : s.status === "running" ? "▸" : " "} {s.label}
                    </span>
                  </motion.div>
                ))}

                {deployProgress >= 100 && !deployError && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="pt-2 text-primary font-semibold"
                  >
                    🟢 Live at:{" "}
                    <span className="underline underline-offset-2">{previewUrl}</span>
                  </motion.div>
                )}
              </div>

              {/* Error banner */}
              {deployError && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold text-destructive text-sm">Deployment Error</p>
                      <p className="text-sm text-destructive/80 mt-1 font-mono">{deployError}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDeployError(null);
                        setDeployId(null);
                        setStep(2);
                      }}
                      className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                    >
                      <ArrowLeft className="h-3.5 w-3.5" /> Go Back & Retry
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Live log output */}
              {deployLogs.length > 0 && (
                <div className="mt-4 rounded-lg border border-border bg-background/80 p-3 max-h-64 overflow-y-auto" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
                  <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider">Deploy Log</p>
                  {deployLogs.map((log, i) => (
                    <p
                      key={i}
                      className={`font-mono text-[11px] leading-relaxed ${
                        log.startsWith("✗") ? "text-destructive" : log.startsWith("⚠") ? "text-warning" : log.startsWith("✓") ? "text-success" : log.startsWith("🤖") ? "text-primary" : log.startsWith("📦") ? "text-muted-foreground/80" : "text-muted-foreground"
                      }`}
                    >
                      {log}
                    </p>
                  ))}
                </div>
              )}

              {!deployError && (
                <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="animate-blink">█</span> Hang tight, this usually takes under 60 seconds...
                </div>
              )}
            </motion.div>
          )}

          {/* STEP 4: Live */}
          {step === 4 && (
            <motion.div
              key="step4"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, type: "spring" }}
              className="text-center"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-success/10 border-2 border-success/30"
              >
                <CheckCircle2 className="h-10 w-10 text-success" />
              </motion.div>

              <h2 className="text-3xl font-bold mb-2">Your app is live! 🎉</h2>
              <p className="text-muted-foreground mb-8">{repoInfo?.fullName || "your-repo"} is running and ready to preview.</p>

              {/* Preview URL */}
              <div className="mx-auto max-w-md rounded-xl border border-primary/30 bg-primary/5 p-5 glow-cyan-sm mb-6">
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider">Preview URL</p>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary text-lg hover:underline underline-offset-4 break-all"
                >
                  {previewUrl}
                </a>
              </div>

              {/* Companion Services Credentials */}
              {Object.keys(companionServices).length > 0 && (
                <div className="mx-auto max-w-md rounded-xl border border-border bg-card/80 p-5 mb-6 text-left">
                  <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-1.5">
                    <Server className="h-3.5 w-3.5" /> Companion Services
                  </p>
                  <div className="space-y-3">
                    {Object.entries(companionServices).map(([name, svc]) => (
                      <div key={name} className="rounded-lg border border-border bg-background/50 p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-xs font-mono font-semibold text-primary">🐳 {name}</span>
                          <span className="text-xs text-muted-foreground">{(svc as CompanionService).image}</span>
                        </div>
                        <div className="space-y-1">
                          {Object.entries((svc as CompanionService).inject_env).map(([key, val]) => (
                            <div key={key} className="flex items-center gap-2">
                              <span className="font-mono text-[10px] text-muted-foreground min-w-[120px]">{key}</span>
                              <span className="font-mono text-[10px] text-foreground break-all">{val}</span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                onClick={() => {
                                  navigator.clipboard.writeText(val);
                                  toast.success(`Copied ${key}`);
                                }}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Countdown */}
              <div className={`mb-8 ${countdown <= 120 ? "text-warning" : "text-muted-foreground"}`}>
                {countdown <= 120 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center justify-center gap-2 mb-1 text-warning text-sm font-medium"
                  >
                    <AlertTriangle className="h-4 w-4" /> Preview expiring soon!
                  </motion.div>
                )}
                <p className="text-sm">
                  Expires in:{" "}
                  <span className="font-mono font-bold text-lg">{formatTime(countdown)}</span>
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <Button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open Preview
                </Button>
                <Button variant="outline" onClick={copyLink} className="gap-2 border-border hover:border-primary/50">
                  <Copy className="h-4 w-4" />
                  Share this preview
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (!deployId) return;
                    setDestroying(true);
                    try {
                      await killDeployment(deployId);
                      if (user) {
                        await supabase
                          .from("deployments")
                          .update({ status: "killed" } as any)
                          .eq("deploy_id", deployId);
                      }
                      toast.success("Preview destroyed successfully");
                      setCountdown(0);
                    } catch (err: any) {
                      toast.error("Failed to destroy: " + err.message);
                    } finally {
                      setDestroying(false);
                    }
                  }}
                  disabled={destroying || countdown === 0}
                  className="gap-2 border-destructive/50 text-destructive hover:bg-destructive/10 hover:border-destructive"
                >
                  {destroying ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Destroy Preview
                </Button>
                <Button
                  variant="ghost"
                  className="gap-2 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setStep(1);
                    setRepoUrl("");
                    setUrlError("");
                    setRepoInfo(null);
                    setLoadingRepo(false);
                    setEnvVars([{ key: "", value: "" }]);
                    setSkipEnvVars(false);
                    setDetectedStack([]);
                    setDeploySteps(INITIAL_STEPS);
                    setDeployProgress(0);
                    setPreviewUrl("");
                    setCountdown(900);
                    setDeployId(null);
                    setDeploying(false);
                    setDeployConfig(null);
                    setAnalyzing(false);
                    setTtlMinutes(20);
                    setDestroying(false);
                    setDeployError(null);
                    setDeployLogs([]);
                    setPollFailCount(0);
                    setDetectedServices([]);
                    setCompanionServices({});
                  }}
                >
                  <Rocket className="h-4 w-4" />
                  Deploy another
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default Deploy;
