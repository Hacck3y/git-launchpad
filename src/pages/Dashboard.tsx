import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Plus, ExternalLink, Copy, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import Navbar from "@/components/Navbar";

interface Deployment {
  id: string;
  repoName: string;
  repoUrl: string;
  status: "live" | "expired" | "deploying";
  previewUrl: string;
  timeRemaining: string;
  createdAt: string;
}

const mockDeployments: Deployment[] = [
  {
    id: "1",
    repoName: "facebook/react",
    repoUrl: "https://github.com/facebook/react",
    status: "live",
    previewUrl: "https://preview-abc123.gitpreview.dev",
    timeRemaining: "12:34",
    createdAt: "2 min ago",
  },
  {
    id: "2",
    repoName: "vercel/next.js",
    repoUrl: "https://github.com/vercel/next.js",
    status: "live",
    previewUrl: "https://preview-def456.gitpreview.dev",
    timeRemaining: "08:12",
    createdAt: "7 min ago",
  },
  {
    id: "3",
    repoName: "tailwindlabs/tailwindcss",
    repoUrl: "https://github.com/tailwindlabs/tailwindcss",
    status: "expired",
    previewUrl: "https://preview-ghi789.gitpreview.dev",
    timeRemaining: "—",
    createdAt: "1 hour ago",
  },
];

const Dashboard = () => {
  const [deployments] = useState<Deployment[]>(mockDeployments);
  const deploysUsed = 3;
  const maxDeploys = 5;

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success("Link copied to clipboard");
  };

  const statusConfig = {
    live: { label: "Live", icon: CheckCircle2, className: "text-success" },
    expired: { label: "Expired", icon: XCircle, className: "text-muted-foreground" },
    deploying: { label: "Deploying", icon: Clock, className: "text-warning" },
  };

  return (
    <div className="min-h-screen bg-background bg-grid-pattern">
      <Navbar />

      <main className="container mx-auto px-6 pt-28 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="text-3xl font-bold">Dashboard</h1>
              <p className="mt-1 text-muted-foreground">Manage your preview deployments</p>
            </div>
            <Link to="/deploy">
              <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm">
                <Plus className="h-4 w-4" />
                New Preview
              </Button>
            </Link>
          </div>

          {/* Deploy counter */}
          <div className="mb-8 rounded-xl border border-border bg-card/50 p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">Free deploys</span>
              <span className="text-sm font-mono text-primary">
                {deploysUsed} of {maxDeploys} used
              </span>
            </div>
            <Progress value={(deploysUsed / maxDeploys) * 100} className="h-2" />
            <p className="mt-2 text-xs text-muted-foreground">
              {maxDeploys - deploysUsed} deploys remaining on free tier
            </p>
          </div>

          {/* Deployments table */}
          <div className="rounded-xl border border-border bg-card/50 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-6 py-3 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
              <span>Repository</span>
              <span>Status</span>
              <span>Time Left</span>
              <span>Actions</span>
            </div>

            {deployments.map((deploy, i) => {
              const status = statusConfig[deploy.status];
              const StatusIcon = status.icon;

              return (
                <motion.div
                  key={deploy.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-6 py-4 border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <div>
                    <p className="font-mono text-sm font-medium">{deploy.repoName}</p>
                    <p className="text-xs text-muted-foreground">{deploy.createdAt}</p>
                  </div>

                  <div className={`flex items-center gap-1.5 text-sm ${status.className}`}>
                    <StatusIcon className="h-3.5 w-3.5" />
                    {status.label}
                  </div>

                  <span className="text-sm font-mono text-muted-foreground">
                    {deploy.status === "live" ? deploy.timeRemaining : "—"}
                  </span>

                  <div className="flex items-center gap-2">
                    {deploy.status === "live" && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs hover:text-primary"
                          onClick={() => window.open(deploy.previewUrl, "_blank")}
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Open
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs hover:text-primary"
                          onClick={() => copyLink(deploy.previewUrl)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Share
                        </Button>
                      </>
                    )}
                    {deploy.status === "expired" && (
                      <Link to={`/deploy?repo=${encodeURIComponent(deploy.repoUrl)}`}>
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
        </motion.div>
      </main>
    </div>
  );
};

export default Dashboard;
