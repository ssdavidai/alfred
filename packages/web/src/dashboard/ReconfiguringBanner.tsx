import { Loader2 } from "lucide-react";

interface Props {
  /** Human-readable label (e.g. toolkit name) shown in the banner copy. */
  label: string | null;
}

/**
 * Subtle inline banner shown at the top of DashboardLayout while the tenant's
 * openclaw gateway is restarting to pick up a tools.allow change. Hides the
 * ~40s 502 window behind a managed "reconfiguring" state.
 */
export default function ReconfiguringBanner({ label }: Props) {
  const subject = label ? `${label}` : "your new integration";
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-[#C9A84C]/30 bg-[#C9A84C]/10 p-4">
      <Loader2 className="mt-0.5 h-4 w-4 flex-shrink-0 animate-spin text-[#C9A84C]" />
      <div className="text-sm leading-relaxed text-[#F0EDE8]">
        <div className="font-medium">Configuring {subject}…</div>
        <div className="mt-1 text-[#8A8680]">
          Alfred is restarting to pick up the change. This usually takes under a minute.
          Chat will be available shortly.
        </div>
      </div>
    </div>
  );
}
