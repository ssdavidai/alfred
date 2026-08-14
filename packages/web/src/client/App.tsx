import { useEffect, useMemo } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { routes } from "wasp/client/router";
import { Toaster } from "../client/components/ui/toaster";
import "./Main.css";
import NavBar from "./components/NavBar/NavBar";
import Footer from "../landing-page/components/Footer";
import {
  marketingNavigationItems,
  dashboardNavigationItems,
} from "./components/NavBar/constants";
import CookieConsentBanner from "./components/cookie-consent/Banner";
import { ThemeProvider } from "./lib/theme";

export default function App() {
  const location = useLocation();
  const isMarketingPage = useMemo(() => {
    return location.pathname === "/";
  }, [location]);

  // Pages that bring their own Frame (header + footer) — App-level
  // NavBar/Footer must be suppressed to avoid double chrome.
  // All Alfred Black 1.0 canonical surfaces are framed; legacy /dashboard/*
  // and /admin/* still use the App-level chrome until they're migrated.
  const isFramedPage = useMemo(() => {
    const p = location.pathname;
    if (p === "/") return true;
    // Marketing
    if (
      p === "/companion" ||
      p === "/voice" ||
      p === "/sms" ||
      p === "/voice-and-tone"
    ) return true;
    // Onboarding ritual (M2 #852/#853)
    if (
      p === "/awaken" ||
      p === "/reading-the-room" ||
      p === "/composing" ||
      p === "/preparing" ||
      p === "/verify" ||
      p === "/soul" ||
      p === "/first-brief"
    ) return true;
    // Household editor (M2 #854)
    if (p === "/household") return true;
    // Daily core (M3)
    if (p === "/desk" || p === "/brief") return true;
    // Briefings index (state-mutation Phase E #893)
    if (p === "/briefings") return true;
    // Knowledge surfaces (M4)
    if (
      p === "/vault" ||
      p === "/matters" ||
      p.startsWith("/matters/") ||
      p === "/instincts" ||
      p === "/decisions" ||
      p === "/chores" ||
      p.startsWith("/chores/")
    ) return true;
    // Operating surfaces (M5)
    if (
      p === "/connections" ||
      p === "/connect" ||
      p === "/channels" ||
      p === "/tools" ||
      p === "/claude" ||
      p === "/attention"
    ) return true;
    // Settings (formerly The Study, M6; renamed /study → /settings, F83).
    // /study is kept as a recognised surface for the brief redirect render.
    if (p === "/settings" || p === "/study") return true;
    return false;
  }, [location]);

  const isDashboard = useMemo(() => {
    return location.pathname.startsWith("/dashboard");
  }, [location]);

  const isAdminDashboard = useMemo(() => {
    return location.pathname.startsWith("/admin");
  }, [location]);

  const isSetup = useMemo(() => {
    return location.pathname.startsWith("/setup");
  }, [location]);

  const navigationItems = isMarketingPage
    ? marketingNavigationItems
    : dashboardNavigationItems;

  const shouldDisplayAppNavBar = useMemo(() => {
    return (
      !isDashboard &&
      !isAdminDashboard &&
      !isSetup &&
      !isFramedPage &&
      location.pathname !== routes.LoginRoute.build() &&
      location.pathname !== routes.SignupRoute.build()
    );
  }, [location, isDashboard, isAdminDashboard, isSetup, isFramedPage]);

  // Framed pages render their own Frame footer — skip the App-level Footer
  // to avoid duplication. (Was previously hardcoded to just `/`.)
  const isLandingPage = isFramedPage;

  useEffect(() => {
    if (location.hash) {
      const id = location.hash.replace("#", "");
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView();
      }
    }
  }, [location]);

  return (
    <ThemeProvider>
      <div className="min-h-screen bg-background text-foreground flex flex-col">
        {isAdminDashboard ? (
          <div className="flex-1"><Outlet /></div>
        ) : isDashboard || isSetup ? (
          <div className="flex-1"><Outlet /></div>
        ) : (
          <>
            {shouldDisplayAppNavBar && (
              <NavBar navigationItems={navigationItems} />
            )}
            <div className="flex-1"><Outlet /></div>
          </>
        )}
        {!isLandingPage && <Footer />}
      </div>
      <Toaster position="bottom-right" />
      <CookieConsentBanner />
    </ThemeProvider>
  );
}