# Cloudflare DNS Client

A TypeScript client for managing DNS A records in Cloudflare for AlfredOS Cloud environments.

## Features

- ✅ Create A records for environment subdomains
- ✅ Read/query existing A records
- ✅ Update A record IP addresses
- ✅ Delete A records
- ✅ List all DNS records in zone
- ✅ Validate zone access and permissions
- ✅ Full TypeScript support
- ✅ Comprehensive error handling

## Environment Variables

Required environment variables in `.env.server`:

```bash
# Cloudflare DNS API credentials
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ZONE_ID=your_zone_id_here

# Domain configuration
DOMAIN_NAME=alfredos.site
```

### Getting Your Credentials

1. **API Token:**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Create a token with permissions: `Zone.DNS.Edit` and `Zone.Zone.Read`

2. **Zone ID:**
   - Go to your domain in [Cloudflare Dashboard](https://dash.cloudflare.com)
   - Find Zone ID in the right sidebar under "API"

## Installation

The required `cloudflare` package is already installed in the project:

```bash
npm install cloudflare
```

## Usage

### Basic Usage

```typescript
import { CloudflareDNSClient } from './cloud/cloudflare/dns';

// Initialize the client
const dnsClient = new CloudflareDNSClient();

// Create an A record
const recordId = await dnsClient.createARecord('brave-tiger', '203.0.113.42');
// Creates: brave-tiger.alfredos.site -> 203.0.113.42

// Read an A record
const record = await dnsClient.getARecord('brave-tiger');
console.log(record.name, '->', record.content);

// Update an A record
await dnsClient.updateARecord('brave-tiger', '198.51.100.10');

// Delete an A record
await dnsClient.deleteARecord('brave-tiger');
```

### Advanced Usage

```typescript
import { CloudflareDNSClient } from './cloud/cloudflare/dns';

const dnsClient = new CloudflareDNSClient();

// List all A records in the zone
const aRecords = await dnsClient.listRecords('A');
console.log(`Found ${aRecords.length} A records`);

// List all records (any type)
const allRecords = await dnsClient.listRecords();

// Get zone information
const zoneInfo = await dnsClient.getZoneInfo();
console.log(`Zone: ${zoneInfo.name}, Status: ${zoneInfo.status}`);
```

### Environment Provisioning Example

```typescript
import { CloudflareDNSClient } from './cloud/cloudflare/dns';

async function provisionEnvironment(environmentSlug: string, vmIpAddress: string) {
  const dnsClient = new CloudflareDNSClient();

  try {
    // Create DNS record for the environment
    const recordId = await dnsClient.createARecord(environmentSlug, vmIpAddress);
    console.log(`DNS configured: ${environmentSlug}.alfredos.site -> ${vmIpAddress}`);

    return {
      domain: `${environmentSlug}.alfredos.site`,
      recordId,
    };
  } catch (error) {
    console.error('Failed to configure DNS:', error);
    throw error;
  }
}

// Usage
await provisionEnvironment('brave-tiger', '203.0.113.42');
```

### Environment Cleanup Example

```typescript
import { CloudflareDNSClient } from './cloud/cloudflare/dns';

async function cleanupEnvironment(environmentSlug: string) {
  const dnsClient = new CloudflareDNSClient();

  try {
    // Delete DNS record
    await dnsClient.deleteARecord(environmentSlug);
    console.log(`DNS record deleted: ${environmentSlug}.alfredos.site`);
  } catch (error) {
    console.error('Failed to delete DNS record:', error);
    throw error;
  }
}

// Usage
await cleanupEnvironment('brave-tiger');
```

### Error Handling

```typescript
import { CloudflareDNSClient } from './cloud/cloudflare/dns';

const dnsClient = new CloudflareDNSClient();

try {
  await dnsClient.createARecord('my-env', '203.0.113.42');
} catch (error) {
  if (error.message.includes('authentication')) {
    console.error('Invalid API token');
  } else if (error.message.includes('zone')) {
    console.error('Invalid zone ID or zone not found');
  } else {
    console.error('DNS operation failed:', error);
  }
}
```

## API Reference

### Class: `CloudflareDNSClient`

#### Constructor

```typescript
new CloudflareDNSClient()
```

Initializes the client with credentials from environment variables. Throws error if required variables are missing.

#### Methods

##### `createARecord(slug: string, ipv4: string): Promise<string>`

Creates a new A record for a subdomain.

- **Parameters:**
  - `slug`: The subdomain slug (e.g., "brave-tiger")
  - `ipv4`: The IPv4 address to point to
- **Returns:** Promise resolving to the DNS record ID
- **Configuration:** TTL: 300s, Proxied: false

**Example:**
```typescript
const recordId = await dnsClient.createARecord('my-env', '203.0.113.42');
// Creates: my-env.alfredos.site -> 203.0.113.42
```

##### `getARecord(slug: string): Promise<any | null>`

Retrieves an A record by subdomain slug.

- **Parameters:**
  - `slug`: The subdomain slug to look up
- **Returns:** Promise resolving to the DNS record object, or null if not found

**Example:**
```typescript
const record = await dnsClient.getARecord('my-env');
if (record) {
  console.log(`${record.name} -> ${record.content}`);
}
```

##### `updateARecord(slug: string, newIpv4: string): Promise<void>`

Updates an existing A record's IP address.

- **Parameters:**
  - `slug`: The subdomain slug
  - `newIpv4`: The new IPv4 address
- **Throws:** Error if record doesn't exist

**Example:**
```typescript
await dnsClient.updateARecord('my-env', '198.51.100.10');
```

##### `deleteARecord(slug: string): Promise<void>`

Deletes an A record by subdomain slug. If multiple records exist with the same name, all are deleted.

- **Parameters:**
  - `slug`: The subdomain slug to delete
- **Note:** Handles non-existent records gracefully (no error)

**Example:**
```typescript
await dnsClient.deleteARecord('my-env');
```

##### `listRecords(type?: string, limit?: number): Promise<any[]>`

Lists DNS records in the zone.

- **Parameters:**
  - `type`: Optional record type filter (e.g., 'A', 'CNAME')
  - `limit`: Maximum records to return (default: 100)
- **Returns:** Promise resolving to array of DNS records

**Example:**
```typescript
const aRecords = await dnsClient.listRecords('A', 50);
const allRecords = await dnsClient.listRecords();
```

##### `getZoneInfo(): Promise<any>`

Retrieves zone information and validates access.

- **Returns:** Promise resolving to zone details
- **Throws:** Error if zone access fails

**Example:**
```typescript
const zone = await dnsClient.getZoneInfo();
console.log(`Zone: ${zone.name}, Status: ${zone.status}`);
```

## DNS Record Configuration

All A records created by this client have the following settings:

- **TTL:** 300 seconds (5 minutes)
- **Proxied:** false (direct DNS, not proxied through Cloudflare)
- **Type:** A (IPv4 address)

## Important Notes

### Duplicate Records

Cloudflare allows multiple A records with the same name (valid DNS behavior). The `deleteARecord()` method will delete **all** matching records to ensure complete cleanup.

### Record Naming

- Input `slug`: "my-env"
- Created record: "my-env.alfredos.site"

Cloudflare automatically appends the zone domain when creating records.

### Rate Limits

Cloudflare API has rate limits. For production use with many operations, consider:
- Batch operations where possible
- Implementing retry logic with exponential backoff
- Caching record lookups

## Testing

Run the comprehensive test suite:

```bash
npx tsx src/cloud/cloudflare/test-dns.ts
```

Verify cleanup:

```bash
npx tsx src/cloud/cloudflare/verify-cleanup.ts
```

See [TEST_REPORT.md](./TEST_REPORT.md) for detailed test results.

## Troubleshooting

### "CLOUDFLARE_API_TOKEN environment variable is required"

Ensure `.env.server` contains your API token:
```bash
CLOUDFLARE_API_TOKEN=your_token_here
```

### "Zone not found" or 404 errors

Verify your Zone ID is correct:
1. Check `.env.server` has `CLOUDFLARE_ZONE_ID`
2. Verify the zone exists in your Cloudflare account
3. Ensure API token has access to the zone

### "Permission denied" errors

Your API token needs these permissions:
- `Zone.DNS.Edit` - Edit DNS records
- `Zone.Zone.Read` - Read zone information

## Production Checklist

Before deploying to production:

- [ ] Valid API token configured
- [ ] Correct Zone ID set
- [ ] Domain name matches Cloudflare zone
- [ ] API token has required permissions
- [ ] Test suite passes
- [ ] Error handling implemented
- [ ] Monitoring/logging configured

## Support

For issues with:
- **Cloudflare API:** See [Cloudflare API Docs](https://developers.cloudflare.com/api/)
- **This client:** Check test suite and TEST_REPORT.md
- **DNS propagation:** Use [DNS Checker](https://dnschecker.org/)

## License

Part of AlfredOS Cloud - See project LICENSE
