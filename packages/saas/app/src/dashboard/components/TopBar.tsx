import { useState } from "react";
import { motion } from "framer-motion";
import { Button } from "../../client/components/ui/button";
import {
  Upload,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  FolderOpen,
  Bot,
  Smartphone,
  Loader2,
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
  const gatewayToken = data.gatewayToken ?? null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex items-center rounded-sm border border-white/10 bg-black/40 backdrop-blur-md"
      >
        {/* Health */}
        <motion.button
          whileHover={hoverGlow}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs transition-colors hover:bg-gold/5"
          title={
            isHealthLoading ? "Loading health" : `Health: ${healthStatus}`
          }
        >
          {isHealthLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-gold" />
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

        <div className="h-6 border-r border-white/10" />

        {/* Vault */}
        <motion.a
          href="/dashboard/vault"
          whileHover={hoverGlow}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-gold/5 hover:text-cream"
        >
          <FolderOpen className="h-3.5 w-3.5 text-gold/70" />
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
            <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[0.6rem] text-gold">
              <AnimatedCounter value={inboxCount} duration={0.8} /> inbox
            </span>
          )}
        </motion.a>

        <div className="h-6 border-r border-white/10" />

        {/* Services */}
        <motion.a
          href="/dashboard/assistants"
          whileHover={hoverGlow}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-gold/5 hover:text-cream"
        >
          <Bot className="h-3.5 w-3.5 text-gold/70" />
          <span>
            {isServicesLoading
              ? "Loading services..."
              : (totalContainers ?? 0) > 0
                ? `${runningContainers}/${totalContainers} up`
                : "..."}
          </span>
        </motion.a>

        <div className="h-6 border-r border-white/10" />

        {/* Devices */}
        <motion.button
          whileHover={hoverGlow}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className={`flex items-center gap-2 px-4 py-2.5 font-mono text-xs transition-colors hover:bg-gold/5 ${
            activePanel === "devices"
              ? "bg-gold/10 text-cream"
              : "text-muted-foreground"
          }`}
          onClick={() =>
            onPanelToggle(activePanel === "devices" ? null : "devices")
          }
        >
          <Smartphone className="h-3.5 w-3.5 text-gold/70" />
          <span>
            {isDevicesLoading ? "Loading devices..." : `${pairedCount} paired`}
          </span>
          {!isDevicesLoading && (pendingCount ?? 0) > 0 && (
            <span className="rounded-full bg-gold/20 px-1.5 py-0.5 text-[0.6rem] font-medium text-gold">
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
            className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-cream"
            onClick={() => setUploadOpen(true)}
          >
            <Upload className="h-3 w-3" />
            Upload
          </Button>

          {subdomainUrl && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 font-mono text-[0.65rem] text-muted-foreground hover:text-cream"
              asChild
            >
              <a
                href={
                  gatewayToken
                    ? `${subdomainUrl}/?token=${gatewayToken}`
                    : subdomainUrl
                }
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3 w-3" />
                OpenClaw
              </a>
            </Button>
          )}
        </div>
      </motion.div>

      <FileUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </>
  );
}
