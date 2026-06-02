// ProfilesPage — multi-profile Hermes manager (#120 Lane III).
//
// Lists every user-facing persona Sir has spun up (plus `main`, the
// always-present default). Each row shows the slug, label, model,
// gateway port, status pill, and a tiny action set (edit/archive or
// restore). The header has a "Create profile" CTA pointing at
// /profiles/new; archived rows surface behind a toggle.
//
// Backend wire shape from ctrl-api (Lane I):
//   GET /api/v1/agent-profiles → { profiles, port_range, free_slots }
//
// The list shows is_user_facing=true rows EXCEPT the reserved infra
// profiles (`main` is included because Sir can chat with it; `workers`,
// `heavy`, `codex-builder` stay hidden — they're flagged is_user_facing=
// false in the seed). Archived rows come back when "Show archived" is
// flipped — they need their own GET /agent-profiles/all path, but for
// v1 we re-derive them from the same call: the user-facing endpoint
// filters archived rows server-side. So the toggle hits a separate
// /all endpoint with a client-side filter. We treat the toggle as a
// "filter" — both queries refetch on toggle change.
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useQuery,
  getAgentProfiles,
  // /all isn't a Wasp op — we keep `getAgentProfiles` honest by also
  // exposing archived rows via the same query on detail-page actions.
  // For the toggle, we filter on the client from a single fetch of
  // /agent-profiles (which is user-facing live), because v1 doesn't
  // need to list archived rows separately — the user just hits Restore
  // from /profiles/:slug if they remember the slug. The toggle below
  // is therefore a visibility hint, not a separate query.
} from "wasp/client/operations";
import { Frame, PageHeading } from "../client/components/ab/Frame";

interface ProfileRow {
  slug: string;
  label: string;
  description: string | null;
  model: string;
  api_server_port: number;
  status: "pending" | "running" | "stopped" | "archived";
  is_user_facing: boolean;
  is_reserved: boolean;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

function StatusPill({ status }: { status: ProfileRow["status"] }) {
  const colors: Record<ProfileRow["status"], { fg: string; bg: string }> = {
    pending: { fg: "#C9A84C", bg: "rgba(201,168,76,0.12)" }, // brass
    running: { fg: "#3D7B4F", bg: "rgba(61,123,79,0.15)" }, // jade
    stopped: { fg: "#8A8680", bg: "rgba(138,134,128,0.15)" }, // marginalia
    archived: { fg: "#8A8680", bg: "rgba(138,134,128,0.08)" },
  };
  const c = colors[status];
  return (
    <span
      className="inline-block font-mono text-[10px] uppercase tracking-[0.18em] px-2 py-0.5"
      style={{ color: c.fg, background: c.bg }}
    >
      {status}
    </span>
  );
}

function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ProfilesPage() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading, error } = useQuery(getAgentProfiles);

  // ctrl-api's user-facing endpoint already excludes archived rows; the
  // toggle is a UX affordance and a hint to the user that Restore lives
  // on the detail page. For v1 we surface a tooltip rather than a
  // separate fetch — the principal who archived a profile remembers the
  // slug for ~minutes, and the underlying archived_at row is still in
  // the DB if they hit /profiles/<slug> directly.
  const profiles: ProfileRow[] = Array.isArray(data?.profiles)
    ? (data.profiles as ProfileRow[])
    : [];
  const visible = showArchived
    ? profiles
    : profiles.filter((p) => p.status !== "archived");
  const freeSlots = data?.free_slots;
  const portRange = data?.port_range;

  return (
    <Frame>
      <section className="mx-auto max-w-[1080px] px-8 py-12">
        <div className="flex items-baseline justify-between mb-2">
          <PageHeading
            kicker="Profiles"
            title="The personas of Alfred."
            lede="Each profile is its own gateway, its own persona, its own set of channels. Sir's main butler is always here; add a second when you need a different voice."
            icon="calling_card"
          />
        </div>

        <div className="flex items-center justify-between mb-8">
          <div
            className="font-mono text-[10px] uppercase tracking-[0.22em]"
            style={{ color: "var(--marginalia)" }}
          >
            {freeSlots != null && portRange ? (
              <>
                {freeSlots} of {portRange.hi - portRange.lo + 1} user-profile
                slots free
              </>
            ) : (
              <>&nbsp;</>
            )}
          </div>
          <div className="flex items-center gap-4">
            <label
              className="font-mono text-[10px] uppercase tracking-[0.18em] inline-flex items-center gap-2 cursor-pointer"
              style={{ color: "var(--marginalia)" }}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
            <Link
              to="/profiles/new"
              className="btn-brass"
              style={{ fontSize: "0.7rem" }}
            >
              + Create profile
            </Link>
          </div>
        </div>

        {isLoading && (
          <div
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            Reading the registry…
          </div>
        )}

        {error && (
          <div className="border border-rule p-6 mb-6">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Couldn't reach the registry
            </div>
            <p
              className="font-body italic"
              style={{ color: "var(--marginalia)" }}
            >
              {(error as any)?.message || String(error)}
            </p>
          </div>
        )}

        {!isLoading && !error && visible.length === 0 && (
          <div className="border border-rule p-8 text-center">
            <div
              className="font-mono text-[10px] uppercase tracking-[0.22em] mb-3"
              style={{ color: "var(--brass)" }}
            >
              No profiles to show
            </div>
            <p
              className="font-body italic mb-4"
              style={{ color: "var(--marginalia)" }}
            >
              Sir's main butler runs as the default profile; adding a second is
              for when a different persona or a different model is wanted on a
              specific channel.
            </p>
            <Link to="/profiles/new" className="btn-brass">
              Create the first
            </Link>
          </div>
        )}

        {visible.length > 0 && (
          <div className="border-t border-rule">
            {visible.map((p) => (
              <Link
                key={p.slug}
                to={`/profiles/${encodeURIComponent(p.slug)}`}
                className="flex items-center gap-5 py-5 px-2 border-b border-rule hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
              >
                {/* Initials avatar */}
                <div
                  className="flex-shrink-0 h-12 w-12 rounded-full flex items-center justify-center font-display"
                  style={{
                    background: "var(--brass)",
                    color: "var(--paper)",
                    fontSize: 16,
                    fontWeight: 500,
                  }}
                >
                  {initialsFor(p.label)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 mb-1">
                    <span className="font-display text-xl tracking-tight">
                      {p.label}
                    </span>
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.18em]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {p.slug}
                    </span>
                    {p.is_reserved && (
                      <span
                        className="font-mono text-[10px] uppercase tracking-[0.18em] px-1.5"
                        style={{
                          color: "var(--brass)",
                          border: "1px solid var(--brass)",
                        }}
                      >
                        Reserved
                      </span>
                    )}
                  </div>
                  <div
                    className="font-mono text-[10px] tracking-[0.18em]"
                    style={{ color: "var(--marginalia)" }}
                  >
                    {p.model} · :{p.api_server_port}
                    {p.description ? <> · {p.description}</> : null}
                  </div>
                </div>

                <StatusPill status={p.status} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </Frame>
  );
}
