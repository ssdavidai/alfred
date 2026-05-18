import { useQuery, getAdminProvisioningJobs } from "wasp/client/operations";
import { useAuth } from "wasp/client/auth";
import { Navigate } from "react-router-dom";
import { Link } from "wasp/client/router";
import DashboardLayout from "../../../dashboard/DashboardLayout";

const statusColors: Record<string, string> = {
  completed: "bg-green-900 text-green-200",
  failed: "bg-red-900 text-red-200",
  running: "bg-yellow-900 text-yellow-200",
  pending: "bg-gray-800 text-gray-300",
};

export default function ProvisioningJobsPage() {
  const { data: user } = useAuth();
  const { data: jobs, isLoading, error } = useQuery(getAdminProvisioningJobs);

  if (!user) return null;
  if (!user.isAdmin) return <Navigate to="/" replace />;

  // M7 #869 — admin tokens pass.
  return (
    <DashboardLayout>
      <div className="p-6 paper">
        <div
          className="font-mono text-[10px] uppercase tracking-[0.28em] mb-2"
          style={{ color: "var(--brass)" }}
        >
          Admin
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-8">
          Provisioning jobs.
        </h1>

        {isLoading && (
          <p
            className="font-body italic"
            style={{ color: "var(--marginalia)" }}
          >
            Composing the queue…
          </p>
        )}
        {error && (
          <div
            className="border border-rule p-4"
            style={{ borderColor: "var(--brass)", color: "var(--brass)" }}
          >
            {error.message}
          </div>
        )}

        {jobs && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border border-b bg-muted/50">
                  <th className="text-muted-foreground p-3 text-left font-medium">ID</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">User</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">Instance</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">Status</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">Step</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">Error</th>
                  <th className="text-muted-foreground p-3 text-left font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job: any) => (
                  <tr key={job.id} className="border-border border-b">
                    <td className="text-foreground p-3 font-mono text-xs">
                      {job.id.slice(0, 8)}...
                    </td>
                    <td className="text-muted-foreground p-3">
                      {job.user?.email || "-"}
                    </td>
                    <td className="p-3">
                      {job.instanceId ? (
                        <Link
                          to="/admin/instances/:instanceId"
                          params={{ instanceId: job.instanceId }}
                          className="text-primary hover:underline font-mono text-xs"
                        >
                          {job.instanceId.slice(0, 8)}...
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={`inline-block rounded-full px-2 py-1 text-xs font-medium ${statusColors[job.status] || "bg-gray-800 text-gray-200"}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="text-muted-foreground p-3 font-mono text-xs">
                      {job.currentStep || "-"}
                    </td>
                    <td className="p-3 max-w-xs">
                      {job.error ? (
                        <span className="text-red-400 text-xs truncate block" title={job.error}>
                          {job.error.slice(0, 60)}{job.error.length > 60 ? "..." : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="text-muted-foreground p-3 text-xs">
                      {new Date(job.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {jobs?.length === 0 && (
          <p className="text-muted-foreground">No provisioning jobs found.</p>
        )}
      </div>
    </DashboardLayout>
  );
}
