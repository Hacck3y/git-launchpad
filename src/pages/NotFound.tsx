import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { motion } from "framer-motion";
import { Terminal, ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-grid-pattern px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center max-w-md"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: "spring", stiffness: 200 }}
          className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20"
        >
          <Terminal className="h-10 w-10 text-primary" />
        </motion.div>

        <h1 className="text-7xl font-extrabold text-primary text-glow mb-2">404</h1>
        <p className="text-xl font-semibold mb-2">Page not found</p>
        <p className="text-muted-foreground mb-8">
          The route <code className="font-mono text-sm bg-muted px-2 py-0.5 rounded">{location.pathname}</code> doesn't exist.
        </p>

        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            onClick={() => window.history.back()}
            className="gap-2 border-border hover:border-primary/50"
          >
            <ArrowLeft className="h-4 w-4" />
            Go Back
          </Button>
          <Link to="/">
            <Button className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90 glow-cyan-sm">
              <Home className="h-4 w-4" />
              Home
            </Button>
          </Link>
        </div>
      </motion.div>
    </div>
  );
};

export default NotFound;