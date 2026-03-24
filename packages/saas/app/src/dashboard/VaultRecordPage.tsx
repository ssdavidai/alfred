import { useParams, Link } from "react-router-dom";
import { useQuery, getVaultRecord } from "wasp/client/operations";
import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Button } from "../client/components/ui/button";
import { ArrowLeft, Home } from "lucide-react";

export default function VaultRecordPage() {
  const { "*": path } = useParams();
  const decodedPath = path ? decodeURIComponent(path) : "";

  const { data, isLoading, error } = useQuery(getVaultRecord, {
    path: decodedPath,
  });

  return (
    <DashboardLayout>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/dashboard">
            <Home className="mr-2 h-4 w-4" />
            Back to Dashboard
          </Link>
        </Button>
        <span className="text-muted-foreground">/</span>
        <Button asChild variant="ghost" size="sm">
          <Link to="/dashboard/vault">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Vault
          </Link>
        </Button>
      </div>

      {isLoading && (
        <p className="text-muted-foreground">Loading record...</p>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-sm p-4">
          <p>{error.message}</p>
        </div>
      )}

      {data && (
        <Card>
          <CardContent className="p-6">
            <CardTitle className="text-cream mb-4 text-xl">
              {data.frontmatter?.name || data.frontmatter?.subject || decodedPath}
            </CardTitle>

            {/* Frontmatter */}
            {data.frontmatter && (
              <div className="border border-gold-dim/40 mb-4 rounded-sm p-4">
                <h3 className="text-cream mb-2 text-sm font-semibold">
                  Properties
                </h3>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  {Object.entries(data.frontmatter).map(([key, value]) => (
                    <div key={key}>
                      <dt className="text-muted-foreground">{key}</dt>
                      <dd className="text-foreground">
                        {typeof value === "object"
                          ? JSON.stringify(value)
                          : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Content */}
            {data.body && (
              <div className="prose prose-sm prose-invert max-w-none">
                <pre className="border border-gold-dim/40 whitespace-pre-wrap rounded-sm p-4 text-sm">
                  {data.body}
                </pre>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </DashboardLayout>
  );
}
