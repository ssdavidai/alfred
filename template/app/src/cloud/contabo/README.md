# Contabo Cloud Provider Integration

This directory contains the Contabo VPS API integration for AlfredOS Cloud.

## Quick Start

### 1. Setup Credentials

See **[CREDENTIALS_SETUP.md](./CREDENTIALS_SETUP.md)** for detailed instructions on obtaining and configuring Contabo API credentials.

### 2. Run Tests

```bash
# Test with mock data (no credentials required)
npx tsx src/cloud/contabo/test-contabo-mock.ts

# Test with live API (requires valid credentials)
npx tsx src/cloud/contabo/test-contabo-api.ts
```

### 3. Review Test Results

See **[TEST_REPORT.md](./TEST_REPORT.md)** for detailed test results and analysis.

## Files

### Core Implementation

- **`client.ts`** - Contabo API client with OAuth 2.0 authentication
- **`provisioner.ts`** - VM provisioning and lifecycle management
- **`cloud-init-template.ts`** - Cloud-init script generation for VM setup

### Testing & Documentation

- **`test-contabo-api.ts`** - Live API integration tests
- **`test-contabo-mock.ts`** - Mock data validation tests
- **`CREDENTIALS_SETUP.md`** - Credential setup guide
- **`TEST_REPORT.md`** - Comprehensive test report
- **`README.md`** - This file

## Architecture

```
┌─────────────────────┐
│   Environment       │
│   (Wasp Entity)     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   provisioner.ts    │  ← Orchestrates VM lifecycle
├─────────────────────┤
│ - provisionVM()     │  Creates VM + DNS
│ - deprovisionVM()   │  Deletes VM + DNS
│ - getVMStatus()     │  Polls status
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    client.ts        │  ← Contabo API wrapper
├─────────────────────┤
│ - authenticate()    │  OAuth 2.0 token
│ - getImages()       │  OS images
│ - getProducts()     │  VPS products
│ - createInstance()  │  Provision VM
│ - getInstance()     │  Get VM details
│ - deleteInstance()  │  Delete VM
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Contabo API       │
│  api.contabo.com    │
└─────────────────────┘
```

## Environment Variables

Required in `.env.server`:

```bash
CONTABO_CLIENT_ID=INT-XXXXXXXX       # OAuth2 Client ID
CONTABO_CLIENT_SECRET=xxxxx          # OAuth2 Client Secret
CONTABO_API_USER=your@email.com      # API User
CONTABO_API_PASSWORD=xxxxx           # API Password (not login password!)
CONTABO_REGION=US-east               # Default region
CONTABO_DEFAULT_IMAGE=ubuntu-22.04   # Default OS image
```

## API Endpoints

| Endpoint                          | Method | Purpose                |
|-----------------------------------|--------|------------------------|
| `/v1/compute/images`              | GET    | List OS images         |
| `/v1/compute/instances/products`  | GET    | List VPS products      |
| `/v1/compute/instances`           | POST   | Create VPS instance    |
| `/v1/compute/instances/{id}`      | GET    | Get instance details   |
| `/v1/compute/instances/{id}`      | DELETE | Delete instance        |

**Authentication:** OAuth 2.0 Bearer token via `https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token`

## Product Tiers

| Plan       | Product ID | vCPU | RAM    | Storage    |
|------------|------------|------|--------|------------|
| Solo       | V45        | 4    | 8 GB   | 200 GB SSD |
| Team       | V46        | 6    | 16 GB  | 400 GB SSD |
| Enterprise | V47        | 8    | 30 GB  | 800 GB SSD |

**Note:** Product IDs should be verified against your Contabo account's product catalog.

## Regions

Valid Contabo regions:
- `EU` - European Union
- `US-central` - United States Central
- `US-east` - United States East (default)
- `US-west` - United States West
- `SIN` - Singapore
- `UK` - United Kingdom
- `AUS` - Australia
- `JPN` - Japan

## Usage Example

```typescript
import { createContaboClient } from './client';

// Create client (uses env vars)
const client = createContaboClient();

// List available images
const images = await client.getImages();

// List products
const products = await client.getProducts();

// Create instance
const instance = await client.createInstance({
  productId: 'V45',
  region: 'US-east',
  imageId: 'ubuntu-22.04-image-id',
  displayName: 'my-app-env',
  period: 1, // 1 month
});

// Get instance details
const details = await client.getInstance(instance.instanceId);

// Delete instance
await client.deleteInstance(instance.instanceId);
```

## Provisioning Flow

1. **Provision Environment** (`provisionVM()`)
   - Select product tier based on plan
   - Find Ubuntu 22.04 image
   - Generate cloud-init script
   - Create Contabo VPS instance
   - Poll for IP address assignment
   - Create DNS A record (via Cloudflare)
   - Update environment record in database

2. **Monitor Status** (`getVMStatus()`)
   - Query instance status
   - Return: `running`, `stopped`, `provisioning`, etc.

3. **Deprovision** (`deprovisionVM()`)
   - Delete Contabo instance
   - Delete DNS record
   - Update environment status

## Cloud-Init

VMs are provisioned with a cloud-init script that:
- Sets hostname
- Installs Docker
- Configures SSL (Let's Encrypt)
- Sets up nginx reverse proxy
- Configures firewall
- Installs monitoring agents

See `cloud-init-template.ts` for details.

## Error Handling

All API errors are caught and logged:
- Authentication errors → Invalid credentials
- API errors → HTTP status + error message
- Network errors → Connection failures

Errors are stored in `Environment.errorMessage` for debugging.

## Testing Status

**Current Status:** ✅ Code Complete, ⏸️ Awaiting Valid Credentials

- ✅ Code logic validated with mock data
- ✅ API client implementation correct
- ✅ Error handling comprehensive
- ❌ Live API tests blocked by invalid credentials

See **[TEST_REPORT.md](./TEST_REPORT.md)** for full details.

## Troubleshooting

### Authentication Fails

```
Error: invalid_grant - Invalid user credentials
```

**Solution:** Check credentials in `.env.server`. The API password is separate from your login password. See [CREDENTIALS_SETUP.md](./CREDENTIALS_SETUP.md).

### Product Not Found

```
Error: Product ID 'V45' not found
```

**Solution:** Run `npx tsx src/cloud/contabo/test-contabo-api.ts` to see available products in your account. Update product mappings in `provisioner.ts`.

### Image Not Found

```
Error: No Ubuntu image found
```

**Solution:** Check available images via API. Update `findUbuntuImage()` in `provisioner.ts` to match your account's image names.

### Region Invalid

```
Error: Invalid region 'US-east'
```

**Solution:** Verify region with Contabo support. Update `CONTABO_REGION` in `.env.server`.

## Resources

- **Contabo API Docs:** https://api.contabo.com/
- **Customer Portal:** https://my.contabo.com
- **Support:** https://contabo.com/en/support/
- **API Help:** https://help.contabo.com/en/support/solutions/articles/103000270527

## Contributing

When modifying the Contabo integration:

1. Update tests in `test-contabo-api.ts`
2. Update mock data in `test-contabo-mock.ts`
3. Run both test suites
4. Update this README if behavior changes
5. Document any new environment variables

## Security

**Never commit credentials to git!**

- Credentials are in `.env.server` (gitignored)
- Use environment variables or secrets manager in production
- Rotate API credentials regularly
- Use separate API users per environment

---

**Last Updated:** 2025-11-15
**Status:** Ready for testing with valid credentials
