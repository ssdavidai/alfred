import { routes } from "wasp/client/router";
import type { NavigationItem } from "./NavBar";

export const marketingNavigationItems: NavigationItem[] = [
  { name: "Pricing", to: "/#pricing" },
] as const;

export const dashboardNavigationItems: NavigationItem[] = [
  { name: "Dashboard", to: routes.DashboardRoute.to },
  { name: "Pricing", to: routes.PricingPageRoute.to },
] as const;
