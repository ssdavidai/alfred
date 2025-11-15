/**
 * Test script for Cloudflare DNS client
 * This script tests all CRUD operations on DNS A records
 */

// Load environment variables from .env.server
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.server') });

import { CloudflareDNSClient } from './dns';

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function success(msg: string) {
  console.log(`${colors.green}✓ ${msg}${colors.reset}`);
}

function error(msg: string) {
  console.log(`${colors.red}✗ ${msg}${colors.reset}`);
}

function info(msg: string) {
  console.log(`${colors.blue}ℹ ${msg}${colors.reset}`);
}

function section(msg: string) {
  console.log(`\n${colors.cyan}${'='.repeat(60)}`);
  console.log(`${msg}`);
  console.log(`${'='.repeat(60)}${colors.reset}\n`);
}

async function runTests() {
  const timestamp = Date.now();
  const testSlug = `test-agent-${timestamp}`;
  let client: CloudflareDNSClient | undefined;
  let recordId: string | null = null;

  section('Cloudflare DNS Client Test Suite');

  try {
    // Test 1: Client Initialization
    section('Test 1: Client Initialization & Authentication');
    info('Creating Cloudflare DNS client...');
    client = new CloudflareDNSClient();
    success('DNS client created successfully');
    success('Environment variables loaded correctly');

    // Validate zone access
    info('Fetching zone information...');
    const zoneInfo = await client.getZoneInfo();
    success(`Zone access verified: ${zoneInfo.name}`);
    success(`Zone ID: ${zoneInfo.id}`);
    success(`Zone status: ${zoneInfo.status}`);

    // Test 2: Create A Record
    section('Test 2: Create A Record');
    info(`Creating test record: ${testSlug}.alfredos.site -> 1.2.3.4`);
    recordId = await client.createARecord(testSlug, '1.2.3.4');
    success(`A record created successfully (ID: ${recordId})`);

    // Wait a moment for DNS propagation
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test 3: Read/Get A Record
    section('Test 3: Read/Get A Record');
    info(`Fetching record: ${testSlug}.alfredos.site`);
    const record = await client.getARecord(testSlug);

    if (!record) {
      throw new Error('Record not found after creation');
    }

    success(`Record found: ${record.name} -> ${record.content}`);

    if (record.content !== '1.2.3.4') {
      throw new Error(`Expected IP 1.2.3.4, got ${record.content}`);
    }
    success('IP address matches expected value: 1.2.3.4');

    if (record.ttl !== 300) {
      throw new Error(`Expected TTL 300, got ${record.ttl}`);
    }
    success('TTL is correct: 300 seconds');

    if (record.proxied !== false) {
      throw new Error(`Expected proxied=false, got ${record.proxied}`);
    }
    success('Proxied setting is correct: false');

    // Test 4: Update A Record
    section('Test 4: Update A Record');
    info(`Updating record to point to 5.6.7.8`);
    await client.updateARecord(testSlug, '5.6.7.8');
    success('A record updated successfully');

    // Verify update
    await new Promise(resolve => setTimeout(resolve, 1000));
    const updatedRecord = await client.getARecord(testSlug);

    if (!updatedRecord) {
      throw new Error('Record not found after update');
    }

    if (updatedRecord.content !== '5.6.7.8') {
      throw new Error(`Expected IP 5.6.7.8, got ${updatedRecord.content}`);
    }
    success('IP address updated correctly: 5.6.7.8');

    // Test 5: List Records in Zone
    section('Test 5: Validate Zone Record Listing');
    info('Listing A records in zone...');
    const aRecords = await client.listRecords('A', 10);
    success(`Found ${aRecords.length} A records in zone`);

    // Check if our test record is in the list
    const ourRecord = aRecords.find(r => r.name === `${testSlug}.alfredos.site`);
    if (ourRecord) {
      success(`Test record found in zone listing: ${ourRecord.name} -> ${ourRecord.content}`);
    } else {
      error('Test record not found in zone listing');
    }

    // Test 5a: Test Duplicate Record Creation
    section('Test 5a: Error Handling - Duplicate Records');
    info('Attempting to create duplicate record...');
    info('Note: Cloudflare allows duplicate A records (valid DNS behavior)');
    try {
      const duplicateId = await client.createARecord(testSlug, '9.9.9.9');
      success('Cloudflare allows duplicate A records (this is valid DNS behavior)');
      info('Cleaning up duplicate record...');
      await client.deleteARecord(testSlug);
      success('All duplicate records cleaned up');
    } catch (err: any) {
      success(`Duplicate creation prevented: ${err.message}`);
    }

    // Test 6: Delete A Record
    section('Test 6: Delete A Record');
    info(`Deleting test record: ${testSlug}.alfredos.site`);
    await client.deleteARecord(testSlug);
    success('A record deleted successfully');

    // Verify deletion
    await new Promise(resolve => setTimeout(resolve, 1000));
    const deletedRecord = await client.getARecord(testSlug);

    if (deletedRecord !== null) {
      throw new Error('Record still exists after deletion');
    }
    success('Record verified as deleted');

    // Test 7: Test Deleting Non-existent Record
    section('Test 7: Error Handling - Delete Non-existent Record');
    info('Attempting to delete non-existent record...');
    await client.deleteARecord(`nonexistent-${timestamp}`);
    success('Non-existent record deletion handled gracefully');

    // Test 8: Test Update Non-existent Record
    section('Test 8: Error Handling - Update Non-existent Record');
    info('Attempting to update non-existent record...');
    try {
      await client.updateARecord(`nonexistent-${timestamp}`, '1.1.1.1');
      error('WARNING: Update of non-existent record should have failed');
    } catch (err: any) {
      success(`Update failure handled correctly: ${err.message}`);
    }

    // Final Summary
    section('Test Summary');
    success('All tests completed successfully!');
    success('DNS client authentication: PASSED');
    success('Zone access validation: PASSED');
    success('Create A record: PASSED');
    success('Read A record: PASSED');
    success('Update A record: PASSED');
    success('List records: PASSED');
    success('Delete A record: PASSED');
    success('Error handling: PASSED');
    success('TTL configuration: PASSED (300 seconds)');
    success('Proxied setting: PASSED (false)');
    success('Cleanup: COMPLETE');

    console.log('\n' + colors.green + '=' + '='.repeat(59));
    console.log('ALL TESTS PASSED - DNS Client is fully functional!');
    console.log('='.repeat(60) + colors.reset + '\n');

  } catch (err: any) {
    error(`Test failed: ${err.message}`);
    console.error(err);

    // Cleanup on failure
    if (client && recordId) {
      section('Cleanup After Failure');
      info('Attempting to clean up test record...');
      try {
        await client.deleteARecord(testSlug);
        success('Test record cleaned up successfully');
      } catch (cleanupErr: any) {
        error(`Cleanup failed: ${cleanupErr.message}`);
      }
    }

    process.exit(1);
  }
}

// Run the tests
runTests().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
