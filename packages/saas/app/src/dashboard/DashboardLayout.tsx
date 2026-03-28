import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, logout } from "wasp/client/auth";
import { useQuery, getProvisioningStatus } from "wasp/client/operations";
import ProvisioningProgress from "../provisioning/ProvisioningProgress";
import { motion, AnimatePresence } from "framer-motion";
import {
  Home,
  Radio,
  Settings,
  Menu,
  X,
  Shield,
  LayoutDashboard,
  Sheet,
  Server,
  Cog,
  LogOut,
  Loader2,
  Brain,
  FolderTree,
} from "lucide-react";
import { cn } from "../client/utils";
import OrbBackground from "../components/ui/OrbBackground";

// ---------------------------------------------------------------------------
// Types & Nav definitions
// ---------------------------------------------------------------------------

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const dashboardNavItems: NavItem[] = [
  { path: "/dashboard", label: "Home", icon: LayoutDashboard },
  { path: "/dashboard/streams", label: "Streams", icon: Radio },
  { path: "/dashboard/vault", label: "Vault", icon: FolderTree },
  { path: "/dashboard/tasks", label: "Intelligence", icon: Brain },
  { path: "/dashboard/settings", label: "Settings", icon: Settings },
];

const adminNavItems: NavItem[] = [
  { path: "/admin", label: "Analytics", icon: Home },
  { path: "/admin/users", label: "Users", icon: Sheet },
  { path: "/admin/instances", label: "Instances", icon: Server },
  { path: "/admin/provisioning", label: "Provisioning", icon: Cog },
];

// ---------------------------------------------------------------------------
// Orb intensity per route
// ---------------------------------------------------------------------------

function getOrbIntensity(pathname: string): number {
  if (pathname === "/dashboard") return 0.7;
  if (pathname.startsWith("/dashboard/tasks") || pathname.startsWith("/dashboard/intuition")) return 0.35;
  if (pathname.startsWith("/dashboard/vault")) return 0.25;
  if (pathname.startsWith("/dashboard/streams")) return 0.35;
  if (pathname.startsWith("/dashboard/settings")) return 0.2;
  return 0.35;
}

// ---------------------------------------------------------------------------
// Collapsible Icon Rail Sidebar
// ---------------------------------------------------------------------------

