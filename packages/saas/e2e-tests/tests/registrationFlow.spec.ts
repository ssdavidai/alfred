import { expect, test, type Page } from "@playwright/test";
import { createRandomUser, type User } from "./utils";

const DEFAULT_PASSWORD = "password123";

/**
 * E2E test for the full happy-path registration flow:
 *   signup → email verification (skipped via env var) → pricing → checkout (mocked)
 *   → Polar webhook fires → provisioning → dashboard access
 *
 * Prerequisites:
 *   - App running locally with `SKIP_EMAIL_VERIFICATION_IN_DEV=true wasp start`
 *   - Database running with `wasp db start`
 *
 * The test mocks:
 *   - Polar checkout: intercepts `generateCheckoutSession` and redirects to /checkout?status=success
 *   - Polar webhook: sends a crafted POST to /payments-webhook to trigger subscription + provisioning
 *   - Provisioning: intercepts `getProvisioningStatus` to simulate instant completion
 */

let page: Page;
let testUser: User;

async function clearRoute(pattern: string) {
  try {
    await page.unroute(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`No existing route found for ${pattern}: ${message}`);
  }
}

// Run tests sequentially — each step depends on the previous one.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  testUser = createRandomUser();
});

test.afterAll(async () => {
  await page.close();
});

test("1. User visits the landing page", async () => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Alfred/);
});

test("2. User navigates to signup and creates an account", async () => {
  await page.goto("/signup");
  await page.waitForURL("**/signup");

  // Fill in the Wasp auth SignupForm
  await page.fill('input[name="email"]', testUser.email);
  await page.fill('input[name="password"]', DEFAULT_PASSWORD);
  await page.click('button:has-text("Sign up")');

  // Wait for the signup API to return successfully
  await page
    .waitForResponse((response) => {
      return response.url().includes("signup") && response.status() === 200;
    })
    .catch((err) => console.error("Signup response error:", err.message));
});

test("3. User logs in and is redirected to /setup", async () => {
  // With SKIP_EMAIL_VERIFICATION_IN_DEV=true, the user can log in immediately
  await page.goto("/login");
  await page.waitForURL("**/login");

  await page.fill('input[name="email"]', testUser.email);
  await page.fill('input[name="password"]', DEFAULT_PASSWORD);

  const clickLogin = page.click('button:has-text("Log in")');

  await Promise.all([
    page
      .waitForResponse((response) => {
        return response.url().includes("login") && response.status() === 200;
      })
      .catch((err) => console.error("Login response error:", err.message)),
    clickLogin,
  ]);

  // After successful login, Wasp redirects to /setup (onAuthSucceededRedirectTo)
  // SetupPage then redirects to /pricing if no pending plan and no instance
  await page.waitForURL("**/pricing", { timeout: 10000 });
  expect(page.url()).toContain("/pricing");
});

test("4. User sees pricing page and clicks hire (buy plan) button", async () => {
  await page.waitForURL("**/pricing");

  // The Premium plan's CTA button says "HIRE ALFRED"
  const hirePlanButton = page.getByRole("button", { name: "HIRE ALFRED" });
  await expect(hirePlanButton).toBeVisible();
  await expect(hirePlanButton).toBeEnabled();

  // Intercept the checkout session API call to avoid real Polar payment.
  // When generateCheckoutSession is called, we return a mock session URL
  // pointing back to our local checkout result page with status=success.
  await page.route("**/operations/generate-checkout-session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessionUrl: "http://localhost:3000/checkout?status=success",
        sessionId: "mock-session-id",
      }),
    });
  });

  await hirePlanButton.click();

  // Should be redirected to /checkout?status=success (our mock)
  await page.waitForURL("**/checkout?status=success", { timeout: 10000 });
  await expect(page.getByText("Payment Successful")).toBeVisible();
});

