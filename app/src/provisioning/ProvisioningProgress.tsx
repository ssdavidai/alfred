import { useState } from "react";
import { reprovisionInstance } from "wasp/client/operations";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Progress } from "../client/components/ui/progress";
import { CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { Button } from "../client/components/ui/button";
import { Link } from "react-router-dom";

const STEP_LABELS: Record<string, string> = {
  generate_keypair: "Generating SSH keys",
  upload_ssh_key: "Uploading SSH key",
  ensure_firewall: "Configuring firewall",
  create_volume: "Creating encrypted volume",
  render_cloud_init: "Preparing server configuration",
  create_server: "Creating server",
  wait_cloud_init: "Waiting for server setup",
  upload_env: "Uploading configuration",
  configure_backups: "Configuring backups",
  upload_compose: "Deploying services",
  start_containers: "Starting containers",
  bootstrap_openclaw: "Setting up AI gateway",
  backup_luks_key: "Backing up encryption keys",
  setup_tunnel: "Setting up secure tunnel",
  deploy_api: "Deploying tenant API",
  health_check: "Running health check",
  done: "Complete",
};

const STEP_ORDER = Object.keys(STEP_LABELS);

interface ProvisioningProgressProps {
  data: Record<string, any> | null;
  isLoading: boolean;
}

export default function ProvisioningProgress({
  data,
  isLoading,
}: ProvisioningProgressProps) {
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await reprovisionInstance();
    } catch (err) {
      console.error("Retry failed:", err);
      setRetrying(false);
    }
  };

  const currentStepIndex = data?.job?.currentStep
    ? STEP_ORDER.indexOf(data.job.currentStep)
    : 0;
  const progress = Math.max(
    0,
    Math.min(100, ((currentStepIndex + 1) / STEP_ORDER.length) * 100),
  );

  // No instance and no job — user needs to subscribe
  if (!isLoading && !data?.instance && !data?.job) {
    return (
      <div className="flex items-center justify-center py-16">
        <Card className="w-full max-w-lg border-gold-dim/40 bg-[#111]">
          <CardContent className="p-8 text-center">
            <CardTitle className="mb-4 text-2xl text-[#E8E4DE]">
              Welcome to Alfred
            </CardTitle>
            <p className="mb-6 text-sm text-[#8A8680]">
              Subscribe to a plan to get your private Alfred instance.
            </p>
            <Link to="/pricing">
              <Button className="bg-gold text-[#0A0A0A] hover:bg-gold/90">
                View Plans
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-gold" />
      </div>
    );
  }

  // Has a job — show progress
  if (data?.job) {
    return (
      <div className="flex items-center justify-center py-16">
        <Card className="w-full max-w-lg border-gold-dim/40 bg-[#111]">
          <CardContent className="p-8">
            <CardTitle className="mb-6 text-center text-2xl text-[#E8E4DE]">
              Setting Up Your Instance
            </CardTitle>

            <div className="space-y-6">
              {/* Progress bar */}
              <div>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-[#8A8680]">Progress</span>
                  <span className="font-medium text-[#E8E4DE]">
                    {Math.round(progress)}%
                  </span>
                </div>
                <Progress value={progress} className="h-2" />
              </div>

              {/* Current step */}
              <div className="text-center">
                {data.job.status === "failed" ? (
                  <>
                    <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-500" />
                    <p className="font-medium text-red-500">
                      Provisioning failed
                    </p>
                    <p className="mt-1 text-sm text-[#8A8680]">
                      {data.job.error || "An error occurred during setup."}
                    </p>
                    <Button
                      className="mt-4"
                      variant="outline"
                      disabled={retrying}
                      onClick={handleRetry}
                    >
                      {retrying ? (
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Retrying...</>
                      ) : (
                        "Retry"
                      )}
                    </Button>
                  </>
                ) : data.instance?.status === "running" ? (
                  <>
                    <CheckCircle className="mx-auto mb-2 h-8 w-8 text-green-500" />
                    <p className="font-medium text-[#E8E4DE]">
                      Your instance is ready!
                    </p>
                  </>
                ) : (
                  <>
                    <Loader2 className="mx-auto mb-2 h-8 w-8 animate-spin text-gold" />
                    <p className="font-medium text-[#E8E4DE]">
                      {STEP_LABELS[data.job.currentStep || ""] ||
                        "Preparing..."}
                    </p>
                    <p className="mt-1 text-sm text-[#8A8680]">
                      This usually takes about 4 minutes.
                    </p>
                  </>
                )}
              </div>

              {/* Step list */}
              <div className="space-y-2">
                {STEP_ORDER.map((step, i) => {
                  const isComplete = i < currentStepIndex;
                  const isCurrent = i === currentStepIndex;
                  return (
                    <div
                      key={step}
                      className={`flex items-center gap-3 rounded-lg p-2 text-sm ${
                        isComplete
                          ? "text-[#E8E4DE]"
                          : isCurrent
                            ? "bg-gold/5 font-medium text-[#E8E4DE]"
                            : "text-[#8A8680]"
                      }`}
                    >
                      {isComplete ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : isCurrent ? (
                        <Loader2 className="h-4 w-4 animate-spin text-gold" />
                      ) : (
                        <div className="h-4 w-4 rounded-full bg-[#333]" />
                      )}
                      {STEP_LABELS[step]}
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Instance exists but no active job (e.g. instance in error/provisioning state without a job)
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="h-8 w-8 animate-spin text-gold" />
    </div>
  );
}
