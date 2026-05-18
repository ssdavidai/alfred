import { useQuery, getAdminInstances } from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import { Link } from "wasp/client/router";
import DashboardLayout from "../../../dashboard/DashboardLayout";

const statusColors: Record<string, string> = {
  running: "bg-green-900 text-green-200",
  provisioning: "bg-yellow-900 text-yellow-200",
  error: "bg-red-900 text-red-200",
  suspended: "bg-orange-900 text-orange-200",
  destroying: "bg-red-900 text-red-200",
  destroyed: "bg-gray-800 text-gray-400",
};

const healthColors: Record<string, string> = {
  ok: "text-green-400",
  degraded: "text-yellow-400",
  down: "text-red-400",
  unreachable: "text-gray-400",
};

export default function InstancesDashboardPage() {
  const { data: user } = useAuth();
  const { data: instances, isLoading, error } = useQuery(getAdminInstances);

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  // M7 #869 — admin tokens pass.
  return (
    <DashboardLayout>
      <div className="p-6 paper">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <div
              className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
              style={{ color: "var(--brass)" }}
            >
              Admin
            </div>
            <h1 className="font-display text-5xl tracking-tight">All instances.</h1>
          </div>
          <Link
            to="/admin/provisioning"
            className="font-mono text-[10px] uppercase tracking-[0.22em] border border-rule px-3 py-2"
            style={{ color: "var(--brass)" }}
          >
            Provisioning jobs →
          </Link>
        </div>

        {isLoading && (
          <p
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            Composing the inventory…
          </p>
        )}

        {error && (
          <div className="border border-rule p-4" style={{ borderColor: "var(--brass)" }}>
            <p className="font-body" style={{ color: "var(--brass)" }}>
              {error.message}
            </p>
          </div>
        )}

        {instances && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border border-b bg-muted/50">
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Name
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    User
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Tier
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Server
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Status
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Health
                  </th>
                  <th className="text-muted-foreground p-3 text-left font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance: any) => (
                  <tr key={instance.id} className="border-border border-b hover:bg-muted/30 transition-colors">
                    <td className="p-3">
                      <Link
                        to="/admin/instances/:instanceId"
                        params={{ instanceId: instance.id }}
                        className="text-primary hover:underline font-medium"
                      >
                        {instance.customerName}
                      </Link>
                    </td>
                    <td className="text-muted-foreground p-3">
                      {instance.user?.email || "-"}
                    </td>
                    <td className="text-foreground p-3 capitalize">
                      {instance.tier?.toLowerCase()}
                    </td>
                    <td className="text-muted-foreground p-3 font-mono text-xs">
                      {instance.serverType}
                    </td>
                    <td className="p-3">
                      <span className={`inline-block rounded-full px-2 py-1 text-xs font-medium ${statusColors[instance.status] || "bg-gray-800 text-gray-200"}`}>
                        {instance.status}
                      </span>
                    </td>
                    <td className="p-3">
                      <span className={`text-sm ${healthColors[instance.lastHealthStatus] || "text-muted-foreground"}`}>
                        {instance.lastHealthStatus || "-"}
                      </span>
                    </td>
                    <td className="text-muted-foreground p-3 text-xs">
                      {new Date(instance.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {instances?.length === 0 && (
          <p className="text-muted-foreground">No instances found.</p>
        )}
      </div>
    </DashboardLayout>
  );
}
