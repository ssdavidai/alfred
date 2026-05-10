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
import { OpenclawStatusProvider } from "../shared/OpenclawStatusContext";
import { ThemeProvider } from "./lib/theme";

export default function App() {
  const location = useLocation();
  const isMarketingPage = useMemo(() => {
    return (
      location.pathname === "/" ||
      location.pathname.startsWith("/pricing") ||
      location.pathname.startsWith("/checkout")
    );
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
      location.pathname !== routes.LoginRoute.build() &&
      location.pathname !== routes.SignupRoute.build()
    );
  }, [location, isDashboard, isAdminDashboard, isSetup]);

  // Landing page already renders its own Footer — skip it there to avoid duplication
  const isLandingPage = location.pathname === "/";

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
      <OpenclawStatusProvider>
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
      </OpenclawStatusProvider>
    </ThemeProvider>
  );
}