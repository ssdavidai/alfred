import { useState } from "react";
import { motion } from "framer-motion";
import { Button } from "../../client/components/ui/button";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  FolderOpen,
  Bot,
  Smartphone,
  Loader2,
  Copy,
  Wallet,
  Kanban,
  KeyRound,
  MessageSquare,
} from "lucide-react";
import FileUploadDialog from "./FileUploadDialog";
import AnimatedCounter from "../../components/ui/AnimatedCounter";

interface TopBarProps {
  data: any;
  containers: any[] | null;
  activePanel: string | null;
  onPanelToggle: (panel: string | null) => void;
}

const hoverGlow = {
  scale: 1.01,
  boxShadow: "0 0 12px rgba(201,168,76,0.1)",
};

export default function TopBar({
  data,
  containers,
  activePanel,
  onPanelToggle,
}: TopBarProps) {
  const [uploadOpen, setUploadOpen] = useState(false);

  const healthStatus = data.health?.status ?? null;
  const isHealthLoading = !data.health;
  const isOk = healthStatus === "ok";
  const healthLabel = healthStatus?.toUpperCase() ?? "UNKNOWN";
  const totalRecords = data.vault?.total_records;
  const inboxCount = data.inbox?.count;
  const isVaultLoading = !data.vault;
  const isServicesLoading = !containers;

  const runningContainers =
    containers?.filter(
      (c: any) => c.State === "running" && c.Service !== "init",
    ).length ?? 0;
  const totalContainers =
    containers?.filter((c: any) => c.Service !== "init").length ?? 0;

  const pairedCount = data.devices?.paired;
  const pendingCount = data.devices?.pending;
  const isDevicesLoading = !data.devices;

  const subdomainUrl = data.instance?.subdomainUrl ?? null;
  const agentmailAddress = (data.instance as any)?.agentmailInboxAddress ?? null;

  // Sidecar URL derivation. Tenants live at https://<sub>.alfred.black; each
  // sidecar gets a single-level subdomain prefix (matches the wildcard cert
  // and the cloudflared template — see packages/ctrl/src/templates/
  // cloudflared-config.yaml.njk for the canonical mapping):
  //   sure       → https://<sub>-sure.alfred.black
  //   plane      → https://<sub>-plane.alfred.black
  //   vaultwarden → https://<sub>-vault.alfred.black
  // We derive these from subdomainUrl rather than threading them through
  // the dashboard data shape because the transform is mechanical and the
  // canonical truth lives in the cloudflared template.
  const sidecarUrl = (suffix: string): string | null => {
    if (!subdomainUrl) return null;
    try {
      const u = new URL(subdomainUrl);
      const [first, ...rest] = u.hostname.split(".");
      if (!first || rest.length === 0) return null;
      u.hostname = `${first}-${suffix}.${rest.join(".")}`;
      return u.toString().replace(/\/$/, "");
    } catch {
      return null;
    }
  };

  // Render sidecar buttons only when the underlying container is actually
  // up — not every tenant runs every sidecar (Vaultwarden is opt-in for
  // older tenants; sure/plane can also be disabled via InstanceConfig
  // flags). Using `containers` as truth keeps the dashboard honest: if the
  // service is wedged or never deployed, no button.
  const containerRunning = (service: string): boolean =>
    containers?.some((c: any) => c.Service === service && c.State === "running") ?? false;

  const showSure = containerRunning("sure-web");
  const showPlane = containerRunning("plane-proxy");
  const showVault = containerRunning("vaultwarden");
  const sureUrl = showSure ? sidecarUrl("sure") : null;
  const planeUrl = showPlane ? sidecarUrl("plane") : null;
  const vaultUrl = showVault ? sidecarUrl("vault") : null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="sticky top-0 z-20 mx-0 mt-0 flex items-center rounded-2xl border border-white/[0.08] bg-black/30 shadow-lg shadow-black/20 backdrop-blur-xl"
      >
        {/* Health */}
        <motion.button
          whileHover={hoverGlow}
          transition={{ type: "spring" as const, stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 rounded-l-2xl px-4 py-2.5 font-mono text-xs transition-colors hover:bg-[#C9A84C]/5"
          title={
            isHealthLoading ? "Loading health" : `Health: ${healthStatus}`
          }
        >
          {isHealthLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[#C9A84C]" />
          ) : isOk ? (
            <motion.div
              animate={{
                boxShadow: [
                  "0 0 0px rgba(34,197,94,0.4)",
                  "0 0 8px rgba(34,197,94,0.6)",
                  "0 0 0px rgba(34,197,94,0.4)",
                ],
              }}
              transition={{ duration: 2, repeat: Infinity }}
              className="rounded-full"
            >
              <CheckCircle className="h-3.5 w-3.5 text-green-500" />
            </motion.div>
          ) : (
            <motion.div
              animate={{
                boxShadow: [
                  "0 0 0px rgba(245,158,11,0.4)",
                  "0 0 8px rgba(245,158,11,0.6)",
                  "0 0 0px rgba(245,158,11,0.4)",
                ],
              }}
              transition={{ duration: 1.5, repeat: Infinity }}
              className="rounded-full"
            >
              <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
            </motion.div>
          )}
          <span
            className={
              isHealthLoading
                ? "text-muted-foreground"
                : isOk
                  ? "text-green-500"
                  : "text-amber-500"
            }
          >
            {isHealthLoading ? "Loading" : isOk ? "OK" : healthLabel}
          </span>
        </motion.button>

        <div className="h-6 border-r border-white/[0.08]" />

        {/* Vault */}
        <motion.a
          href="/dashboard/vault"
          whileHover={hoverGlow}
          transition={{ type: "spring" as const, stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-[#C9A84C]/5 hover:text-[#F0EDE8]"
        >
          <FolderOpen className="h-3.5 w-3.5 text-[#C9A84C]/70" />
          {isVaultLoading ? (
            <span>Loading records...</span>
          ) : (
            <span>
              <AnimatedCounter
                value={totalRecords ?? 0}
                duration={1.2}
                className="font-mono"
              />{" "}
              records
            </span>
          )}
          {!isVaultLoading && (inboxCount ?? 0) > 0 && (
            <span className="rounded-full bg-[#C9A84C]/15 px-1.5 py-0.5 text-[0.6rem] text-[#C9A84C]">
              <AnimatedCounter value={inboxCount} duration={0.8} /> inbox
            </span>
          )}
        </motion.a>

        <div className="h-6 border-r border-white/[0.08]" />

        {/* Services */}
        <motion.a
          href="/dashboard/assistants"
          whileHover={hoverGlow}
          transition={{ type: "spring" as const, stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-[#C9A84C]/5 hover:text-[#F0EDE8]"
        >
          <Bot className="h-3.5 w-3.5 text-[#C9A84C]/70" />
          <span>
            {isServicesLoading
              ? "Loading services..."
              : (totalContainers ?? 0) > 0
                ? `${runningContainers}/${totalContainers} up`
                : "..."}
          </span>
        </motion.a>

        <div className="h-6 border-r border-white/[0.08]" />

        {/* Devices */}
        <motion.button
          whileHover={hoverGlow}
          transition={{ type: "spring" as const, stiffness: 300, damping: 20 }}
          className={`flex items-center gap-2 px-4 py-2.5 font-mono text-xs transition-colors hover:bg-[#C9A84C]/5 ${
            activePanel === "devices"
              ? "bg-[#C9A84C]/10 text-[#F0EDE8]"
              : "text-muted-foreground"
          }`}
          onClick={() =>
            onPanelToggle(activePanel === "devices" ? null : "devices")
          }
        >
          <Smartphone className="h-3.5 w-3.5 text-[#C9A84C]/70" />
          <span>
            {isDevicesLoading ? "Loading devices..." : `${pairedCount} paired`}
          </span>
          {!isDevicesLoading && (pendingCount ?? 0) > 0 && (
            <span className="rounded-full bg-[#C9A84C]/20 px-1.5 py-0.5 text-[0.6rem] font-medium text-[#C9A84C]">
              PENDING: {pendingCount}
            </span>
          )}
        </motion.button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-1 px-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="h-3 w-3" />
            Upload
          </Button>

          {/* Chat — Hermes is HTTP/SSE; the in-dashboard chat widget
              replaces the legacy OpenClaw raw-WebSocket window. */}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
            asChild
          >
            <a href="/chat">
              <MessageSquare className="h-3 w-3" />
              Chat
            </a>
          </Button>

          {sureUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
              title="Sure — personal finance"
              asChild
            >
              <a href={sureUrl} target="_blank" rel="noopener noreferrer">
                <Wallet className="h-3 w-3" />
                Sure
              </a>
            </Button>
          )}

          {planeUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
              title="Plane — project management"
              asChild
            >
              <a href={planeUrl} target="_blank" rel="noopener noreferrer">
                <Kanban className="h-3 w-3" />
                Plane
              </a>
            </Button>
          )}

          {vaultUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
              title="Vaultwarden — secrets manager"
              asChild
            >
              <a href={vaultUrl} target="_blank" rel="noopener noreferrer">
                <KeyRound className="h-3 w-3" />
                Vault
              </a>
            </Button>
          )}

          {agentmailAddress && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-[#F0EDE8]"
              title={`Email Alfred directly at ${agentmailAddress} — click to copy`}
              onClick={() => {
                void navigator.clipboard
                  .writeText(agentmailAddress)
                  .catch(() => {});
              }}
            >
              <Copy className="h-3 w-3" />
              {agentmailAddress}
            </Button>
          )}
        </div>
      </motion.div>

      <FileUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </>
  );
}
