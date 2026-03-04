import { getHetznerClient, type FirewallRule } from "./hetzner.js";

const FIREWALL_NAME = "alfred-ctrl-hardened";

function getFirewallRules(): FirewallRule[] {
  // SSH restricted to admin CIDRs (default: open, set ADMIN_SSH_CIDRS to restrict)
  const sshCidrs = process.env.ADMIN_SSH_CIDRS
    ? process.env.ADMIN_SSH_CIDRS.split(",").map((s) => s.trim())
    : ["0.0.0.0/0", "::/0"];

  return [
    {
      direction: "in",
      protocol: "tcp",
      port: "22",
      source_ips: sshCidrs,
    },
    {
      direction: "in",
      protocol: "udp",
      port: "41641",
      source_ips: ["0.0.0.0/0", "::/0"],
    },
    {
      direction: "in",
      protocol: "icmp",
      source_ips: ["0.0.0.0/0", "::/0"],
    },
  ];
}

export async function ensureFirewall(): Promise<number> {
  const hetzner = getHetznerClient();
  const { firewalls } = await hetzner.getFirewalls();

  const existing = firewalls.find((f) => f.name === FIREWALL_NAME);
  if (existing) return existing.id;

  const { firewall } = await hetzner.createFirewall(
    FIREWALL_NAME,
    getFirewallRules()
  );
  return firewall.id;
}
