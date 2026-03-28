import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth, logout } from "wasp/client/auth";
import { useQuery, getProvisioningStatus } from "wasp/client/operations";
import ProvisioningProgress from "../provisioning/ProvisioningProgress";
import { motion } from "framer-motion";
import {
  Home,
  FolderOpen,
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
} from "lucide-react";
import { cn } from "../client/utils";

interface NavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const dashboardNavItems: NavItem[] = [
  { path: "/dashboard", label: "Home", icon: Home },
  { path: "/dashboard/streams", label: "Integrations", icon: Radio },
  { path: "/dashboard/vault", label: "Vault", icon: FolderOpen },
  { path: "/dashboard/tasks", label: "Intelligence", icon: Brain },
  { path: "/dashboard/settings", label: "Settings", icon: Settings },
];

const adminNavItems: NavItem[] = [
  { path: "/admin", label: "Analytics", icon: LayoutDashboard },
  { path: "/admin/users", label: "Users", icon: Sheet },
  { path: "/admin/instances", label: "Instances", icon: Server },
  { path: "/admin/provisioning", label: "Provisioning", icon: Cog },
];

function NavLink({
  item,
  isActive,
  onClick,
}: {
  item: NavItem;
  isActive: boolean;
  onClick?: () => void;
}) {
  return (
    <motion.div
      whileHover={{ x: 4 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
    >
      <Link
        to={item.path}
        onClick={onClick}
        className={cn(
          "flex items-center gap-3 rounded-sm px-3 py-2 font-sans text-sm font-light transition-all duration-200",
          isActive
            ? "border-l-2 border-[#C9A84C] bg-[#C9A84C]/5 text-[#C9A84C]"
            : "text-[#8A8680] hover:bg-[#C9A84C]/5 hover:text-[#E8E4DE]",
        )}
      >
        <item.icon className="h-4 w-4" />
        {item.label}
      </Link>
    </motion.div>
  );
}

function SidebarNav({
  navItems,
  adminItems,
  isActive,
  onClick,
}: {
  navItems: NavItem[];
  adminItems: NavItem[] | null;
  isActive: (path: string) => boolean;
  onClick?: () => void;
}) {
  return (
    <>
      <nav className="mt-4 space-y-1 px-3">
        {navItems.map((item, i) => (
          <motion.div
            key={item.path}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.05 * i, duration: 0.3, ease: "easeOut" }}
          >
            <NavLink
              item={item}
              isActive={isActive(item.path)}
              onClick={onClick}
            />
          </motion.div>
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
            {adminItems.map((item, i) => (
              <motion.div
                key={item.path}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: 0.05 * (navItems.length + i),
                  duration: 0.3,
                  ease: "easeOut",
                }}
              >
                <NavLink
                  item={item}
                  isActive={isActive(item.path)}
                  onClick={onClick}
                />
              </motion.div>
            ))}
          </div>
        </nav>
      )}
    </>
  );
}

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

  return (
    <div className="flex min-h-screen bg-[#0A0A0A]">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 border-r border-gold-dim/40 bg-[#0A0A0A] md:block">
        <div className="p-6">
          <Link
            to="/"
            className="transition-opacity duration-300 hover:opacity-80"
          >
            <img
              src="/images/alfred-logo.png"
              alt="ALFRED"
              className="h-5 w-auto"
            />
          </Link>
        </div>
        <SidebarNav
          navItems={dashboardNavItems}
          adminItems={adminItems}
          isActive={isActive}
        />
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-auto">
        {/* Mobile header */}
        <header className="sticky top-0 z-40 flex items-center justify-between border-b border-gold-dim/40 bg-[#0A0A0A]/95 px-4 py-3 backdrop-blur-sm md:hidden">
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
            className="text-[#E8E4DE] transition-colors hover:text-gold"
          >
            <span className="sr-only">Open menu</span>
            <Menu className="h-5 w-5" />
          </button>
        </header>

        {/* Desktop top bar */}
        {user && (
          <header className="sticky top-0 z-30 hidden items-center justify-end border-b border-gold-dim/40 bg-[#0A0A0A]/95 px-6 py-3 backdrop-blur-sm md:flex">
            <button
              type="button"
              onClick={() => logout()}
              className="flex items-center gap-2 font-mono text-[0.58rem] font-light uppercase tracking-[0.3em] text-muted-foreground transition-colors duration-300 hover:text-gold"
            >
              <LogOut className="h-4 w-4" />
              Log Out
            </button>
          </header>
        )}

        {/* Mobile sidebar overlay */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setMobileMenuOpen(false)}
            />
            {/* Sidebar panel */}
            <aside className="absolute inset-y-0 left-0 w-64 border-r border-gold-dim/40 bg-[#0A0A0A]">
              <div className="flex items-center justify-between p-6">
                <Link
                  to="/"
                  onClick={() => setMobileMenuOpen(false)}
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
                  onClick={() => setMobileMenuOpen(false)}
                  className="text-[#E8E4DE] transition-colors hover:text-gold"
                >
                  <span className="sr-only">Close menu</span>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <SidebarNav
                navItems={dashboardNavItems}
                adminItems={adminItems}
                isActive={isActive}
                onClick={() => setMobileMenuOpen(false)}
              />
            </aside>
          </div>
        )}

        <main className="flex-1">
          <div className="p-6 lg:p-8">
            {isAdminPage ? (
              children
            ) : provLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-gold" />
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
