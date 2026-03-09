import { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { ExternalLink, Clock, AlertTriangle, Rocket, User, Loader2, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";
import { supabase } from "@/integrations/supabase/client";

interface DeploymentData {
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
  user_id: string;
}

const PreviewPage = () => {
  const { id } = useParams();
  const [deployment, setDeployment] = useState<DeploymentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchDeployment = async () => {
      if (!id) {
        setError("No preview ID provided");
        setLoading(false);
        return;
      }

      try {
        const { data, error: dbError } = await supabase
          .from("deployments")
          .select("*")
          .eq("deploy_id", id)
          .single();

        if (dbError || !data) {
          setError("Preview not found");
        } else {
          setDeployment(data as DeploymentData);
          if (data.expires_at) {
            const remaining = Math.max(0, Math.floor((new Date(data.expires_at).getTime() - Date.now()) / 1000));
            setCountdown(remaining);
          }
        }
      } catch {
        setError("Failed to load preview");
      } finally {
        setLoading(false);
      }
    };

    fetchDeployment();
  }, [id]);

  useEffect(() => {
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((prev) => (prev <= 0 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [countdown]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  const isExpired = deployment?.status === "expired" || deployment?.status === "killed" || countdown === 0;
  const isLive = !isExpired && (deployment?.status === "live" || deployment?.status === "running" || deployment?.status === "ready");

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied!");
  };

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      <main className="container mx-auto px-6 pt-32 pb-16 max-w-lg">
        {loading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading preview...
          </div>
        )}

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted border border-border">
              <AlertTriangle className="h-8 w-8 text-muted-foreground" />
            </div>
            <h1 className="text-2xl font-bold mb-2">{error}</h1>
            <p className="text-muted-foreground mb-8">This preview link may be invalid or the deployment was removed.</p>
            <Link to="/">
              <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                <Rocket className="h-4 w-4" />
                Deploy a new repo
              </Button>
            </Link>
          </motion.div>
        )}

        {deployment && !loading && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            {isExpired ? (
              <>
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-muted border border-border">
                  <AlertTriangle className="h-8 w-8 text-muted-foreground" />
                </div>
                <h1 className="text-2xl font-bold mb-2">This preview has expired</h1>
                <p className="text-muted-foreground mb-2">
                  <span className="font-mono font-medium text-foreground">{deployment.repo_name}</span> is no longer live.
                </p>
                <p className="text-sm text-muted-foreground mb-8">Want to spin it up again?</p>
                <Link to={`/deploy?repo=${encodeURIComponent(deployment.repo_url)}`}>
                  <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm">
                    <Rocket className="h-4 w-4" />
                    Redeploy this repo
                  </Button>
                </Link>
              </>
            ) : isLive && deployment.preview_url ? (
              <>
                <div className="rounded-xl border border-border bg-card/80 p-6 text-left mb-6">
                  <h2 className="font-mono font-semibold text-lg mb-1">{deployment.repo_name}</h2>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                    {deployment.framework && (
                      <span className="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-mono">
                        {deployment.framework}
                      </span>
                    )}
                    {deployment.language && (
                      <span className="inline-flex items-center rounded-md border border-border bg-secondary px-2 py-0.5 text-xs font-mono">
                        {deployment.language}
                      </span>
                    )}
                  </div>
                  <div className={`flex items-center gap-2 text-sm ${countdown <= 120 ? "text-warning" : "text-muted-foreground"}`}>
                    <Clock className="h-3.5 w-3.5" />
                    Expires in: <span className="font-mono font-bold">{formatTime(countdown)}</span>
                  </div>
                  {countdown <= 120 && countdown > 0 && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="mt-2 text-xs text-warning flex items-center gap-1"
                    >
                      <AlertTriangle className="h-3 w-3" /> Preview expiring soon!
                    </motion.p>
                  )}
                </div>

                <Button
                  onClick={() => window.open(deployment.preview_url!, "_blank")}
                  size="lg"
                  className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan w-full mb-3"
                >
                  <ExternalLink className="h-5 w-5" />
                  Open App
                </Button>

                <div className="flex gap-2">
                  <Button variant="outline" onClick={copyLink} className="flex-1 gap-2 border-border">
                    <Copy className="h-4 w-4" />
                    Copy Link
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (navigator.share) {
                        navigator.share({ title: deployment.repo_name, url: window.location.href });
                      } else {
                        copyLink();
                      }
                    }}
                    className="flex-1 gap-2 border-border"
                  >
                    <Share2 className="h-4 w-4" />
                    Share
                  </Button>
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                  Preview ID: <span className="font-mono">{id}</span>
                </p>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center py-10 text-muted-foreground gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Deployment in progress...
                </div>
                <p className="text-sm text-muted-foreground">
                  <span className="font-mono">{deployment.repo_name}</span> is still being built.
                </p>
              </>
            )}
          </motion.div>
        )}
      </main>
    </div>
  );
};

export default PreviewPage;