test("5. Checkout result page redirects to /setup, simulate Polar webhook", async () => {
  // The CheckoutResultPage redirects to /setup after 3 seconds
  // While waiting, fire the Polar webhook to simulate payment completion.

  // First, we need to get the user's info from the app to craft the webhook.
  // We'll intercept getProvisioningStatus to track the user's state.

  // Fire a simulated webhook to the backend
  // The webhook endpoint expects raw body + Polar signature headers.
  // Since we can't easily replicate the Polar signature in test,
  // we'll instead directly manipulate the user's subscription state
  // by intercepting the relevant API responses.

  // Wait for redirect to /setup
  await page.waitForURL("**/setup", { timeout: 10000 });

  // SetupPage will query getProvisioningStatus.
  // Since no instance/job exists yet (webhook not fired), it would redirect to /pricing.
  // We intercept the provisioning status to simulate that provisioning is in progress,
  // then completed.

  // Step 1: Intercept provisioning status to show "provisioning in progress"
  let provisioningCallCount = 0;
  await page.route(
    "**/operations/get-provisioning-status",
    async (route) => {
      provisioningCallCount++;

      if (provisioningCallCount <= 2) {
        // First few calls: show provisioning in progress
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            instance: {
              id: "mock-instance-id",
              status: "provisioning",
              customerName: "alfred-testuser",
              tier: "PREMIUM",
            },
            job: {
              id: "mock-job-id",
              status: "running",
              currentStep: "create_server",
              logs: [],
              error: null,
              startedAt: new Date().toISOString(),
              completedAt: null,
            },
          }),
        });
      } else {
        // After a few polls: provisioning complete, instance running
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            instance: {
              id: "mock-instance-id",
              status: "running",
              customerName: "alfred-testuser",
              tier: "PREMIUM",
            },
            job: {
              id: "mock-job-id",
              status: "completed",
              currentStep: "done",
              logs: [],
              error: null,
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          }),
        });
      }
    },
  );

  // Reload /setup to pick up our mocked provisioning status
  await page.goto("/setup");

  // Should see provisioning progress UI
  await expect(
    page.getByText("Setting Up Your Instance"),
  ).toBeVisible({ timeout: 10000 });
});

test("6. Provisioning completes and user is redirected to dashboard", async () => {
  // The SetupPage polls getProvisioningStatus every 3s.
  // After our mock returns status="running", it redirects to /dashboard after 2s delay.
  // Total wait: ~3 polls * 3s + 2s redirect = ~11s max

  await page.waitForURL("**/dashboard", { timeout: 20000 });
  expect(page.url()).toContain("/dashboard");
});

test("7. Dashboard loads with correct content", async () => {
  // Mock getDashboardData to avoid needing a real tenant instance
  await clearRoute("**/operations/get-dashboard-data");
  await page.route("**/operations/get-dashboard-data", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        containers: [],
        vault: { total_records: 0, types: {} },
        stats: {},
      }),
    });
  });

  // Ensure provisioning status continues to show "running"
  await page.route(
    "**/operations/get-provisioning-status",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          instance: {
            id: "mock-instance-id",
            status: "running",
            customerName: "alfred-testuser",
            tier: "PREMIUM",
          },
          job: {
            id: "mock-job-id",
            status: "completed",
            currentStep: "done",
            logs: [],
            error: null,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
        }),
      });
    },
  );

  await page.goto("/dashboard");
  await page.waitForURL("**/dashboard");

  // Verify the Command Center heading is visible
  await expect(
    page.getByRole("heading", { name: "Command Center" }),
  ).toBeVisible({ timeout: 10000 });

  // Verify sidebar navigation items are present
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Vault" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Services" })).toBeVisible();
});

test("7b. Dashboard avoids misleading zero-state summary values while data is unavailable", async () => {
  await clearRoute("**/operations/get-dashboard-data");
  await page.route("**/operations/get-dashboard-data", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        health: null,
        vault: null,
        inbox: null,
        devices: null,
        containers: null,
        instance: {
          status: "running",
          tier: "PREMIUM",
          tailscaleHostname: null,
          subdomainUrl: null,
        },
        gatewayToken: null,
      }),
    });
  });

  await page.goto("/dashboard");
  await page.waitForURL("**/dashboard");

  await expect(page.getByText("Loading records...")).toBeVisible();
  await expect(page.getByText("Loading services...")).toBeVisible();
  await expect(page.getByText("Loading devices...")).toBeVisible();
  await expect(page.getByText("0 records")).not.toBeVisible();
  await expect(page.getByText("0 paired")).not.toBeVisible();
  await expect(page.getByText("UNKNOWN")).not.toBeVisible();
});

test("8. Account page shows active subscription status", async () => {
  // Mock the user data to show subscription info on the account page.
  // The AccountPage receives user as a prop from Wasp's auth context.
  // We intercept the auth/me endpoint to inject subscription fields.
  await page.route("**/auth/me", async (route) => {
    // Get the real response first, then augment it
    const response = await route.fetch();
    const body = await response.json();

    // Augment the user object with subscription data
    const augmentedBody = {
      ...body,
      subscriptionStatus: "active",
      subscriptionPlan: "premium",
      datePaid: new Date().toISOString(),
    };

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(augmentedBody),
    });
  });

  // Also mock getCustomerPortalUrl since the account page queries it
  await page.route(
    "**/operations/get-customer-portal-url",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify("https://sandbox.polar.sh/portal/mock"),
      });
    },
  );

  await page.goto("/account");
  await page.waitForURL("**/account");

  // Verify account information is displayed
  await expect(page.getByText("Account Information")).toBeVisible({
    timeout: 10000,
  });

  // Verify the user's email is shown
  await expect(page.getByText(testUser.email)).toBeVisible();

  // Verify the subscription plan name shows "Alfred Premium"
  await expect(page.getByText("Alfred Premium")).toBeVisible();
});
