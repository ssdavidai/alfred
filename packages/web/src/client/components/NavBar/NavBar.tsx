import { LogIn, LogOut, Menu } from "lucide-react";
import { Dispatch, SetStateAction, useState } from "react";
import { Link as ReactRouterLink } from "react-router-dom";
import { useAuth, logout } from "wasp/client/auth";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../../client/components/ui/sheet";
import { cn } from "../../utils";

export interface NavigationItem {
  name: string;
  to: string;
}

export default function NavBar({
  navigationItems,
}: {
  navigationItems: NavigationItem[];
}) {
  return (
    <header className="sticky top-0 z-50 border-b border-gold-dim/40 bg-[#0A0A0A]/80 backdrop-blur-lg">
      <nav
        className="flex items-center justify-between px-6 py-5 lg:px-8"
        aria-label="Global"
      >
        <div className="flex items-center">
          <WaspRouterLink
            to={routes.LandingPageRoute.to}
            className="transition-opacity duration-300 hover:opacity-80"
          >
            <img
              src="/images/alfred-logo.png"
              alt="ALFRED BLACK"
              className="h-6 w-auto"
            />
          </WaspRouterLink>
        </div>
        <NavBarMobileMenu navigationItems={navigationItems} />
        <NavBarDesktopUserDropdown />
      </nav>
    </header>
  );
}

function NavBarDesktopUserDropdown() {
  const { data: user, isLoading: isUserLoading } = useAuth();

  return (
    <div className="hidden items-center justify-end gap-6 lg:flex lg:flex-1">
      {isUserLoading ? null : !user ? (
        <WaspRouterLink
          to={routes.LoginRoute.to}
          className="font-mono text-[0.58rem] font-light uppercase tracking-[0.3em] text-muted-foreground transition-colors duration-300 hover:text-gold"
        >
          <div className="flex items-center">
            Log in
            <LogIn size="0.9rem" className="ml-2" />
          </div>
        </WaspRouterLink>
      ) : (
        <div className="flex items-center gap-4">
          <WaspRouterLink
            to={routes.DashboardRoute.to}
            className="bg-[#C4A265] px-6 py-2 font-mono text-[0.58rem] font-medium uppercase tracking-widest text-[#0A0A0A] transition-colors duration-300 hover:bg-[#D4B275]"
          >
            Go to Dashboard
          </WaspRouterLink>
          <button
            type="button"
            onClick={() => logout()}
            className="font-mono text-[0.58rem] font-light uppercase tracking-[0.3em] text-muted-foreground transition-colors duration-300 hover:text-gold"
          >
            Log Out
          </button>
        </div>
      )}
    </div>
  );
}

function NavBarMobileMenu({
  navigationItems,
}: {
  navigationItems: NavigationItem[];
}) {
  const { data: user, isLoading: isUserLoading } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex lg:hidden">
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center text-muted-foreground transition-colors hover:text-gold"
          >
            <span className="sr-only">Open main menu</span>
            <Menu className="size-6" aria-hidden="true" />
          </button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="w-[300px] border-l border-gold-dim/40 bg-[#0A0A0A] sm:w-[400px]"
        >
          <SheetHeader>
            <SheetTitle>
              <img
                src="/images/alfred-logo.png"
                alt="ALFRED BLACK"
                className="h-7 w-auto"
              />
            </SheetTitle>
          </SheetHeader>
          <div className="mt-8 flow-root">
            <div className="-my-6 divide-y divide-gold-dim/20">
              <ul className="space-y-2 py-6">
                {renderNavigationItems(navigationItems, setMobileMenuOpen)}
              </ul>
              <div className="space-y-3 py-6">
                {isUserLoading ? null : !user ? (
                  <WaspRouterLink to={routes.LoginRoute.to}>
                    <div className="flex items-center font-mono text-[0.58rem] uppercase tracking-[0.3em] text-[#E8E4DE] transition-colors duration-300 hover:text-gold">
                      Log in <LogIn size="0.9rem" className="ml-2" />
                    </div>
                  </WaspRouterLink>
                ) : (
                  <>
                    <WaspRouterLink
                      to={routes.DashboardRoute.to}
                      onClick={() => setMobileMenuOpen(false)}
                      className="block bg-[#C4A265] px-6 py-2 text-center font-mono text-[0.58rem] font-medium uppercase tracking-widest text-[#0A0A0A] transition-colors duration-300 hover:bg-[#D4B275]"
                    >
                      Go to Dashboard
                    </WaspRouterLink>
                    <button
                      type="button"
                      onClick={() => {
                        logout();
                        setMobileMenuOpen(false);
                      }}
                      className="flex items-center gap-2 font-mono text-[0.58rem] uppercase tracking-[0.3em] text-muted-foreground transition-colors duration-300 hover:text-gold"
                    >
                      <LogOut size="0.9rem" />
                      Log Out
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function renderNavigationItems(
  navigationItems: NavigationItem[],
  setMobileMenuOpen?: Dispatch<SetStateAction<boolean>>,
) {
  const menuStyles = cn({
    "block px-3 py-2 font-sans text-sm font-light text-[#E8E4DE] transition-colors hover:text-gold":
      !!setMobileMenuOpen,
    "font-sans text-sm font-light text-muted-foreground transition-colors duration-300 hover:text-gold":
      !setMobileMenuOpen,
  });

  return navigationItems.map((item) => {
    return (
      <li key={item.name}>
        <ReactRouterLink
          to={item.to}
          className={menuStyles}
          onClick={setMobileMenuOpen && (() => setMobileMenuOpen(false))}
          target={item.to.startsWith("http") ? "_blank" : undefined}
        >
          {item.name}
        </ReactRouterLink>
      </li>
    );
  });
}
