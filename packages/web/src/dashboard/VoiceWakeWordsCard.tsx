// VoiceWakeWordsCard — /channels card for Issue #112 PR3.
//
// Two visual sections:
//
//   1. Detected ESPHome devices. The voice-bridge speaks ESPHome
//      Native API (PR #112 PR1 wired the listener; PR #112 PR2 wired
//      OpenAI Realtime). The card reads the device-table the bridge
//      maintains via GET /api/v1/channels/voice/esphome/devices. When
//      that endpoint isn't deployed yet (PR4 lands the route), the
//      card surfaces an "ESPHome listener disabled" hint instead of
//      breaking.
//
//   2. Wake-word library. The card surfaces an 8-entry catalogue from
//      github.com/fwartner/home-assistant-wakewords-collection — the
//      principal multi-selects and the card renders an ESPHome YAML
//      snippet they paste into their satellite's device YAML.
//      Installation is paste-this-YAML, not click-a-button — there's
//      no runtime mutation here.
//
// PR3 is documentation + read-only. The voice-bridge already knows
// how to discover ESPHome satellites; surfacing them on /channels is
// the principal-facing payoff.

import { useMemo, useState } from "react";
import { useQuery, getEsphomeDevices } from "wasp/client/operations";
import {
  WAKE_WORD_CATALOGUE,
  WAKE_WORD_UPSTREAM_URL,
  selectedWakeWordsToManifest,
  upstreamUrlForEntry,
  formatEsphomeDeviceRow,
  type EsphomeDevice,
} from "./voiceWakeWordsCardCore";

interface DevicesResponse {
  devices: EsphomeDevice[];
  /** Set when ctrl-api 404s the read endpoint (#112 PR4 not deployed
   *  yet). The card surfaces an enable-the-listener hint. */
  unavailable?: boolean;
}

