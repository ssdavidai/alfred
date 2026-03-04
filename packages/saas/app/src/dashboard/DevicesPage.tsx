import {
  useQuery,
  getDevices,
  approveDevice,
  rejectDevice,
} from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { Smartphone, Check, X, Shield } from "lucide-react";
import { useState } from "react";

export default function DevicesPage() {
  const { data, isLoading, error, refetch } = useQuery(getDevices);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleApprove = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await approveDevice({ requestId });
      refetch();
    } catch (err) {
      console.error("Approve failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await rejectDevice({ requestId });
      refetch();
    } catch (err) {
      console.error("Reject failed:", err);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <DashboardLayout>
      <h1 className="font-serif mb-6 text-2xl font-light text-cream">Devices</h1>

      {isLoading && (
        <p className="text-muted-foreground">Loading devices...</p>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {data && (
        <div className="space-y-4">
          {/* Pending Requests */}
          {data.pending && data.pending.length > 0 && (
            <>
              <h2 className="text-cream text-lg font-semibold">
                Pending Requests
              </h2>
              {data.pending.map((req: any) => (
                <Card key={req.deviceId} className="border-primary/50 border">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <Shield className="text-primary h-5 w-5" />
                      <div>
                        <p className="text-cream font-medium">
                          {req.clientId || req.platform || "New Device"}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          Requested at {new Date(req.createdAtMs).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={actionLoading === req.deviceId}
                        onClick={() => handleApprove(req.deviceId)}
                      >
                        <Check className="mr-1 h-3 w-3" />
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading === req.deviceId}
                        onClick={() => handleReject(req.deviceId)}
                      >
                        <X className="mr-1 h-3 w-3" />
                        Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          )}

          {/* Connected Devices */}
          <h2 className="text-cream text-lg font-semibold">
            Connected Devices
          </h2>
          {data.paired && data.paired.length > 0 ? (
            data.paired.map((device: any) => (
              <Card key={device.deviceId}>
                <CardContent className="flex items-center gap-3 p-4">
                  <Smartphone className="text-muted-foreground h-5 w-5" />
                  <div>
                    <p className="text-cream font-medium">
                      {device.clientId || device.platform || "Device"}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {device.platform} &middot; {device.clientMode} &middot; {device.role}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="p-8 text-center">
                <Smartphone className="text-muted-foreground mx-auto mb-3 h-12 w-12" />
                <p className="text-muted-foreground">
                  No devices connected. Pair a device to get started.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </DashboardLayout>
  );
}
