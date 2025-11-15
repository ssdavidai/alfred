import Cloudflare from 'cloudflare';

/**
 * Cloudflare DNS client for managing A records for environments
 */
export class CloudflareDNSClient {
  private client: Cloudflare;
  private zoneId: string;
  private domain: string;

  constructor() {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    const domain = process.env.DOMAIN_NAME;

    if (!apiToken) {
      throw new Error('CLOUDFLARE_API_TOKEN environment variable is required');
    }
    if (!zoneId) {
      throw new Error('CLOUDFLARE_ZONE_ID environment variable is required');
    }
    if (!domain) {
      throw new Error('DOMAIN_NAME environment variable is required');
    }

    this.client = new Cloudflare({ apiToken });
    this.zoneId = zoneId;
    this.domain = domain;
  }

  /**
   * Create an A record for a subdomain pointing to an IPv4 address
   * @param slug - The subdomain slug (e.g., "brave-tiger")
   * @param ipv4 - The IPv4 address to point to
   * @returns The DNS record ID
   */
  async createARecord(slug: string, ipv4: string): Promise<string> {
    const name = `${slug}.${this.domain}`;

    console.log(`Creating DNS A record: ${name} -> ${ipv4}`);

    try {
      const record = await this.client.dns.records.create({
        zone_id: this.zoneId,
        type: 'A',
        name: slug as any, // Cloudflare automatically appends the zone domain
        content: ipv4,
        ttl: 300, // 5 minutes
        proxied: false, // Don't proxy through Cloudflare for now
      });

      console.log(`DNS A record created: ${name} (ID: ${record.id})`);
      return record.id;
    } catch (error: any) {
      console.error(`Failed to create DNS A record for ${name}:`, error);
      throw new Error(`DNS record creation failed: ${error.message}`);
    }
  }

  /**
   * Delete an A record by subdomain slug
   * @param slug - The subdomain slug to delete
   */
  async deleteARecord(slug: string): Promise<void> {
    const name = `${slug}.${this.domain}`;

    try {
      // First, find the record ID by listing records with the name
      const records = await this.client.dns.records.list({
        zone_id: this.zoneId,
        type: 'A',
        name: name as any,
      });

      if (records.result.length === 0) {
        console.warn(`No DNS A record found for ${name}`);
        return;
      }

      // Delete each matching record (should only be one)
      for (const record of records.result) {
        await this.client.dns.records.delete(record.id, {
          zone_id: this.zoneId,
        });
        console.log(`DNS A record deleted: ${name} (ID: ${record.id})`);
      }
    } catch (error: any) {
      console.error(`Failed to delete DNS A record for ${name}:`, error);
      throw new Error(`DNS record deletion failed: ${error.message}`);
    }
  }

  /**
   * Get an A record by subdomain slug
   * @param slug - The subdomain slug to look up
   * @returns The DNS record if found, null otherwise
   */
  async getARecord(slug: string): Promise<any | null> {
    const name = `${slug}.${this.domain}`;

    try {
      const records = await this.client.dns.records.list({
        zone_id: this.zoneId,
        type: 'A',
        name: name as any,
      });

      if (records.result.length === 0) {
        return null;
      }

      return records.result[0];
    } catch (error: any) {
      console.error(`Failed to get DNS A record for ${name}:`, error);
      return null;
    }
  }

  /**
   * Update an existing A record's IP address
   * @param slug - The subdomain slug
   * @param newIpv4 - The new IPv4 address
   */
  async updateARecord(slug: string, newIpv4: string): Promise<void> {
    const name = `${slug}.${this.domain}`;

    try {
      // Find the existing record
      const records = await this.client.dns.records.list({
        zone_id: this.zoneId,
        type: 'A',
        name: name as any,
      });

      if (records.result.length === 0) {
        throw new Error(`No DNS A record found for ${name}`);
      }

      // Update the first matching record
      const record = records.result[0];
      await this.client.dns.records.update(record.id, {
        zone_id: this.zoneId,
        type: 'A',
        name: slug,
        content: newIpv4,
        ttl: 300,
        proxied: false,
      });

      console.log(`DNS A record updated: ${name} -> ${newIpv4}`);
    } catch (error: any) {
      console.error(`Failed to update DNS A record for ${name}:`, error);
      throw new Error(`DNS record update failed: ${error.message}`);
    }
  }

  /**
   * List all DNS records in the zone (for debugging/validation)
   * @param type - Optional record type filter (e.g., 'A', 'CNAME')
   * @param limit - Maximum number of records to return (default: 100)
   * @returns Array of DNS records
   */
  async listRecords(type?: string, limit: number = 100): Promise<any[]> {
    try {
      const params: any = {
        zone_id: this.zoneId,
        per_page: limit,
      };

      if (type) {
        params.type = type;
      }

      const records = await this.client.dns.records.list(params);
      return records.result;
    } catch (error: any) {
      console.error('Failed to list DNS records:', error);
      throw new Error(`DNS record listing failed: ${error.message}`);
    }
  }

  /**
   * Get zone information and permissions
   * @returns Zone details
   */
  async getZoneInfo(): Promise<any> {
    try {
      const zone = await this.client.zones.get({ zone_id: this.zoneId });
      return zone;
    } catch (error: any) {
      console.error('Failed to get zone info:', error);
      throw new Error(`Zone info retrieval failed: ${error.message}`);
    }
  }
}

/**
 * Create a singleton instance of the Cloudflare DNS client
 */
export function createCloudflareClient(): CloudflareDNSClient {
  return new CloudflareDNSClient();
}
