// HaConversationSetupCard — /channels card for Issue #111 PR3.
//
// Documentation-first surface: the principal installs the
// `ssdavidai/alfred-ha` HACS custom component into their Home Assistant
// install, configures it with the tenant URL + a channel token they
// mint here, and HA's Assist pipeline forwards conversation turns to
// Alfred via POST /api/v1/channels/ha/turn. There are NO new ctrl-api
// routes in PR3; the runtime is owned by #111 PR1 (the channel-token
// table + the /turn route) and PR4 (operator-facing mint UI). What
// this card adds is the install ritual + a table of the persisted
// tokens.
//
// Read shape — `getHaInstalledTokens` proxies to
//   GET /api/v1/channel-tokens?channel=ha-conversation
// (which lands in PR #111 PR1). The mint + revoke actions proxy to
// the same surface; both 404-fall-through to a "Coming in PR4" panel
// so the card never breaks the page on a tenant that hasn't pulled
// PR1's image.

import { useState } from "react";
import {
  useQuery,
  getHaInstalledTokens,
  mintHaChannelToken,
  revokeChannelToken,
} from "wasp/client/operations";
import {
  buildHacsRepoUrl,
  parseHaInstallId,
  summariseInstalledHaTokens,
  truncateInstallId,
  formatLastUsed,
  type ChannelTokenRow,
} from "./haConversationCardCore";

interface TokensResponse {
  tokens: ChannelTokenRow[];
  /** Set when ctrl-api 404s the read endpoint (tenant hasn't pulled
   *  the image yet). The card surfaces an explanatory empty state. */
  unavailable?: boolean;
}

interface MintResponse {
  token: string;
  meta?: { id?: string };
}

