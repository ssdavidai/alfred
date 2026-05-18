// Terms of Service — restyled with M0 tokens (paper/wool/ink/marginalia/brass)
// and Playfair / EB Garamond / JetBrains Mono typography. Copy is unchanged
// from the legacy black-glass version.

import React from "react";

export default function TermsOfServicePage() {
  return (
    <div className="paper min-h-screen" style={{ color: "var(--ink)" }}>
      <div className="max-w-3xl mx-auto px-6 py-16">
        <div className="mb-10">
          <a
            href="/"
            className="font-mono text-[10px] uppercase tracking-[0.28em]"
            style={{ color: "var(--brass)" }}
          >
            ← alfred.black
          </a>
        </div>
        <h1 className="font-display text-5xl tracking-tight mb-2">
          Terms of Service
        </h1>
        <p
          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Last updated: March 1, 2026
        </p>

        <div className="space-y-8 font-body text-[16px] leading-[1.65]">

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">1. Agreement to Terms</h2>
            <p>These Terms of Service ("Terms") govern your access to and use of Alfred Black, operated by <strong>Example LLC</strong>, 123 Example Street, Anytown ("Company," "we," "us," or "our").</p>
            <p className="mt-3">By creating an account or accessing the Service, you agree to be bound by these Terms and our Privacy Policy. If you do not agree, do not use the Service.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">2. Description of Service</h2>
            <p>Alfred Black is a subscription-based AI butler service. The Service provides:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>A dedicated AI assistant instance, provisioned exclusively for your account on cloud infrastructure</li>
              <li>An encrypted personal knowledge vault storing your notes, memories, people, places, and documents</li>
              <li>A persistent background AI worker that monitors streams, processes tasks, and takes autonomous actions on your behalf</li>
              <li>Integration capabilities with third-party services via credentials you provide (email, calendar, messaging, etc.)</li>
              <li>An inbox for review of AI-generated content and autonomous actions</li>
              <li>Device management and secure remote access via Tailscale VPN</li>
              <li>API access via bearer token authentication for programmatic control</li>
              <li>An administrative web dashboard at alfred.black</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">3. Eligibility</h2>
            <p>You must be at least 18 years old and capable of entering into a binding contract. The Service is intended for personal and professional productivity use. You may not use the Service on behalf of a third party without their explicit consent.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">4. Account Registration</h2>
            <p>You must provide a valid email address and verify it to activate your account. You are responsible for maintaining the confidentiality of your credentials and all activity under your account. Notify us immediately at <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a> if you suspect unauthorized access.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">5. Subscriptions and Payment</h2>
            <p>Access to Alfred Black requires an active paid subscription. Subscriptions are billed on a recurring basis (monthly or annually, as selected at checkout) through our payment processor, Polar. By subscribing, you authorize recurring charges to your payment method.</p>
            <p className="mt-3">Subscription plans, pricing, and features are as described on our pricing page at the time of purchase. We reserve the right to change pricing with 30 days' notice to active subscribers.</p>
            <p className="mt-3"><strong>Refunds:</strong> We offer a 7-day refund for new subscribers who have not provisioned or meaningfully used their AI instance. After 7 days or first use, subscriptions are non-refundable. Contact <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a> for refund requests.</p>
            <p className="mt-3"><strong>Cancellation:</strong> You may cancel at any time. Your subscription remains active until the end of the billing period. We do not prorate partial months.</p>
            <p className="mt-3"><strong>Past due accounts:</strong> Failure to pay may result in suspension of your instance. Data is retained for 30 days following suspension before deletion.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">6. Infrastructure and Instance Provisioning</h2>
            <p>Upon activation, we provision a dedicated virtual machine on Acme Cloud Cloud infrastructure in your selected region, running your personal Alfred instance. The instance is connected to a private Tailscale network and assigned a subdomain (e.g., yourname.alfred.black).</p>
            <p className="mt-3">We reserve the right to migrate instances to equivalent or superior hardware. Downtime during maintenance will be minimized and communicated in advance where feasible.</p>
            <p className="mt-3">You are responsible for the third-party credentials you store in your instance. We encrypt credentials at rest but cannot guarantee security against all attack vectors. Use strong, unique passwords and revoke credentials you no longer need.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">7. Autonomous AI Actions</h2>
            <p>Alfred Black operates as an autonomous AI agent capable of taking actions on your behalf, including but not limited to: sending messages, managing calendar events, executing web searches, and interacting with third-party APIs using credentials you provide.</p>
            <p className="mt-3">You acknowledge and agree that:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>You are solely responsible for reviewing and approving sensitive autonomous actions</li>
              <li>The AI may produce incorrect, incomplete, or inappropriate outputs</li>
              <li>We are not liable for consequences arising from autonomous actions taken by your AI instance</li>
              <li>You remain legally responsible for all actions taken by your AI instance using your credentials and on your behalf</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">8. Acceptable Use</h2>
            <p>You may not use the Service to:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>Violate any applicable law or regulation</li>
              <li>Harass, threaten, or harm others</li>
              <li>Generate or distribute spam, phishing, or malicious content</li>
              <li>Scrape, crawl, or extract data from third-party services in violation of their terms</li>
              <li>Attempt to gain unauthorized access to other systems or accounts</li>
              <li>Resell, sublicense, or share your instance with third parties</li>
              <li>Use the Service to train competing AI models or products</li>
              <li>Reverse engineer, decompile, or extract the source code of the Service</li>
            </ul>
            <p className="mt-3">Violation of acceptable use may result in immediate termination without refund.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">9. API Access</h2>
            <p>Subscribers may generate API keys to access their instance programmatically. API keys grant full access to your Alfred instance and must be kept confidential. You are responsible for all activity performed via your API keys. Revoke compromised keys immediately via your dashboard.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">10. Intellectual Property</h2>
            <p>The Alfred Black platform, software, trademarks, and branding are owned by Example LLC. You retain ownership of all content you input into the Service, including vault data, notes, and credentials.</p>
            <p className="mt-3">You grant us a limited, non-exclusive license to process your content solely for the purpose of operating and improving the Service on your behalf. We do not sell, share, or use your personal content to train AI models without your explicit consent.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">11. Data and Privacy</h2>
            <p>Your use of the Service is also governed by our <a href="/pp" className="underline" style={{ color: "var(--brass)" }}>Privacy Policy</a>, which is incorporated into these Terms by reference. Please review it carefully.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">12. Disclaimers</h2>
            <p className="font-mono text-[12px] uppercase tracking-[0.06em]" style={{ color: "var(--marginalia)" }}>The Service is provided "as is" and "as available" without warranties of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or free of harmful components.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">13. Limitation of Liability</h2>
            <p>To the maximum extent permitted by applicable law, Example LLC and its officers, directors, employees, and agents shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of data, profits, or goodwill, arising from your use of or inability to use the Service.</p>
            <p className="mt-3">Our total liability to you for any claims arising from these Terms or the Service shall not exceed the amount you paid to us in the 12 months preceding the claim.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">14. Indemnification</h2>
            <p>You agree to indemnify and hold harmless Example LLC from any claims, damages, losses, liabilities, costs, and expenses (including reasonable legal fees) arising from: (a) your use of the Service; (b) your violation of these Terms; (c) actions taken by your AI instance using your credentials; or (d) your violation of any third party's rights.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">15. Termination</h2>
            <p>We may suspend or terminate your account immediately if you violate these Terms, engage in fraudulent activity, or if we are required to do so by law. You may terminate your account at any time by canceling your subscription and contacting <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a>.</p>
            <p className="mt-3">Upon termination, your AI instance will be decommissioned. We will provide a 30-day window to export your vault data before deletion.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">16. Governing Law</h2>
            <p>These Terms are governed by the laws of the State of California, United States, without regard to conflict of law principles. Any disputes shall be resolved in the courts of San Francisco County, California.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">17. Changes to Terms</h2>
            <p>We may update these Terms from time to time. We will notify active subscribers via email at least 14 days before material changes take effect. Continued use of the Service after changes constitutes acceptance.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">18. Contact</h2>
            <p>Questions about these Terms? Contact us at:</p>
            <div className="mt-3" style={{ color: "var(--marginalia)" }}>
              <p><strong>Example LLC</strong></p>
              <p>123 Example Street</p>
              <p>Anytown</p>
              <p>United States</p>
              <p className="mt-2"><a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a></p>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
