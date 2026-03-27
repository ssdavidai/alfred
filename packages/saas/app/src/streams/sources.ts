import { Mail, Headphones, CreditCard, Github, Globe, MessageSquare } from "lucide-react";

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
      pull: {
        endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        method: "GET",
        intervalSeconds: 300,
        detailEndpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full",
        detailIdField: "messages[*].id",
        paginationStrategy: "nextPageToken",
      },
    },
    available: true,
  },
  {
    id: "omi",
    label: "Omi Ambient",
    description: "Real-time transcription from your Omi wearable.",
    icon: Headphones,
    transport: "realtime",
    authType: "api_key",
    defaultConfig: {
      transport: "realtime",
      parser: "omi",
    },
    available: false,  // coming soon
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
