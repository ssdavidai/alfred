# Cloudflare DNS Zone Setup for alfred.black

## Prerequisites

1. Cloudflare account with the `alfred.black` domain added
2. DNS management delegated to Cloudflare (nameservers updated at registrar)

## Steps

### 1. Get Zone and Account IDs

In the Cloudflare dashboard:
- Go to the `alfred.black` zone overview
- Copy the **Zone ID** and **Account ID** from the right sidebar

### 2. Create an API Token

Go to **My Profile > API Tokens > Create Token**:
- Template: **Edit zone DNS** (or create custom)
- Permissions needed:
  - Zone > DNS > Edit
  - Zone > Zone > Read
  - Account > Cloudflare Tunnel > Edit
  - Account > Access: Apps and Policies > Edit
- Zone Resources: Include > Specific Zone > `alfred.black`

### 3. Configure Environment Variables

Add to alfred-ctrl `.env`:

```
CLOUDFLARE_API_TOKEN=<your-token>
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_ZONE_ID=<your-zone-id>
CLOUDFLARE_DOMAIN=alfred.black
```

Also add `CLOUDFLARE_DOMAIN=alfred.black` to the SaaS `.env` for the provisioning worker.

### 4. Verify DNS Propagation

After provisioning a tenant, verify the CNAME record:

```bash
dig +short acme.alfred.black
# Should return: <tunnel-id>.cfargotunnel.com
```

### 5. SaaS App DNS

The SaaS app itself should be served from `alfred.black` (or `app.alfred.black`).
Tenant subdomains are auto-generated: `{customer-name}.alfred.black`.

## DNS Record Overview

| Record | Type | Target | Proxy |
|--------|------|--------|-------|
| `alfred.black` | A/CNAME | SaaS app server | Yes |
| `{tenant}.alfred.black` | CNAME | `{tunnel-id}.cfargotunnel.com` | Yes |

## Troubleshooting

- **DNS not resolving**: Check CNAME record exists in Cloudflare dashboard
- **SSL errors**: Ensure Cloudflare SSL mode is "Full (strict)" for the zone
- **403 from Cloudflare Access**: Check Access application and policy configuration
- **502 from tunnel**: Verify cloudflared is running on the tenant VM (`systemctl status cloudflared`)