export function HaConversationSetupCard() {
  const { data: tokensData, refetch } = useQuery(
    getHaInstalledTokens,
    undefined,
    { retry: false },
  );
  const resp = (tokensData as TokensResponse | undefined) ?? null;
  const summary = summariseInstalledHaTokens(resp?.tokens ?? []);
  const surfaceAvailable = !(resp?.unavailable === true);

  // Mint form state.
  const [installInput, setInstallInput] = useState("");
  const [mintBusy, setMintBusy] = useState(false);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<{
    raw: string;
    installId: string;
  } | null>(null);

  // Per-token revoke spinner.
  const [revokeBusy, setRevokeBusy] = useState<Set<string>>(new Set());

  // Copy-to-clipboard transient state.
  const [copiedRepo, setCopiedRepo] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  function copyRepo() {
    navigator.clipboard?.writeText(buildHacsRepoUrl());
    setCopiedRepo(true);
    setTimeout(() => setCopiedRepo(false), 1500);
  }

  function copyToken() {
    if (!revealedToken) return;
    navigator.clipboard?.writeText(revealedToken.raw);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 1500);
  }

  async function mint() {
    setMintErr(null);
    const installId = parseHaInstallId(installInput);
    if (!installId) {
      setMintErr(
        "Install ID must be a uuid v4 or a slug (a-zA-Z0-9_-, 8 – 64 chars).",
      );
      return;
    }
    setMintBusy(true);
    try {
      const r = (await mintHaChannelToken({
        installId,
        label: `ha:${installId}`,
      })) as MintResponse;
      if (typeof r?.token === "string") {
        setRevealedToken({ raw: r.token, installId });
        setInstallInput("");
        await refetch();
      } else {
        setMintErr("ctrl-api accepted the mint but returned no token.");
      }
    } catch (e: any) {
      setMintErr(
        e?.message ??
          e?.data?.message ??
          "Mint failed — check the install ID and try again.",
      );
    } finally {
      setMintBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevokeBusy((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    try {
      await revokeChannelToken({ id });
      await refetch();
    } catch (e: any) {
      // The page-level error surface is the toast we'd add in a
      // future polish — for now log + reload so the UI doesn't lie.
      console.error("revoke channel token failed", e);
    } finally {
      setRevokeBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // Render the card body via the shared ChannelCard wrapper. The
  // wrapper lives in ChannelsPage.tsx; we don't import it here to
  // keep this file small + tree-shake-friendly — instead we render
  // the same visual envelope inline. The two visible "address" lines
  // mirror what ChannelCard surfaces.
  const haPill = surfaceAvailable && summary.installs.length > 0;

  return (
    <div className="border border-rule p-6 card-hover h-full">
      {/* Card header — same shape as ChannelCard. */}
      <div className="flex items-baseline justify-between mb-3">
        <span className="font-display text-3xl">Voice → HA → Alfred</span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
          style={{ color: haPill ? "var(--brass)" : "var(--marginalia)" }}
        >
          {haPill ? "Connected" : "Setup"}
        </span>
      </div>
      <div
        className="font-mono text-[12px] mb-3"
        style={{ color: "var(--ink)" }}
      >
        {surfaceAvailable
          ? summary.installs.length === 0
            ? "No HA installs paired yet"
            : `${summary.installs.length} HA install${summary.installs.length === 1 ? "" : "s"} paired`
          : "Channel-token surface not deployed yet"}
      </div>
      <div className="font-body italic" style={{ color: "var(--marginalia)" }}>
        Pipe Home Assistant's Assist conversations to Alfred — same memory, in
        the kitchen.
      </div>

      {/* Numbered three-step ritual. */}
      <div className="mt-6 space-y-5">
        <StepBlock
          n={1}
          title="Install the HACS custom repository"
          body={
            <>
              <p
                className="font-body text-[13px]"
                style={{ color: "var(--marginalia)" }}
              >
                In Home Assistant: HACS → ⋮ → Custom repositories → paste below,
                category "Integration".
              </p>
              <div className="flex items-center gap-2 mt-2">
                <code
                  className="flex-1 font-mono text-[11px] border border-rule p-2 truncate"
                  style={{ color: "var(--ink)" }}
                >
                  {buildHacsRepoUrl()}
                </code>
                <button onClick={copyRepo} className="btn-ghost">
                  {copiedRepo ? "Copied" : "Copy"}
                </button>
                <a
                  href={buildHacsRepoUrl()}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost"
                >
                  Open README →
                </a>
              </div>
            </>
          }
        />

        <StepBlock
          n={2}
          title="Add the integration"
          body={
            <p
              className="font-body text-[13px]"
              style={{ color: "var(--marginalia)" }}
            >
              In HA: Settings → Devices &amp; Services → Add Integration →{" "}
              <strong>Alfred Black</strong>. Supply your tenant base URL and the
              channel token you mint in step 3.
            </p>
          }
        />

        <StepBlock
          n={3}
          title="Mint a channel token"
          body={
            surfaceAvailable ? (
              <div className="space-y-3">
                <p
                  className="font-body text-[13px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  Give this HA install an ID (a uuid or a slug like{" "}
                  <code>home-kitchen</code>) — that's how Alfred recognises the
                  install on later requests.
                </p>
                <div className="flex gap-2 items-baseline">
                  <input
                    type="text"
                    value={installInput}
                    onChange={(e) => setInstallInput(e.target.value)}
                    placeholder="home-kitchen"
                    className="flex-1 bg-transparent border border-rule px-2 py-1 font-mono text-[12px]"
                  />
                  <button
                    onClick={mint}
                    disabled={mintBusy || !installInput.trim()}
                    className="btn-ghost"
                  >
                    {mintBusy ? "…" : "Mint token"}
                  </button>
                </div>
                {mintErr && (
                  <p
                    className="font-body italic text-[12px]"
                    style={{ color: "var(--brass)" }}
                  >
                    {mintErr}
                  </p>
                )}
                {revealedToken && (
                  <div
                    className="border border-rule p-3 space-y-2"
                    style={{ borderColor: "var(--brass)" }}
                  >
                    <div
                      className="font-mono text-[10px] uppercase tracking-[0.22em]"
                      style={{ color: "var(--brass)" }}
                    >
                      One-time reveal — copy now
                    </div>
                    <div className="flex items-center gap-2">
                      <code
                        className="flex-1 font-mono text-[11px] truncate"
                        style={{ color: "var(--ink)" }}
                      >
                        {revealedToken.raw}
                      </code>
                      <button onClick={copyToken} className="btn-ghost">
                        {copiedToken ? "Copied" : "Copy"}
                      </button>
                      <button
                        onClick={() => setRevealedToken(null)}
                        className="btn-ghost"
                      >
                        Hide
                      </button>
                    </div>
                    <p
                      className="font-body italic text-[12px]"
                      style={{ color: "var(--marginalia)" }}
                    >
                      Paste this into the HA integration's "Channel token"
                      field for install <code>{revealedToken.installId}</code>.
                      We never store it again.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div
                className="border border-rule p-3"
                style={{ color: "var(--marginalia)" }}
              >
                <p className="font-body italic text-[12px]">
                  Coming in PR4 — the runtime mint surface lands with{" "}
                  <code>ctrl-api</code> PR #111 PR4. In the meantime, mint
                  manually:
                </p>
                <pre className="font-mono text-[10px] mt-2 overflow-x-auto whitespace-pre-wrap">
                  {`docker exec alfred-ctrl-1 vault-cli channel-token mint \\
  --channel ha-conversation --label ha:<installId>`}
                </pre>
              </div>
            )
          }
        />
      </div>

      {/* Installed HA installs table. */}
      <div className="mt-7 space-y-3">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Installed HA installs
        </div>
        {!surfaceAvailable ? (
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            The shared channel-token surface isn't on this VM yet. Pull the
            next ctrl-api image and refresh.
          </p>
        ) : summary.installs.length === 0 ? (
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            No installs paired yet. Mint a token above to get started.
          </p>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr
                className="text-left"
                style={{ color: "var(--marginalia)" }}
              >
                <th className="font-normal pb-2">Install ID</th>
                <th className="font-normal pb-2">Label</th>
                <th className="font-normal pb-2">Last used</th>
                <th className="font-normal pb-2">IP</th>
                <th className="font-normal pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {summary.installs.map((i) => {
                const busy = revokeBusy.has(i.tokenId);
                return (
                  <tr
                    key={i.tokenId}
                    className="border-t border-rule"
                    style={{ color: "var(--ink)" }}
                  >
                    <td className="py-2" title={i.installId}>
                      {truncateInstallId(i.installId)}
                    </td>
                    <td className="py-2">{i.label ?? "—"}</td>
                    <td className="py-2">
                      {formatLastUsed(i.lastUsedAt)}
                    </td>
                    <td className="py-2">{i.lastUsedIp ?? "—"}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => revoke(i.tokenId)}
                        disabled={busy}
                        className="btn-ghost"
                      >
                        {busy ? "…" : "Revoke"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Numbered step block — keeps the three-step ritual visually
 *  uniform without duplicating the markup three times. */
function StepBlock({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div
        className="font-display text-2xl flex-none w-8"
        style={{ color: "var(--brass)" }}
      >
        {n}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-display text-[15px] mb-1">{title}</div>
        {body}
      </div>
    </div>
  );
}
