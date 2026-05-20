// DevicesPanel — Hermes-native DM-pairing status (issue #42).
//
// The OpenClaw-era per-device-token panel (paired/pending/rejected tabs with
// approve/reject/unpair buttons) wrapped a `hermes devices` CLI surface that
// does not exist. Hermes pairs a messaging account by a one-hour code; its
// `pairing list` CLI emits human-readable text with no JSON and no machine
// id, so there is no faithful way to render per-row action buttons here.
//
// This panel is therefore a read-only status surface: it shows the raw
// `hermes pairing list` output. Approving a pending code is done from the
// full Pairings page (DevicesPage), or by the principal from a paired chat.
import { useQuery, getDevices } from "wasp/client/operations";

export default function DevicesPanel() {
  const { data, isLoading } = useQuery(getDevices, undefined, {
    refetchInterval: 15_000,
  });

  const raw: string = typeof (data as any)?.raw === "string" ? (data as any).raw : "";

  return (
    <div className="overflow-hidden rounded-sm border border-gold-dim/20 bg-black/20">
      <div className="border-b border-gold-dim/20 px-4 py-2">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-cream">
          DM Pairing
        </span>
      </div>
      <div className="p-3">
        {isLoading ? (
          <p className="py-2 text-center font-mono text-xs text-muted-foreground/50">
            Loading pairings...
          </p>
        ) : raw ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
            {raw}
          </pre>
        ) : (
          <p className="py-2 text-center font-mono text-xs text-muted-foreground/50">
            No pairings. Message Alfred from a channel to start a pairing.
          </p>
        )}
      </div>
    </div>
  );
}
