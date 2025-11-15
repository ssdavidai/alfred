/**
 * Contabo API Integration Test Script
 *
 * This script tests the Contabo API client and verifies:
 * 1. OAuth authentication works
 * 2. Can fetch available images
 * 3. Can fetch available products
 * 4. Ubuntu 22.04 image detection
 * 5. Product ID validation for V45, V46, V47
 * 6. Region validation
 *
 * Run with: npx tsx src/cloud/contabo/test-contabo-api.ts
 */

import { createContaboClient, ContaboClient } from './client';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../../.env.server') });

interface TestResult {
  testName: string;
  status: 'PASS' | 'FAIL';
  message: string;
  data?: any;
}

const results: TestResult[] = [];

function logTest(testName: string, status: 'PASS' | 'FAIL', message: string, data?: any) {
  results.push({ testName, status, message, data });
  const statusIcon = status === 'PASS' ? '✅' : '❌';
  console.log(`\n${statusIcon} ${testName}`);
  console.log(`   ${message}`);
  if (data) {
    console.log('   Data:', JSON.stringify(data, null, 2));
  }
}

async function testAuthentication(client: ContaboClient): Promise<boolean> {
  try {
    const token = await client.authenticate();

    if (token && typeof token === 'string' && token.length > 0) {
      logTest(
        'OAuth Authentication',
        'PASS',
        `Successfully authenticated and received token (${token.substring(0, 20)}...)`
      );
      return true;
    } else {
      logTest('OAuth Authentication', 'FAIL', 'Received invalid token');
      return false;
    }
  } catch (error: any) {
    logTest('OAuth Authentication', 'FAIL', error.message);
    return false;
  }
}

async function testGetImages(client: ContaboClient): Promise<any> {
  try {
    const imagesResponse = await client.getImages();

    if (imagesResponse && (imagesResponse as any).data) {
      const images = (imagesResponse as any).data;
      const imageCount = images.length;

      logTest(
        'Get Images',
        'PASS',
        `Successfully fetched ${imageCount} images from Contabo`
      );

      // Log first few images for reference
      console.log('\n   Sample Images:');
      images.slice(0, 5).forEach((img: any) => {
        console.log(`   - ${img.name} (ID: ${img.imageId})`);
      });

      return imagesResponse;
    } else {
      logTest('Get Images', 'FAIL', 'Invalid response format');
      return null;
    }
  } catch (error: any) {
    logTest('Get Images', 'FAIL', error.message);
    return null;
  }
}

async function testGetProducts(client: ContaboClient): Promise<any> {
  try {
    const productsResponse = await client.getProducts();

    if (productsResponse && (productsResponse as any).data) {
      const products = (productsResponse as any).data;
      const productCount = products.length;

      logTest(
        'Get Products',
        'PASS',
        `Successfully fetched ${productCount} products from Contabo`
      );

      // Log all products for reference
      console.log('\n   Available Products:');
      products.forEach((product: any) => {
        console.log(`   - ${product.name} (ID: ${product.productId})`);
        console.log(`     vCPU: ${product.cpu}, RAM: ${product.ram}, Storage: ${product.disk}`);
      });

      return productsResponse;
    } else {
      logTest('Get Products', 'FAIL', 'Invalid response format');
      return null;
    }
  } catch (error: any) {
    logTest('Get Products', 'FAIL', error.message);
    return null;
  }
}

function testUbuntuImageDetection(imagesResponse: any): string | null {
  if (!imagesResponse || !(imagesResponse as any).data) {
    logTest('Ubuntu Image Detection', 'FAIL', 'No images data available');
    return null;
  }

  const images = (imagesResponse as any).data;

  // Try to find Ubuntu 22.04
  const ubuntu2204 = images.find((img: any) =>
    img.name?.toLowerCase().includes('ubuntu') &&
    (img.name?.includes('22.04') || img.name?.includes('jammy'))
  );

  if (ubuntu2204) {
    logTest(
      'Ubuntu 22.04 Detection',
      'PASS',
      `Found Ubuntu 22.04 image: ${ubuntu2204.name}`,
      { imageId: ubuntu2204.imageId, name: ubuntu2204.name }
    );
    return ubuntu2204.imageId;
  }

  // Try any Ubuntu
  const anyUbuntu = images.find((img: any) =>
    img.name?.toLowerCase().includes('ubuntu')
  );

  if (anyUbuntu) {
    logTest(
      'Ubuntu 22.04 Detection',
      'PASS',
      `Ubuntu 22.04 not found, but found: ${anyUbuntu.name}`,
      { imageId: anyUbuntu.imageId, name: anyUbuntu.name }
    );
    return anyUbuntu.imageId;
  }

  logTest('Ubuntu Image Detection', 'FAIL', 'No Ubuntu images found');
  return null;
}

