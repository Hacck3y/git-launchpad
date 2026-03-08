import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Plus,
  ExternalLink,
  Copy,
  Clock,
  CheckCircle2,
  XCircle,
  Rocket,
  Loader2,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { killDeployment } from "@/lib/api";

interface Deployment {
  id: string;
  deploy_id: string;
  repo_name: string;
  repo_url: string;
  status: string;
  preview_url: string | null;
  language: string | null;
  framework: string | null;
  created_at: string;
  expires_at: string | null;
}

const Dashboard = () => {
  const { user, profile } = useAuth();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [killingId, setKillingId] = useState<string | null>(null);

  const fetchDeployments = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("deployments")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to fetch deployments:", error);
    } else {
      setDeployments((data as Deployment[]) || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchDeployments();
  }, [user]);

  // Live countdown update every second
  useEffect(() => {
    const interval = setInterval(() => {
      setDeployments((prev) =>
        prev.map((d) => {
          if (d.status === "live" && d.expires_at) {
            const remaining = Math.max(
              0,
              Math.floor((new Date(d.expires_at).getTime() - Date.now()) / 1000)
            );
            if (remaining === 0 && d.status === "live") {
              return { ...d, status: "expired" };
            }
          }
          return d;
        })
      );
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const getTimeRemaining = (expiresAt: string | null): string => {
    if (!expiresAt) return "—";
    const remaining = Math.max(
      0,
      Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
    );
    if (remaining === 0) return "Expired";
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const getEffectiveStatus = (d: Deployment): "live" | "expired" | "deploying" | "error" => {
    if (d.status === "error" || d.status === "failed") return "error";
    if (d.status === "expired" || d.status === "killed") return "expired";
    if (d.status === "live" || d.status === "running" || d.status === "ready") {
      if (d.expires_at) {
        const remaining = new Date(d.expires_at).getTime() - Date.now();
        if (remaining <= 0) return "expired";
      }
      return "live";
    }
    return "deploying";
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  };

  const handleKill = async (d: Deployment) => {
    setKillingId(d.id);
    try {
      await killDeployment(d.deploy_id);
      await supabase
        .from("deployments")
        .update({ status: "killed" } as any)
        .eq("id", d.id);
      toast.success("Deployment stopped");
      fetchDeployments();
    } catch (err: any) {
      toast.error("Failed to stop: " + err.message);
    } finally {
      setKillingId(null);
    }
  };

  const statusConfig = {
    live: { label: "Live", icon: CheckCircle2, className: "text-emerald-400" },
    expired: { label: "Expired", icon: XCircle, className: "text-muted-foreground" },
    deploying: { label: "Deploying", icon: Clock, className: "text-amber-400" },
    error: { label: "Failed", icon: XCircle, className: "text-destructive" },
  };

  const liveCount = deployments.filter((d) => getEffectiveStatus(d) === "live").length;
  const totalCount = deployments.length;

  const greeting = profile?.display_name
    ? `Welcome back, ${profile.display_name.split(" ")[0]}`
    : "Dashboard";

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      <main className="container mx-auto px-6 pt-28 pb-16 max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-3xl font-bold">{greeting}</h1>
              <p className="mt-1 text-muted-foreground">
                {totalCount === 0
                  ? "You haven't deployed anything yet. Let's get started!"
                  : `${liveCount} active preview${liveCount !== 1 ? "s" : ""} · ${totalCount} total deployment${totalCount !== 1 ? "s" : ""}`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchDeployments}
                className="gap-1.5 text-muted-foreground hover:text-primary"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </Button>
              <Link to="/deploy">
                <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm">
                  <Plus className="h-4 w-4" />
                  New Preview
                </Button>
              </Link>
            </div>
          </div>

          {/* Stats cards */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="rounded-xl border border-border bg-card/50 p-5 text-center">
              <p className="text-3xl font-bold text-primary">{totalCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Total Deploys</p>
            </div>
            <div className="rounded-xl border border-border bg-card/50 p-5 text-center">
              <p className="text-3xl font-bold text-emerald-400">{liveCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Active Now</p>
            </div>
            <div className="rounded-xl border border-border bg-card/50 p-5 text-center">
              <p className="text-3xl font-bold text-muted-foreground">
                {deployments.filter((d) => getEffectiveStatus(d) === "expired").length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Expired</p>
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading deployments...
            </div>
          )}

          {/* Empty state */}
          {!loading && deployments.length === 0 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center justify-center py-20 text-center"
            >
              <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
                <Rocket className="h-8 w-8 text-primary" />
              </div>
              <h3 className="text-lg font-semibold mb-1">No deployments yet</h3>
              <p className="text-sm text-muted-foreground mb-6 max-w-sm">
                Paste a GitHub repo URL and we'll spin up a live preview in seconds.
              </p>
              <Link to="/deploy">
                <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm">
                  <Plus className="h-4 w-4" />
                  Deploy your first repo
                </Button>
              </Link>
            </motion.div>
          )}

          {/* Deployments table */}
          {!loading && deployments.length > 0 && (
            <div className="rounded-xl border border-border bg-card/50 overflow-hidden">
              <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 items-center px-6 py-3 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
                <span>Repository</span>
                <span>Stack</span>
                <span>Status</span>
                <span>Time Left</span>
                <span>Actions</span>
              </div>

              {deployments.map((deploy, i) => {
                const effectiveStatus = getEffectiveStatus(deploy);
                const status = statusConfig[effectiveStatus];
                const StatusIcon = status.icon;

                return (
                  <motion.div
                    key={deploy.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-4 items-center px-6 py-4 border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-medium truncate">{deploy.repo_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(deploy.created_at).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>

                    <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {deploy.framework || deploy.language || "—"}
                    </span>

                    <div className={`flex items-center gap-1.5 text-sm whitespace-nowrap ${status.className}`}>
                      <StatusIcon className="h-3.5 w-3.5" />
                      {status.label}
                    </div>

                    <span className="text-sm font-mono text-muted-foreground whitespace-nowrap">
                      {effectiveStatus === "live"
                        ? getTimeRemaining(deploy.expires_at)
                        : "—"}
                    </span>

                    <div className="flex items-center gap-1">
                      {effectiveStatus === "live" && deploy.preview_url && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-xs hover:text-primary"
                            onClick={() => window.open(deploy.preview_url!, "_blank")}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="gap-1 text-xs hover:text-primary"
                            onClick={() => copyLink(deploy.preview_url!)}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs hover:text-destructive"
                            onClick={() => handleKill(deploy)}
                            disabled={killingId === deploy.id}
                          >
                            {killingId === deploy.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </>
                      )}
                      {effectiveStatus === "expired" && (
                        <Link to={`/deploy?repo=${encodeURIComponent(deploy.repo_url)}`}>
                          <Button variant="ghost" size="sm" className="text-xs hover:text-primary">
                            Redeploy
                          </Button>
                        </Link>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
};

export default Dashboard;
