# Contabo API Testing Checklist

Quick reference for getting the Contabo integration fully tested and operational.

## Pre-Testing Setup

### Step 1: Obtain Contabo API Credentials

- [ ] Log in to Contabo Customer Control Panel: https://my.contabo.com
- [ ] Navigate to: **Account** → **Security & Access** → **API Credentials**
- [ ] Record your **OAuth2 Client ID** (format: `INT-XXXXXXXX`)
- [ ] Record your **OAuth2 Client Secret**
- [ ] Create/verify your **API User** (may be your email)
- [ ] Set/reset your **API Password** (NOT your login password!)

### Step 2: Update Environment Variables

Edit `/Users/Shared/dev/alfredos-cloud/template/app/.env.server`:

- [ ] Update `CONTABO_CLIENT_ID=` with your OAuth2 Client ID
- [ ] Update `CONTABO_CLIENT_SECRET=` with your OAuth2 Client Secret
- [ ] Update `CONTABO_API_USER=` with your API user
- [ ] Update `CONTABO_API_PASSWORD=` with your API password
- [ ] Verify `CONTABO_REGION=US-east` (or your preferred region)
- [ ] Verify `CONTABO_DEFAULT_IMAGE=ubuntu-22.04`

## Testing

### Step 3: Run Mock Tests (Optional)

```bash
cd /Users/Shared/dev/alfredos-cloud/template/app
npx tsx src/cloud/contabo/test-contabo-mock.ts
```

Expected result: ✅ All mock tests pass

### Step 4: Run Live API Tests

```bash
cd /Users/Shared/dev/alfredos-cloud/template/app
npx tsx src/cloud/contabo/test-contabo-api.ts
```

Expected results:
- [ ] ✅ OAuth Authentication: PASS
- [ ] ✅ Get Images: PASS
- [ ] ✅ Get Products: PASS
- [ ] ✅ Ubuntu 22.04 Detection: PASS
- [ ] ✅ Product ID Validation (V45, V46, V47): PASS
- [ ] ✅ Region Validation: PASS

### Step 5: Document Findings

Record the actual values returned by the API:

**Ubuntu 22.04 Image:**
- Image ID: `_________________________`
- Image Name: `_________________________`

**Products:**
- V45 exists? [ ] Yes [ ] No
  - CPU: _____ RAM: _____ Disk: _____
- V46 exists? [ ] Yes [ ] No
  - CPU: _____ RAM: _____ Disk: _____
- V47 exists? [ ] Yes [ ] No
  - CPU: _____ RAM: _____ Disk: _____

**Alternative Products (if V45/V46/V47 don't exist):**
- Product ID: _____ Name: _____ Specs: _____
- Product ID: _____ Name: _____ Specs: _____
- Product ID: _____ Name: _____ Specs: _____

## Code Updates (If Needed)

### Step 6: Update Product Mappings

If V45, V46, V47 don't exist in your account, update:

File: `src/cloud/contabo/provisioner.ts`

```typescript
function getProductIdForPlan(plan: string): string {
  const productMap: Record<string, string> = {
    solo: 'YOUR_SMALL_PRODUCT_ID',      // Replace with actual ID
    team: 'YOUR_MEDIUM_PRODUCT_ID',     // Replace with actual ID
    enterprise: 'YOUR_LARGE_PRODUCT_ID', // Replace with actual ID
  };
  return productMap[plan] || 'YOUR_SMALL_PRODUCT_ID';
}
```

### Step 7: Update Default Image (If Needed)

If Ubuntu 22.04 image ID is different, update `.env.server`:

```bash
CONTABO_DEFAULT_IMAGE=actual-image-id-from-api
```

## End-to-End Testing (Optional but Recommended)

### Step 8: Create Test Environment

**WARNING:** This will create a real VM and incur costs!

- [ ] Verify you have budget for a test VM
- [ ] Note: Minimum billing period is usually 1 month
- [ ] Choose smallest instance (V45 or equivalent)

Test steps:
1. Create a test environment in the app
2. Provision VM for the environment
3. Monitor provisioning logs
4. Verify VM appears in Contabo portal
5. Verify DNS record is created
6. Test SSH access to VM
7. Verify cloud-init completed successfully
8. Deprovision and verify cleanup

### Step 9: Verify Integration

- [ ] VM provisioned successfully
- [ ] IP address assigned
- [ ] DNS record created (`{slug}.alfredos.site`)
- [ ] SSH works: `ssh root@{ip-address}`
- [ ] Docker installed on VM
- [ ] SSL certificate obtained (Let's Encrypt)
- [ ] Deprovisioning works
- [ ] DNS record cleaned up

## Production Readiness

### Step 10: Security

- [ ] Move credentials from `.env.server` to secrets manager (AWS Secrets Manager, etc.)
- [ ] Set up credential rotation schedule
- [ ] Create separate API users for different environments (dev, staging, prod)
- [ ] Enable audit logging for API calls
- [ ] Review and limit API permissions

### Step 11: Monitoring

- [ ] Set up alerts for provisioning failures
- [ ] Monitor Contabo API rate limits
- [ ] Track VM creation/deletion
- [ ] Monitor costs per environment
- [ ] Set up budget alerts

### Step 12: Documentation

- [ ] Document actual product IDs in use
- [ ] Document actual image IDs in use
- [ ] Create runbook for common operations
- [ ] Document troubleshooting steps
- [ ] Create cost estimation guide

## Troubleshooting

### If Authentication Fails

1. [ ] Double-check all four credentials are correct
2. [ ] Verify you're using API password (not login password)
3. [ ] Check Contabo account is active
4. [ ] Try logging into Contabo portal to verify account status
5. [ ] Contact Contabo support if credentials are definitely correct

### If Product IDs Don't Match

1. [ ] Run test script to see available products
2. [ ] Update `getProductIdForPlan()` in `provisioner.ts`
3. [ ] Re-run tests to verify

### If Image Not Found

1. [ ] Run test script to see available images
2. [ ] Update `findUbuntuImage()` in `provisioner.ts`
3. [ ] Or update `CONTABO_DEFAULT_IMAGE` in `.env.server`

## Sign-Off

Once all tests pass and documentation is updated:

- [ ] All API tests passing
- [ ] Product IDs verified/updated
- [ ] Image IDs verified/updated
- [ ] End-to-end test completed (optional)
- [ ] Documentation updated
- [ ] Team notified
- [ ] Production credentials secured

**Tested by:** ___________________________
**Date:** ___________________________
**Status:** [ ] READY FOR PRODUCTION [ ] NEEDS WORK

---

## Quick Reference

**Test Commands:**
```bash
# Mock test (no credentials needed)
npx tsx src/cloud/contabo/test-contabo-mock.ts

# Live API test (requires credentials)
npx tsx src/cloud/contabo/test-contabo-api.ts
```

**Documentation:**
- Setup: [CREDENTIALS_SETUP.md](./CREDENTIALS_SETUP.md)
- Summary: [TEST_SUMMARY.md](./TEST_SUMMARY.md)
- Full Report: [TEST_REPORT.md](./TEST_REPORT.md)
- Usage: [README.md](./README.md)

**Support:**
- Contabo Portal: https://my.contabo.com
- Contabo API Docs: https://api.contabo.com/
- Contabo Support: https://contabo.com/en/support/
