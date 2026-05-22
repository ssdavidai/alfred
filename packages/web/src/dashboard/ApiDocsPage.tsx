import DashboardLayout from "./DashboardLayout";
import { Card, CardContent, CardTitle } from "../client/components/ui/card";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const API_BASE = "https://alfred.black/user-api";

const endpoints = [
  {
    section: "Vault",
    items: [
      { method: "GET", path: "vault/context", desc: "Get vault summary and record counts" },
      { method: "GET", path: "vault/list/:type", desc: "List records by type (e.g. person, project, task)" },
      { method: "GET", path: "vault/records/:path", desc: "Read a single vault record" },
      { method: "POST", path: "vault/records", desc: "Create a new record", body: '{"type": "note", "name": "My Note", "body": "Content here"}' },
      { method: "PATCH", path: "vault/records/:path", desc: "Edit a record", body: '{"set": {"status": "active"}}' },
      { method: "DELETE", path: "vault/records/:path", desc: "Delete a record" },
      { method: "GET", path: "vault/search?grep=query", desc: "Search vault content" },
      { method: "GET", path: "vault/inbox", desc: "List inbox files" },
      { method: "POST", path: "vault/inbox", desc: "Upload to inbox", body: '{"filename": "note.md", "content": "# My Note"}' },
      { method: "GET", path: "vault/schema", desc: "Get vault schema and types" },
    ],
  },
  {
    section: "Workers",
    items: [
      { method: "GET", path: "workers/status", desc: "Get Alfred daemon status" },
      { method: "POST", path: "workers/up", desc: "Start workers" },
      { method: "POST", path: "workers/down", desc: "Stop workers" },
      { method: "POST", path: "workers/restart", desc: "Restart workers" },
      { method: "GET", path: "workers/janitor/status", desc: "Janitor status" },
      { method: "POST", path: "workers/janitor/scan", desc: "Trigger janitor scan" },
      { method: "GET", path: "workers/distiller/status", desc: "Distiller status" },
      { method: "POST", path: "workers/distiller/run", desc: "Trigger distiller run" },
    ],
  },
  {
    section: "DM Pairing",
    items: [
      { method: "GET", path: "devices", desc: "List pairings (raw `hermes pairing list` text)" },
      { method: "POST", path: "devices/approve", desc: "Approve a pairing code (platform + code)" },
      { method: "POST", path: "devices/revoke", desc: "Revoke a user's channel access (platform + userId)" },
      { method: "POST", path: "devices/clear-pending", desc: "Clear pending pairing codes" },
    ],
  },
  {
    section: "Admin",
    items: [
      { method: "GET", path: "admin/health", desc: "Instance health check" },
      { method: "GET", path: "admin/containers", desc: "List containers" },
      { method: "POST", path: "admin/containers/:service/restart", desc: "Restart a container" },
      { method: "GET", path: "admin/system/info", desc: "System info (disk, memory, uptime)" },
    ],
  },
];

function methodColor(method: string) {
  switch (method) {
    case "GET": return "text-green-400";
    case "POST": return "text-blue-400";
    case "PATCH": return "text-yellow-400";
    case "DELETE": return "text-red-400";
    default: return "text-muted-foreground";
  }
}

// M6 #868 — /dashboard/api-docs → /settings#api-keys (F83 rename /study → /settings).
export default function ApiDocsPage() {
  return <Navigate to="/settings#api-keys" replace />;
}

function LegacyApiDocsPage() {
  return (
    <DashboardLayout>
      <div className="mb-6">
        <Link
          to="/dashboard/settings"
          className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Settings
        </Link>
        <h1 className="font-serif text-2xl font-light text-cream">API Documentation</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Access your Alfred instance directly via REST API.
        </p>
      </div>

      {/* Authentication */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <CardTitle className="text-cream mb-4 text-lg">Authentication</CardTitle>
          <p className="text-muted-foreground mb-3 text-sm">
            All requests require a Bearer token. Create an API key in{" "}
            <Link to="/dashboard/settings" className="text-gold underline">Settings</Link>.
          </p>
          <pre className="overflow-auto rounded-sm border border-gold-dim/40 bg-black/50 p-4 font-mono text-xs text-cream">
{`curl ${API_BASE}/vault/context \\
  -H "Authorization: Bearer alf_your_api_key_here"`}
          </pre>
        </CardContent>
      </Card>

      {/* Base URL */}
      <Card className="mb-6">
        <CardContent className="p-6">
          <CardTitle className="text-cream mb-4 text-lg">Base URL</CardTitle>
          <code className="rounded-sm border border-gold-dim/40 bg-black/50 px-3 py-1.5 font-mono text-sm text-gold">
            {API_BASE}
          </code>
          <p className="text-muted-foreground mt-3 text-sm">
            All endpoint paths below are relative to this base URL.
            Responses are JSON.
          </p>
        </CardContent>
      </Card>

      {/* Endpoints by section */}
      {endpoints.map((section) => (
        <Card key={section.section} className="mb-6">
          <CardContent className="p-6">
            <CardTitle className="text-cream mb-4 text-lg">{section.section}</CardTitle>
            <div className="space-y-4">
              {section.items.map((ep, i) => (
                <div key={i} className="rounded-sm border border-gold-dim/20 p-3">
                  <div className="flex items-baseline gap-2">
                    <span className={`font-mono text-xs font-bold ${methodColor(ep.method)}`}>
                      {ep.method}
                    </span>
                    <code className="font-mono text-xs text-cream">{ep.path}</code>
                  </div>
                  <p className="text-muted-foreground mt-1 text-xs">{ep.desc}</p>
                  {ep.body && (
                    <pre className="mt-2 overflow-auto rounded bg-black/30 p-2 font-mono text-xs text-cream/70">
                      {`curl -X ${ep.method} ${API_BASE}/${ep.path.split("?")[0]} \\
  -H "Authorization: Bearer alf_..." \\
  -H "Content-Type: application/json" \\
  -d '${ep.body}'`}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </DashboardLayout>
  );
}
