/**
 * Verify that all test records have been cleaned up
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(process.cwd(), '.env.server') });

import { CloudflareDNSClient } from './dns';

async function verifyCleanup() {
  const client = new CloudflareDNSClient();

  console.log('Checking for any remaining test records...\n');

  // List all A records in the zone
  const aRecords = await client.listRecords('A', 100);

  // Filter for test records (starting with "test-")
  const testRecords = aRecords.filter(record =>
    record.name.startsWith('test-') && record.name.includes('alfredos.site')
  );

  if (testRecords.length === 0) {
    console.log('✅ No test records found - cleanup successful!');
  } else {
    console.log(`⚠️  Found ${testRecords.length} test record(s) that need cleanup:\n`);
    testRecords.forEach(record => {
      console.log(`   - ${record.name} -> ${record.content} (ID: ${record.id})`);
    });

    console.log('\nCleaning up test records...');
    for (const record of testRecords) {
      const slug = record.name.replace('.alfredos.site', '');
      await client.deleteARecord(slug);
      console.log(`   ✓ Deleted: ${record.name}`);
    }
    console.log('\n✅ All test records cleaned up!');
  }

  // Show summary of all A records
  console.log(`\nTotal A records in zone: ${aRecords.length}`);
  console.log('Current A records:');
  aRecords.forEach(record => {
    if (!record.name.startsWith('test-')) {
      console.log(`   - ${record.name} -> ${record.content}`);
    }
  });
}

verifyCleanup().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
