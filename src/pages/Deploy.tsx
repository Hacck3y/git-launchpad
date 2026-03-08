import { useState, useEffect, useCallback } from "react";
import { useSearchParams, Link } from "react-router-dom";
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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { deployRepo, getDeployment, analyzeRepo, type DeployConfig } from "@/lib/api";

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
}

interface DeployStep {
  label: string;
  status: "pending" | "running" | "done";
}

const INITIAL_STEPS: DeployStep[] = [
  { label: "Cloning repository...", status: "pending" },
  { label: "Detecting stack...", status: "pending" },
  { label: "Installing dependencies...", status: "pending" },
  { label: "Building project...", status: "pending" },
  { label: "Starting server...", status: "pending" },
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
    setStep(3);

    try {
      const envVarsObj: Record<string, string> = {};
      if (!skipEnvVars) {
        envVars.forEach((ev) => {
          if (ev.key.trim()) envVarsObj[ev.key.trim()] = ev.value;
        });
      }
      const result = await deployRepo({
        repo_url: repoUrl,
        env_vars: envVarsObj,
        deploy_config: deployConfig || undefined,
      });
      if (result.deploy_id || result.deployment_id || result.id) {
        setDeployId(result.deploy_id || result.deployment_id || result.id);
      } else {
        toast.error("Deploy failed: " + (result.error || "Unknown error"));
        setDeploying(false);
      }
    } catch (err: any) {
      toast.error("Deploy request failed: " + err.message);
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

        // Map API status to deploy steps
        const statusMap: Record<string, number> = {
          cloning: 0,
          detecting: 1,
          installing: 2,
          building: 3,
          starting: 4,
          live: 5,
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
          setPreviewUrl(data.preview_url || data.url || "");

          // Calculate countdown from expires_at
          if (data.expires_at) {
            const expiresAt = new Date(data.expires_at).getTime();
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            setCountdown(remaining);
          }

          setTimeout(() => {
            setStep(4);
            setDeploying(false);
          }, 600);
        }

        if (status === "error" || status === "failed") {
          clearInterval(poll);
          toast.error("Deployment failed: " + (data.error || "Unknown error"));
          setDeploying(false);
        }
      } catch {
        
        // Ignore transient fetch errors, keep polling
      }
    }, 3000);

    return () => clearInterval(poll);
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

  const addEnvVar = () => setEnvVars([...envVars, { key: "", value: "" }]);
  const removeEnvVar = (index: number) => setEnvVars(envVars.filter((_, i) => i !== index));
  const updateEnvVar = (index: number, field: "key" | "value", val: string) => {
    const updated = [...envVars];
    updated[index][field] = val;
    setEnvVars(updated);
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
              </div>

              {/* Env vars toggle */}
              <div className="flex items-center justify-between mb-4 rounded-lg border border-border bg-card/50 p-4">
                <span className="text-sm">This repo needs no env vars</span>
                <Switch checked={skipEnvVars} onCheckedChange={setSkipEnvVars} />
              </div>

              {/* Env var inputs */}
              {!skipEnvVars && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="space-y-3"
                >
                  {envVars.map((envVar, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={envVar.key}
                        onChange={(e) => updateEnvVar(i, "key", e.target.value)}
                        placeholder="KEY"
                        className="flex-1 font-mono text-xs h-10 bg-card border-border"
                      />
                      <Input
                        value={envVar.value}
                        onChange={(e) => updateEnvVar(i, "value", e.target.value)}
                        placeholder="value"
                        type="password"
                        className="flex-1 font-mono text-xs h-10 bg-card border-border"
                      />
                      {envVars.length > 1 && (
                        <Button variant="ghost" size="sm" onClick={() => removeEnvVar(i)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={addEnvVar} className="gap-1.5 text-xs text-muted-foreground hover:text-primary">
                    <Plus className="h-3.5 w-3.5" /> Add variable
                  </Button>
                </motion.div>
              )}

              <div className="mt-8 flex items-center gap-3">
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
              <h2 className="text-2xl font-bold mb-2">Deploying...</h2>
              <p className="text-muted-foreground mb-6 font-mono text-sm">{repoInfo?.fullName || "your-repo"}</p>

              <Progress value={deployProgress} className="h-2 mb-8" />

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

                {deployProgress >= 100 && (
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

              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="animate-blink">█</span> Hang tight, this usually takes under 60 seconds...
              </div>
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
                <Link to="/deploy">
                  <Button variant="ghost" className="gap-2 text-muted-foreground hover:text-foreground">
                    <Rocket className="h-4 w-4" />
                    Deploy another
                  </Button>
                </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
};

export default Deploy;
