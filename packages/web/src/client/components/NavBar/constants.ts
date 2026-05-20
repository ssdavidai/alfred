import { routes } from "wasp/client/router";
import type { NavigationItem } from "./NavBar";

// Single-VM: no marketing pricing page. The landing page keeps its own
// in-page sections; the App NavBar carries no marketing nav links.
export const marketingNavigationItems: NavigationItem[] = [] as const;

export const dashboardNavigationItems: NavigationItem[] = [
  { name: "Desk", to: routes.DeskRoute.to },
] as const;
