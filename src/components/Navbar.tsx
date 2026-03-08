import { Link, useLocation } from "react-router-dom";
import { Github, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

const Navbar = () => {
  const location = useLocation();
  const isLanding = location.pathname === "/";

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="container mx-auto flex h-16 items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 group-hover:glow-cyan-sm transition-all">
            <Terminal className="h-4 w-4 text-primary" />
          </div>
          <span className="text-lg font-bold tracking-tight">
            Git<span className="text-primary">Preview</span>
          </span>
        </Link>

        <div className="flex items-center gap-4">
          {!isLanding && (
            <Link to="/dashboard">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                Dashboard
              </Button>
            </Link>
          )}
          <Link to="/dashboard">
            <Button variant="outline" size="sm" className="gap-2 border-border hover:border-primary/50 hover:bg-primary/5">
              <Github className="h-4 w-4" />
              Sign in with GitHub
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;
