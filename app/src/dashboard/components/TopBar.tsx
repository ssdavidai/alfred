import { useState } from "react";
import { Button } from "../../client/components/ui/button";
import {
  Upload,
  ExternalLink,
  CheckCircle,
  AlertCircle,
  FolderOpen,
  Bot,
  Smartphone,
} from "lucide-react";
import FileUploadDialog from "./FileUploadDialog";

interface TopBarProps {
  data: any;
  containers: any[];
  activePanel: string | null;
  onPanelToggle: (panel: string | null) => void;
}

export default function TopBar({
  data,
  containers,
  activePanel,
  onPanelToggle,
}: TopBarProps) {
  const [uploadOpen, setUploadOpen] = useState(false);

  const healthStatus = data.health?.status || "unknown";
  const isOk = healthStatus === "ok";
  const totalRecords = data.vault?.total_records ?? 0;
  const inboxCount = data.inbox?.count ?? 0;

  const runningContainers = containers.filter(
    (c: any) => c.State === "running" && c.Service !== "init",
  ).length;
  const totalContainers = containers.filter(
    (c: any) => c.Service !== "init",
  ).length;

  const pairedCount = data.devices?.paired ?? 0;
  const pendingCount = data.devices?.pending ?? 0;

  const subdomainUrl = data.instance?.subdomainUrl ?? null;
  const gatewayToken = data.gatewayToken ?? null;

  return (
    <>
      <div className="flex items-center rounded-sm border border-gold-dim/20 bg-black/20">
        {/* Health */}
        <button
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs transition-colors hover:bg-gold/5"
          title={`Health: ${healthStatus}`}
        >
          {isOk ? (
            <CheckCircle className="h-3.5 w-3.5 text-green-500" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500" />
          )}
          <span className={isOk ? "text-green-500" : "text-amber-500"}>
            {isOk ? "OK" : healthStatus.toUpperCase()}
          </span>
        </button>

        <div className="h-6 border-r border-gold-dim/20" />

        {/* Vault */}
        <a
          href="/dashboard/vault"
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-gold/5 hover:text-cream"
        >
          <FolderOpen className="h-3.5 w-3.5 text-gold/70" />
          <span>{totalRecords} records</span>
          {inboxCount > 0 && (
            <span className="rounded-full bg-gold/15 px-1.5 py-0.5 text-[0.6rem] text-gold">
              {inboxCount} inbox
            </span>
          )}
        </a>

        <div className="h-6 border-r border-gold-dim/20" />

        {/* Services */}
        <a
          href="/dashboard/assistants"
          className="flex items-center gap-2 px-4 py-2.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-gold/5 hover:text-cream"
        >
          <Bot className="h-3.5 w-3.5 text-gold/70" />
          <span>
            {totalContainers > 0
              ? `${runningContainers}/${totalContainers} up`
              : "..."}
          </span>
        </a>

        <div className="h-6 border-r border-gold-dim/20" />

        {/* Devices */}
        <button
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
          <span>{pairedCount} paired</span>
          {pendingCount > 0 && (
            <span className="rounded-full bg-gold/20 px-1.5 py-0.5 text-[0.6rem] font-medium text-gold">
              PENDING: {pendingCount}
            </span>
          )}
        </button>

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
      </div>

      <FileUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </>
  );
}