export function VoiceWakeWordsCard() {
  const { data: devicesData } = useQuery(getEsphomeDevices, undefined, {
    retry: false,
  });
  const resp = (devicesData as DevicesResponse | undefined) ?? null;
  const devices: EsphomeDevice[] = Array.isArray(resp?.devices)
    ? (resp!.devices as EsphomeDevice[])
    : [];
  const listenerAvailable = !(resp?.unavailable === true);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manifestOpen, setManifestOpen] = useState(false);

  const manifest = useMemo(
    () => selectedWakeWordsToManifest([...selected]),
    [selected],
  );

  const [copied, setCopied] = useState(false);
  function copyManifest() {
    navigator.clipboard?.writeText(manifest);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  return (
    <div className="border border-rule p-6 card-hover h-full">
      {/* Card header — mirrors ChannelCard. */}
      <div className="flex items-baseline justify-between mb-3">
        <span className="font-display text-3xl">Voice satellites</span>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.22em] font-extrabold"
          style={{
            color: devices.length > 0 ? "var(--brass)" : "var(--marginalia)",
          }}
        >
          {devices.length > 0
            ? `${devices.length} on the network`
            : listenerAvailable
              ? "Looking"
              : "Listener off"}
        </span>
      </div>
      <div
        className="font-mono text-[12px] mb-3"
        style={{ color: "var(--ink)" }}
      >
        ESPHome Voice PE · M5Stack Atom · S3-Box
      </div>
      <div className="font-body italic" style={{ color: "var(--marginalia)" }}>
        Wake words and satellites — the doors with no screens.
      </div>

      {/* Section 1 — Detected ESPHome devices */}
      <div className="mt-6 space-y-3">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Detected ESPHome devices
        </div>
        {!listenerAvailable ? (
          <div
            className="border border-rule p-3 space-y-2"
            style={{ color: "var(--marginalia)" }}
          >
            <p className="font-body italic text-[12px]">
              ESPHome listener disabled. Set{" "}
              <code>ESPHOME_API_ENABLED=1</code> in <code>/opt/alfred/.env</code>{" "}
              and restart the voice-bridge:
            </p>
            <pre className="font-mono text-[10px] overflow-x-auto whitespace-pre-wrap">
              {`docker compose --profile voice restart voice-bridge`}
            </pre>
          </div>
        ) : devices.length === 0 ? (
          <p
            className="font-body italic text-[12px]"
            style={{ color: "var(--marginalia)" }}
          >
            No ESPHome satellites discovered yet. Flash a Voice PE / S3-Box on
            the same LAN — it'll show up here within a few seconds.
          </p>
        ) : (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr
                className="text-left"
                style={{ color: "var(--marginalia)" }}
              >
                <th className="font-normal pb-2">Hostname</th>
                <th className="font-normal pb-2">IP</th>
                <th className="font-normal pb-2">Last seen</th>
                <th className="font-normal pb-2">Model</th>
                <th className="font-normal pb-2">Wake word</th>
                <th className="font-normal pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => {
                const r = formatEsphomeDeviceRow(d);
                return (
                  <tr
                    key={`${d.hostname}-${d.ip}`}
                    className="border-t border-rule"
                  >
                    <td className="py-2" style={{ color: "var(--ink)" }}>
                      {r.shortHost}
                    </td>
                    <td className="py-2" style={{ color: "var(--ink)" }}>
                      {r.ip}
                    </td>
                    <td
                      className="py-2"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {r.lastSeenRelative}
                    </td>
                    <td
                      className="py-2"
                      style={{ color: "var(--marginalia)" }}
                    >
                      {r.modelLabel}
                    </td>
                    <td className="py-2" style={{ color: "var(--ink)" }}>
                      {r.wakeWordLabel}
                    </td>
                    <td
                      className="py-2"
                      style={{
                        color:
                          r.pill === "active"
                            ? "var(--brass)"
                            : r.pill === "error"
                              ? "var(--brass)"
                              : "var(--marginalia)",
                      }}
                    >
                      {r.pillLabel}
                      {r.errorLine && (
                        <div
                          className="font-body italic text-[10px]"
                          style={{ color: "var(--brass)" }}
                        >
                          {r.errorLine}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Section 2 — Wake-word library */}
      <div className="mt-7 space-y-3">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.22em]"
          style={{ color: "var(--marginalia)" }}
        >
          Wake-word library
        </div>
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          <strong>microWakeWord</strong> runs on the satellite itself — zero
          latency, no bridge load. <strong>openWakeWord</strong> runs on the
          voice-bridge — heavier accuracy, costs a couple of CPU cores. Pick a
          handful, click "Generate ESPHome YAML", and paste into your device.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {WAKE_WORD_CATALOGUE.map((entry) => {
            const isOn = selected.has(entry.slug);
            return (
              <button
                key={entry.slug}
                onClick={() => toggle(entry.slug)}
                className="border border-rule p-2 text-left"
                style={{
                  color: isOn ? "var(--brass)" : "var(--ink)",
                  borderColor: isOn ? "var(--brass)" : undefined,
                }}
              >
                <div className="font-display text-[14px]">
                  {entry.displayName}
                </div>
                <div
                  className="font-mono text-[10px]"
                  style={{ color: "var(--marginalia)" }}
                >
                  {entry.model}
                  {entry.sha256 == null && " · unpinned"}
                </div>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 items-baseline pt-1">
          <button
            onClick={() => setManifestOpen(true)}
            disabled={selected.size === 0}
            className="btn-ghost"
          >
            Generate ESPHome YAML
          </button>
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="btn-ghost">
              Clear selection ({selected.size})
            </button>
          )}
        </div>
      </div>

      {/* Section 3 — Upstream link */}
      <div className="mt-7 pt-4 border-t border-rule">
        <p
          className="font-body italic text-[12px]"
          style={{ color: "var(--marginalia)" }}
        >
          The full upstream catalogue (plus instructions for training your own
          wake word) lives at{" "}
          <a
            href={WAKE_WORD_UPSTREAM_URL}
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: "var(--ink)" }}
          >
            fwartner/home-assistant-wakewords-collection
          </a>
          .
        </p>
      </div>

      {/* Manifest modal — inline disclosure rather than a portal so
          the card stays self-contained. */}
      {manifestOpen && (
        <div
          className="mt-5 border-2 p-4 space-y-3"
          style={{ borderColor: "var(--brass)" }}
        >
          <div className="flex items-baseline justify-between">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.22em]"
              style={{ color: "var(--brass)" }}
            >
              ESPHome YAML — paste under your device config
            </span>
            <button
              onClick={() => setManifestOpen(false)}
              className="btn-ghost"
            >
              Close
            </button>
          </div>
          <pre
            className="font-mono text-[11px] overflow-x-auto whitespace-pre-wrap p-2 border border-rule"
            style={{ color: "var(--ink)" }}
          >
            {manifest}
          </pre>
          <div className="flex gap-3 items-baseline">
            <button onClick={copyManifest} className="btn-ghost">
              {copied ? "Copied" : "Copy YAML"}
            </button>
            {[...selected].map((slug) => {
              const e = WAKE_WORD_CATALOGUE.find((x) => x.slug === slug);
              if (!e) return null;
              return (
                <a
                  key={slug}
                  href={upstreamUrlForEntry(e)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[10px] underline"
                  style={{ color: "var(--marginalia)" }}
                >
                  {e.slug} ↗
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