function CollapsibleSidebar({
  navItems,
  adminItems,
  isActive,
}: {
  navItems: NavItem[];
  adminItems: NavItem[] | null;
  isActive: (path: string) => boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <motion.aside
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
      animate={{ width: isExpanded ? 280 : 60 }}
      transition={{ type: "spring" as const, stiffness: 200, damping: 25 }}
      className="fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-white/[0.06] bg-black/30 backdrop-blur-xl md:flex"
    >
      {/* Logo */}
      <div className="flex h-16 items-center px-4">
        <Link
          to="/"
          className="flex items-center transition-opacity duration-300 hover:opacity-80"
        >
          <img
            src="/images/alfred-logo.png"
            alt="ALFRED"
            className="h-7 w-7 object-contain"
          />
          <AnimatePresence>
            {isExpanded && (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="ml-3 font-mono text-xs font-light uppercase tracking-[0.3em] text-[#F0EDE8]"
              >
                Alfred
              </motion.span>
            )}
          </AnimatePresence>
        </Link>
      </div>

      {/* Nav icons */}
      <nav className="mt-4 flex flex-1 flex-col items-stretch gap-1 px-2">
        {navItems.map((item) => {
          const active = isActive(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200",
                active
                  ? "text-[#C9A84C]"
                  : "text-[#F0EDE8]/60 hover:text-[#C9A84C]",
              )}
            >
              {/* Active indicator */}
              {active && (
                <motion.div
                  layoutId="sidebar-active"
                  className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#C9A84C]"
                  transition={{ type: "spring" as const, stiffness: 300, damping: 25 }}
                />
              )}
              <item.icon className="h-5 w-5 flex-shrink-0" />
              <AnimatePresence>
                {isExpanded && (
                  <motion.span
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -10 }}
                    transition={{ duration: 0.15 }}
                    className="whitespace-nowrap font-sans text-sm font-light"
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </Link>
          );
        })}

        {/* Admin section */}
        {adminItems && (
          <>
            <div className="mx-3 my-3 border-t border-white/[0.06]" />
            {isExpanded && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mb-1 flex items-center gap-2 px-3"
              >
                <Shield className="h-3 w-3 text-[#8A8680]" />
                <span className="font-mono text-[0.55rem] font-light uppercase tracking-[0.2em] text-[#8A8680]">
                  Admin
                </span>
              </motion.div>
            )}
            {adminItems.map((item) => {
              const active = isActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 transition-all duration-200",
                    active
                      ? "text-[#C9A84C]"
                      : "text-[#F0EDE8]/60 hover:text-[#C9A84C]",
                  )}
                >
                  {active && (
                    <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-[#C9A84C]" />
                  )}
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.span
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        transition={{ duration: 0.15 }}
                        className="whitespace-nowrap font-sans text-sm font-light"
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Link>
              );
            })}
          </>
        )}
      </nav>

      {/* Logout at bottom */}
      <div className="px-2 pb-4">
        <button
          type="button"
          onClick={() => logout()}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[#F0EDE8]/40 transition-colors duration-200 hover:text-[#F0EDE8]/70"
        >
          <LogOut className="h-5 w-5 flex-shrink-0" />
          <AnimatePresence>
            {isExpanded && (
              <motion.span
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="whitespace-nowrap font-mono text-[0.6rem] font-light uppercase tracking-[0.2em]"
              >
                Log Out
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      </div>
    </motion.aside>
  );
}

// ---------------------------------------------------------------------------
// Mobile sidebar (full overlay, preserved from original)
// ---------------------------------------------------------------------------

function MobileSidebar({
  navItems,
  adminItems,
  isActive,
  isOpen,
  onClose,
}: {
  navItems: NavItem[];
  adminItems: NavItem[] | null;
  isActive: (path: string) => boolean;
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      {/* Sidebar panel */}
      <aside className="absolute inset-y-0 left-0 w-64 border-r border-white/[0.06] bg-black/90 backdrop-blur-xl">
        <div className="flex items-center justify-between p-6">
          <Link
            to="/"
            onClick={onClose}
            className="transition-opacity duration-300 hover:opacity-80"
          >
            <img
              src="/images/alfred-logo.png"
              alt="ALFRED"
              className="h-5 w-auto"
            />
          </Link>
          <button
            type="button"
            onClick={onClose}
            className="text-[#E8E4DE] transition-colors hover:text-[#C9A84C]"
          >
            <span className="sr-only">Close menu</span>
            <X className="h-4 w-4" />
          </button>
        </div>
        <nav className="mt-4 space-y-1 px-3">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 rounded-sm px-3 py-2 font-sans text-sm font-light transition-all duration-200",
                isActive(item.path)
                  ? "border-l-2 border-[#C9A84C] bg-[#C9A84C]/5 text-[#C9A84C]"
                  : "text-[#8A8680] hover:bg-[#C9A84C]/5 hover:text-[#E8E4DE]",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        {adminItems && (
          <nav className="mt-6 px-3">
            <div className="mb-2 flex items-center gap-2 px-3">
              <Shield className="h-3 w-3 text-[#8A8680]" />
              <span className="font-mono text-[0.6rem] font-light uppercase tracking-[0.2em] text-[#8A8680]">
                Admin
              </span>
            </div>
            <div className="space-y-1">
              {adminItems.map((item) => (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={onClose}
                  className={cn(
                    "flex items-center gap-3 rounded-sm px-3 py-2 font-sans text-sm font-light transition-all duration-200",
                    isActive(item.path)
                      ? "border-l-2 border-[#C9A84C] bg-[#C9A84C]/5 text-[#C9A84C]"
                      : "text-[#8A8680] hover:bg-[#C9A84C]/5 hover:text-[#E8E4DE]",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Layout
// ---------------------------------------------------------------------------

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: user } = useAuth();
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const isAdminPage = location.pathname.startsWith("/admin");
  const { data: provStatus, isLoading: provLoading } = useQuery(
    getProvisioningStatus,
    undefined,
    {
      enabled: !isAdminPage,
      refetchInterval: 3000,
    },
  );
  const instanceReady = provStatus?.instance?.status === "running";

  const isActive = (path: string) => {
    if (path === "/dashboard") return location.pathname === "/dashboard";
    if (path === "/admin") return location.pathname === "/admin";
    return location.pathname.startsWith(path);
  };

  const adminItems = user?.isAdmin ? adminNavItems : null;
  const orbIntensity = getOrbIntensity(location.pathname);

  return (
    <div className="min-h-screen bg-transparent">
      {/* Persistent orb background */}
      <div className="fixed inset-0 z-0">
        <OrbBackground intensity={orbIntensity} />
      </div>

      {/* Content layer */}
      <div className="relative z-10 flex min-h-screen">
        {/* Desktop collapsible sidebar */}
        <CollapsibleSidebar
          navItems={dashboardNavItems}
          adminItems={adminItems}
          isActive={isActive}
        />

        {/* Mobile header */}
        <header className="fixed left-0 right-0 top-0 z-40 flex items-center justify-between border-b border-white/[0.06] bg-black/50 px-4 py-3 backdrop-blur-xl md:hidden">
          <Link
            to="/"
            className="transition-opacity duration-300 hover:opacity-80"
          >
            <img
              src="/images/alfred-logo.png"
              alt="ALFRED"
              className="h-6 w-auto"
            />
          </Link>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="text-[#E8E4DE] transition-colors hover:text-[#C9A84C]"
          >
            <span className="sr-only">Open menu</span>
            <Menu className="h-5 w-5" />
          </button>
        </header>

        {/* Mobile sidebar overlay */}
        <MobileSidebar
          navItems={dashboardNavItems}
          adminItems={adminItems}
          isActive={isActive}
          isOpen={mobileMenuOpen}
          onClose={() => setMobileMenuOpen(false)}
        />

        {/* Main content area */}
        <main className="ml-0 flex-1 pt-14 md:ml-[60px] md:pt-0">
          <div className="p-6 lg:p-8">
            {isAdminPage ? (
              children
            ) : provLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-[#C9A84C]" />
              </div>
            ) : instanceReady ? (
              children
            ) : (
              <ProvisioningProgress
                data={provStatus ?? null}
                isLoading={provLoading}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
