import { Link, useLocation } from "react-router-dom";
import { logout, useAuth } from "wasp/client/auth";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import logoBlack from "../../assets/brand/alfred-logo-black.svg";
import logoWhite from "../../assets/brand/alfred-logo-white.svg";
import logoBrass from "../../assets/brand/alfred-logo-brass.svg";
import { useTheme } from "../../lib/theme";

type NavItem = { to: string; label: string; icon: IconName };

// Primary, always-visible items. Kept short on purpose.
const PRIMARY: NavItem[] = [
  { to: "/desk", label: "Today", icon: "calendar" },
  { to: "/briefings", label: "Briefings", icon: "envelope" },
  { to: "/decisions", label: "Decisions", icon: "approval" },
  { to: "/matters", label: "Matters", icon: "matter" },
  { to: "/vault", label: "Vault", icon: "calling_card" },
  { to: "/files", label: "Files", icon: "envelope" },
  { to: "/channels", label: "Channels", icon: "voice" },
  { to: "/chores", label: "Chores", icon: "pocket_watch" },
  { to: "/instincts", label: "Patterns", icon: "monocle" },
];

// Everything else, behind a "More" menu.
// F84 — "Claude Setup" (/claude) folded into Settings → Agent Configuration;
// its nav entry was removed (the /claude route now redirects to /settings#agent).
// #120 Lane III — "Profiles" is the multi-profile Hermes manager; lives in
// More for now so the primary nav stays short. Switching profiles is
// UI-driven (navigate to /profiles/<slug>); per-page scoping is deferred.
const MORE: NavItem[] = [
  { to: "/connections", label: "Apps", icon: "globe" },
  { to: "/profiles", label: "Profiles", icon: "calling_card" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

// Logged-out marketing nav: the only entry points an anonymous visitor sees.
const LOGGED_OUT_PRIMARY: NavItem[] = [
  { to: "/", label: "Home", icon: "calling_card" },
];

// Demo link points at the static redesign at demo.alfred.black.
const DEMO_URL = "https://demo.alfred.black";

// Onboarding ritual pages live at /awaken → /first-brief but are NEVER shown
// in the main menu — they are only reachable while the ritual is in progress.
// Kept here as a comment so a future contributor doesn't try to add them back.
// const SETUP_PAGES = ["/awaken", "/reading-the-room", "/verify", "/soul", "/composing", "/preparing", "/first-brief"];

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className="hover:opacity-100 transition-opacity inline-flex items-center gap-1.5"
      style={{
        opacity: active ? 1 : 0.6,
        borderBottom: active ? "1px solid var(--brass)" : "1px solid transparent",
        paddingBottom: 2,
      }}
    >
      <Icon name={item.icon} size={12} style={{ color: active ? "var(--brass)" : "currentColor" }} />
      {item.label}
    </Link>
  );
}

function Wordmark({ dark }: { dark: boolean }) {
  const ink = dark ? "oklch(0.953 0.018 80)" : "var(--ink)";
  const mark = dark ? logoWhite : logoBlack;
  return (
    <Link to="/" className="flex items-center gap-3 leading-none" aria-label="Alfred Black — home">
      <img src={mark} alt="" className="h-9 w-auto" />
      <span className="block">
        <span
          className="font-display tracking-tight block"
          style={{ color: ink, fontSize: 26, lineHeight: 1 }}
        >
          Alfred<span style={{ color: "var(--brass)" }}>·</span>Black
        </span>
        <span
          className="font-mono uppercase block mt-2"
          style={{ color: "var(--brass)", fontSize: 9, letterSpacing: "0.32em", opacity: 0.8 }}
        >
          Agentic Butler
        </span>
      </span>
    </Link>
  );
}

export function Frame({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  const location = useLocation();
  const { theme } = useTheme();
  const { data: user } = useAuth();
  const isActive = (to: string) => location.pathname === to;
  const onDark = dark || theme === "dark";
  const isLoggedIn = !!user;

  return (
    <div className={`${dark ? "wool" : "paper"} min-h-screen`}>
      <header className="border-b border-rule">
        <div className="mx-auto max-w-[1280px] px-8 py-5 flex items-center justify-between gap-8">
          <Wordmark dark={onDark} />

          <nav className="font-mono text-[10px] uppercase tracking-[0.18em] font-extrabold flex items-center gap-5">
            {isLoggedIn ? (
              <>
                {PRIMARY.map((r) => (
                  <NavLink key={r.to} item={r} active={isActive(r.to)} />
                ))}

                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="inline-flex items-center gap-1.5 hover:opacity-100 transition-opacity outline-none"
                    style={{ opacity: MORE.some((m) => isActive(m.to)) ? 1 : 0.6 }}
                  >
                    More <span style={{ color: "var(--brass)" }}>+</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="font-mono text-[10px] uppercase tracking-[0.18em]">
                    <DropdownMenuLabel style={{ color: "var(--brass)" }}>Use</DropdownMenuLabel>
                    {MORE.map((r) => (
                      <DropdownMenuItem key={r.to} asChild>
                        <Link to={r.to} className="flex items-center gap-2">
                          <Icon name={r.icon} size={12} />
                          {r.label}
                        </Link>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => { logout(); }}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Icon name="skeleton_key" size={12} />
                      Log out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                {LOGGED_OUT_PRIMARY.map((r) => (
                  <NavLink key={r.to} item={r} active={isActive(r.to)} />
                ))}
                <a
                  href={DEMO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:opacity-100 transition-opacity inline-flex items-center gap-1.5"
                  style={{ opacity: 0.6, paddingBottom: 2 }}
                >
                  <Icon name="monocle" size={12} />
                  Demo
                </a>
                <Link
                  to="/login"
                  className="btn-brass"
                  style={{ fontSize: "0.7rem", padding: "0.4rem 0.9rem" }}
                >
                  Sign in →
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-rule mt-24">
        <div
          className="mx-auto max-w-[1280px] px-8 py-6 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ opacity: 0.7 }}
        >
          <span className="inline-flex items-center gap-3">
            <img src={logoBrass} alt="" className="h-4 w-auto" />
            Alfred Black — Agentic Butler
          </span>
          <span>Est. MMXXVI — by appointment</span>
        </div>
      </footer>
    </div>
  );
}

export function PageHeading({ kicker, title, lede, icon }: { kicker?: string; title: string; lede?: string; icon?: IconName }) {
  return (
    <div className="mb-12">
      {(kicker || icon) && (
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] mb-4 inline-flex items-center gap-2" style={{ color: "var(--brass)" }}>
          {icon && <Icon name={icon} size={14} />}
          {kicker}
        </div>
      )}
      <h1 className="font-display text-5xl md:text-6xl leading-[1.02] tracking-tight">{title}</h1>
      {lede && (
        <p className="font-body text-lg md:text-xl mt-5 max-w-[58ch]" style={{ color: "var(--marginalia)" }}>
          {lede}
        </p>
      )}
    </div>
  );
}
