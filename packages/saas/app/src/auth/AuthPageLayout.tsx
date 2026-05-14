// Door-aesthetic shell for every Wasp auth form (#851).
//
// Wraps each auth form (Login / Signup / RequestPasswordReset / PasswordReset /
// EmailVerification) in a Frame-style paper card with Playfair / EB Garamond
// typography, a brass rule, and the alfred-logo-brass mark.
//
// PostSignupPage is deliberately NOT a consumer of this layout — its
// refresh-token bounce logic is load-bearing and renders without chrome.

import { ReactNode } from "react";
import { Link as WaspRouterLink, routes } from "wasp/client/router";
import logoBrass from "../client/assets/brand/alfred-logo-brass.svg";

export function AuthPageLayout({
  children,
  title,
  subtitle,
}: {
  children: ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="paper relative flex min-h-screen items-center justify-center px-4 py-12">
      <div
        className="relative z-10 w-full max-w-md border p-10"
        style={{
          background: "var(--paper)",
          borderColor: "var(--rule)",
        }}
      >
        <div className="mb-10 flex flex-col items-center gap-5">
          <WaspRouterLink
            to={routes.LandingPageRoute.to}
            className="flex items-center gap-3 leading-none"
            aria-label="Alfred Black — home"
          >
            <img src={logoBrass} alt="" className="h-9 w-auto" />
            <span className="block">
              <span
                className="font-display tracking-tight block"
                style={{ color: "var(--ink)", fontSize: 24, lineHeight: 1 }}
              >
                Alfred<span style={{ color: "var(--brass)" }}>·</span>Black
              </span>
              <span
                className="font-mono uppercase block mt-1.5"
                style={{
                  color: "var(--brass)",
                  fontSize: 9,
                  letterSpacing: "0.32em",
                  opacity: 0.85,
                }}
              >
                By appointment
              </span>
            </span>
          </WaspRouterLink>

          <hr
            className="gilt"
            style={{ width: 80, marginTop: 4, marginBottom: 4 }}
          />

          {title && (
            <h1 className="font-display text-3xl tracking-tight text-center">
              {title}
            </h1>
          )}
          {subtitle && (
            <p
              className="font-display italic text-base text-center"
              style={{ color: "var(--marginalia)" }}
            >
              {subtitle}
            </p>
          )}
        </div>
        <div className="font-body">{children}</div>
      </div>
    </div>
  );
}