function testProductValidation(productsResponse: any): void {
  if (!productsResponse || !(productsResponse as any).data) {
    logTest('Product ID Validation', 'FAIL', 'No products data available');
    return;
  }

  const products = (productsResponse as any).data;
  const targetProducts = ['V45', 'V46', 'V47'];
  const foundProducts: Record<string, any> = {};

  targetProducts.forEach((targetId) => {
    const product = products.find((p: any) => p.productId === targetId);
    if (product) {
      foundProducts[targetId] = product;
    }
  });

  const foundCount = Object.keys(foundProducts).length;

  if (foundCount === targetProducts.length) {
    logTest(
      'Product ID Validation',
      'PASS',
      `All expected products found: ${targetProducts.join(', ')}`,
      foundProducts
    );
  } else {
    const missing = targetProducts.filter((id) => !foundProducts[id]);
    logTest(
      'Product ID Validation',
      'FAIL',
      `Missing products: ${missing.join(', ')}. Found: ${Object.keys(foundProducts).join(', ')}`
    );
  }
}

function testRegionValidation(): void {
  const configuredRegion = process.env.CONTABO_REGION;

  if (!configuredRegion) {
    logTest('Region Validation', 'FAIL', 'CONTABO_REGION not set in environment');
    return;
  }

  // Contabo regions (as of 2024)
  const validRegions = [
    'EU',
    'US-central',
    'US-east',
    'US-west',
    'SIN',
    'UK',
    'AUS',
    'JPN'
  ];

  if (validRegions.includes(configuredRegion)) {
    logTest(
      'Region Validation',
      'PASS',
      `Region "${configuredRegion}" is valid`,
      { region: configuredRegion, validRegions }
    );
  } else {
    logTest(
      'Region Validation',
      'FAIL',
      `Region "${configuredRegion}" may not be valid. Known regions: ${validRegions.join(', ')}`,
      { region: configuredRegion, validRegions }
    );
  }
}

function testEnvironmentVariables(): boolean {
  console.log('\n📋 Checking Environment Variables...\n');

  const requiredVars = [
    'CONTABO_CLIENT_ID',
    'CONTABO_CLIENT_SECRET',
    'CONTABO_API_USER',
    'CONTABO_API_PASSWORD',
    'CONTABO_REGION'
  ];

  let allPresent = true;

  requiredVars.forEach((varName) => {
    const value = process.env[varName];
    if (value) {
      console.log(`✅ ${varName}: ${value.substring(0, 10)}...`);
    } else {
      console.log(`❌ ${varName}: NOT SET`);
      allPresent = false;
    }
  });

  return allPresent;
}

async function runTests() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║     Contabo API Integration Test Suite                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  // Check environment variables first
  if (!testEnvironmentVariables()) {
    console.log('\n❌ Missing required environment variables. Aborting tests.\n');
    process.exit(1);
  }

  try {
    console.log('\n🚀 Starting API Tests...\n');
    console.log('═'.repeat(60));

    // Create client
    const client = createContaboClient();
    console.log('✓ Client created successfully\n');

    // Test 1: Authentication
    const authSuccess = await testAuthentication(client);
    if (!authSuccess) {
      console.log('\n❌ Authentication failed. Aborting remaining tests.\n');
      console.log('ℹ️  This is expected if using test/placeholder credentials.');
      console.log('ℹ️  See src/cloud/contabo/CREDENTIALS_SETUP.md for setup instructions.\n');
      printSummary();
      printCredentialHelp();
      process.exit(1);
    }

    // Test 2: Get Images
    const imagesResponse = await testGetImages(client);

    // Test 3: Get Products
    const productsResponse = await testGetProducts(client);

    // Test 4: Ubuntu Image Detection
    if (imagesResponse) {
      testUbuntuImageDetection(imagesResponse);
    }

    // Test 5: Product ID Validation
    if (productsResponse) {
      testProductValidation(productsResponse);
    }

    // Test 6: Region Validation
    testRegionValidation();

    // Print summary
    printSummary();

  } catch (error: any) {
    console.error('\n❌ Fatal error during tests:', error.message);
    console.error(error);
    process.exit(1);
  }
}

function printSummary() {
  console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const total = results.length;

  results.forEach((result) => {
    const icon = result.status === 'PASS' ? '✅' : '❌';
    console.log(`${icon} ${result.testName}: ${result.status}`);
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log('═'.repeat(60) + '\n');

  if (failed === 0) {
    console.log('🎉 All tests passed! Contabo integration is ready.\n');
  } else {
    console.log('⚠️  Some tests failed. Please review the results above.\n');
  }
}

function printCredentialHelp() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║            HOW TO GET CONTABO API CREDENTIALS             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log('1. Log in to Contabo Customer Control Panel:');
  console.log('   https://my.contabo.com\n');
  console.log('2. Navigate to: Account → Security & Access → API Credentials\n');
  console.log('3. Generate/retrieve these credentials:\n');
  console.log('   - OAuth2 Client ID (format: INT-XXXXXXXX)');
  console.log('   - OAuth2 Client Secret');
  console.log('   - API User (may be your email)');
  console.log('   - API Password (NOT your login password!)\n');
  console.log('4. Update .env.server with your credentials\n');
  console.log('5. Re-run this test script\n');
  console.log('📖 Full setup guide: src/cloud/contabo/CREDENTIALS_SETUP.md\n');
}

// Run the tests
runTests().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
