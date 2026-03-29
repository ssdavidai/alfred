import { Mail, Headphones, CreditCard, Github, Globe, MessageSquare, FileText } from "lucide-react";

export interface SourceDefinition {
  id: string;
  label: string;
  description: string;
  icon: any;  // lucide icon component
  transport: "pull" | "push" | "realtime" | "system";
  authType: "oauth2" | "api_key" | "hmac" | "none";
  authProvider?: string;
  requiredScopes?: string[];
  defaultConfig: Record<string, unknown>;
  available: boolean;
}

export const SOURCES: SourceDefinition[] = [
  {
    id: "openclaw-sessions",
    label: "OpenClaw Sessions",
    description: "Conversations with your Alfred agent, automatically captured.",
    icon: MessageSquare,
    transport: "system",
    authType: "none",
    defaultConfig: {},
    available: true,
  },
  {
    id: "gmail",
    label: "Gmail",
    description: "Monitor your inbox for important emails and actionable messages.",
    icon: Mail,
    transport: "pull",
    authType: "oauth2",
    authProvider: "google",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    defaultConfig: {
      transport: "pull",
      parser: "gmail",
      auth_type: "oauth2",
      auth_provider: "google",
      pull: {
        endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
        method: "GET",
        intervalSeconds: 300,
        detailEndpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
        detailIdField: "id",
      },
    },
    available: true,
  },
  {
    id: "omi",
    label: "Omi Ambient",
    description: "Real-time audio from your Omi wearable. Paste this URL into the Omi app developer settings as the audio stream endpoint: https://{tenant}.alfred.black/api/v1/streams/omi/audio?token={webhookToken}&uid=omi-device",
    icon: Headphones,
    transport: "push",
    authType: "none",
    defaultConfig: {
      transport: "push",
      parser: "omi",
    },
    available: true,
  },
  {
    id: "polar",
    label: "Polar Payments",
    description: "Payment and subscription events from Polar.",
    icon: CreditCard,
    transport: "push",
    authType: "hmac",
    defaultConfig: {
      transport: "push",
      parser: "polar",
    },
    available: true,
  },
  {
    id: "github",
    label: "GitHub",
    description: "Repository events — pushes, pull requests, issues.",
    icon: Github,
    transport: "push",
    authType: "hmac",
    defaultConfig: {
      transport: "push",
      parser: "github-webhook",
    },
    available: true,
  },
  {
    id: "notion",
    label: "Notion",
    description: "Sync your Notion workspace — pages, wikis, and database schemas. Create an internal integration at notion.so/profile/integrations, then paste the token here.",
    icon: FileText,
    transport: "pull",
    authType: "api_key",
    authProvider: "notion",
    requiredScopes: [],
    defaultConfig: {
      transport: "pull",
      parser: "notion",
      auth_type: "oauth2",
      pull: {
        endpoint: "https://api.notion.com/v1/search",
        method: "POST",
        intervalSeconds: 900,  // 15 min
        headers: { "Notion-Version": "2022-06-28" },
      },
    },
    available: true,
  },
  {
    id: "custom",
    label: "Custom Webhook",
    description: "Send events from any service via HTTP webhook.",
    icon: Globe,
    transport: "push",
    authType: "none",
    defaultConfig: {
      transport: "push",
      parser: "passthrough",
    },
    available: true,
  },
];
