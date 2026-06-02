// Privacy Policy — restyled with M0 tokens (paper/wool/ink/marginalia/brass)
// and Playfair / EB Garamond / JetBrains Mono typography. Copy is unchanged
// from the legacy black-glass version.

import React from "react";

export default function PrivacyPolicyPage() {
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
          Privacy Policy
        </h1>
        <p
          className="font-mono text-[10px] uppercase tracking-[0.22em] mb-10"
          style={{ color: "var(--marginalia)" }}
        >
          Last updated: March 1, 2026
        </p>

        <div className="space-y-8 font-body text-[16px] leading-[1.65]">

          <section>
            <p>This Privacy Policy describes how <strong>Example LLC</strong> ("Company," "we," "us," or "our"), operator of Alfred Black, collects, uses, stores, and shares information about you when you use our website at alfred.black and our AI butler service (collectively, the "Service").</p>
            <p className="mt-3">By using the Service, you agree to the collection and use of information as described in this policy.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">1. Information We Collect</h2>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.1 Account Information</h3>
            <p>When you create an account, we collect your email address and any optional profile information you provide (e.g., name, username).</p>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.2 Payment Information</h3>
            <p>Payments are processed by <strong>Polar</strong> (our payment processor). We do not store your full credit card number. We receive and store your subscription status, plan type, payment date, and a payment processor customer ID for billing management.</p>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.3 Vault and Personal Data</h3>
            <p>The core of Alfred Black is your personal knowledge vault. This may include:</p>
            <ul className="list-disc list-inside mt-2 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>Notes, memories, reminders, and tasks you create or dictate</li>
              <li>Information about people, places, and organizations in your life</li>
              <li>Files and documents you upload</li>
              <li>Emails, calendar events, and messages synced from connected services</li>
              <li>Credentials for third-party services (encrypted at rest)</li>
              <li>Voice call transcripts and summaries</li>
              <li>Web browsing context and research you instruct Alfred to perform</li>
            </ul>
            <p className="mt-3">This data lives in your dedicated instance and is accessible only to you (and the AI operating on your behalf).</p>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.4 Usage and Technical Data</h3>
            <p>We collect technical information to operate and improve the Service, including:</p>
            <ul className="list-disc list-inside mt-2 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>Dashboard activity logs (pages visited, features used)</li>
              <li>AI worker activity logs (tasks run, integrations triggered)</li>
              <li>Instance health metrics (CPU, memory, container status)</li>
              <li>IP addresses and browser/device type for security purposes</li>
              <li>API key usage timestamps</li>
            </ul>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.5 Analytics</h3>
            <p>We use <strong>Plausible Analytics</strong> (self-hosted, privacy-preserving) to understand aggregate usage of alfred.black. Plausible does not use cookies and does not collect personally identifiable information. No cross-site tracking occurs.</p>

            <h3 className="font-display italic text-xl mt-4 mb-2">1.6 Communications</h3>
            <p>If you contact us via <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a>, we retain your email and the contents of your message to respond to your inquiry.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">2. How We Use Your Information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>Provision, operate, and maintain your dedicated AI instance</li>
              <li>Process payments and manage your subscription</li>
              <li>Send transactional emails (account verification, password reset, billing notifications)</li>
              <li>Monitor instance health and respond to incidents</li>
              <li>Investigate security incidents and enforce our Terms of Service</li>
              <li>Comply with legal obligations</li>
              <li>Improve the Service based on aggregate, anonymized usage patterns</li>
            </ul>
            <p className="mt-3">We do <strong>not</strong> use your personal vault content to train AI models, sell it to third parties, or serve advertisements.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">3. Third-Party Services and Data Sharing</h2>
            <p>We share limited data with the following categories of service providers, strictly to operate the Service:</p>

            <div className="mt-4 space-y-4">
              <div>
                <p className="font-display italic text-lg">Infrastructure (Hetzner Cloud)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Your AI instance runs on dedicated virtual machines hosted by Hetzner Cloud GmbH. Hetzner processes data under EU data protection law (GDPR). Data center locations: EU (Germany, Finland) by default.</p>
              </div>
              <div>
                <p className="font-display italic text-lg">Networking (Tailscale — optional, principal-owned)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Optionally, you may connect your Alfred instance to <em>your own</em> Tailscale tailnet via the in-product Connect button on the Channels page. When you do, Tailscale Inc. provides the coordination service for the resulting WireGuard mesh; Alfred neither hosts your tailnet nor sees its membership. The connection is opt-in, you authenticate against your own Tailscale account, and you can disconnect at any time. Tailscale does not have access to the content of your traffic.</p>
              </div>
              <div>
                <p className="font-display italic text-lg">Payments (Polar)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Subscription billing is handled by Polar. Your payment data is subject to Polar's privacy policy. We receive subscription status and billing metadata only.</p>
              </div>
              <div>
                <p className="font-display italic text-lg">Email Delivery (Mailgun)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Transactional emails (verification, password reset, billing) are sent via Mailgun. Email addresses are passed to Mailgun solely for delivery purposes.</p>
              </div>
              <div>
                <p className="font-display italic text-lg">AI Processing (Anthropic, OpenAI, and others)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Your AI instance uses large language model APIs to process your requests. Content you ask Alfred to process may be transmitted to these providers. We configure API calls with data retention minimization where available. Check the respective provider privacy policies for details on how they handle API inputs.</p>
              </div>
              <div>
                <p className="font-display italic text-lg">DNS and CDN (Cloudflare)</p>
                <p className="font-body text-[15px] mt-1" style={{ color: "var(--marginalia)" }}>Traffic to alfred.black passes through Cloudflare for DDoS protection and DNS. Cloudflare may log IP addresses and request metadata per their privacy policy.</p>
              </div>
            </div>

            <p className="mt-4">We do not sell your personal data. We do not share your vault contents with any third party except as necessary to fulfill your explicit instructions (e.g., sending an email you requested).</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">4. Third-Party Credentials</h2>
            <p>Alfred Black allows you to store credentials for third-party services (Google, email providers, messaging apps, etc.) to enable integrations. These credentials are:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>Encrypted at rest using AES-256 encryption</li>
              <li>Stored only on your dedicated instance</li>
              <li>Never transmitted to us or any party other than the target service</li>
              <li>Used solely to perform actions you authorize Alfred to take</li>
            </ul>
            <p className="mt-3">You are responsible for the third-party accounts you connect. Remove credentials immediately if you suspect compromise.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">5. Cookies</h2>
            <p>The alfred.black website uses the following cookies:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li><strong>Session cookies:</strong> Required for authentication. Deleted when you close your browser.</li>
              <li><strong>Cookie consent:</strong> A single cookie stores your cookie consent preference.</li>
            </ul>
            <p className="mt-3">We do not use tracking cookies, advertising cookies, or third-party analytics cookies. Plausible Analytics, our analytics tool, is cookieless.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">6. Data Retention</h2>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li><strong>Active subscribers:</strong> Data is retained for the duration of your subscription.</li>
              <li><strong>Cancelled/suspended accounts:</strong> Instance data is retained for 30 days after cancellation, then permanently deleted.</li>
              <li><strong>Account records:</strong> Basic account metadata (email, billing history) may be retained for up to 7 years for tax and legal compliance.</li>
              <li><strong>Support emails:</strong> Retained for 2 years unless you request deletion.</li>
            </ul>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">7. Data Security</h2>
            <p>We implement industry-standard security measures including:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li>TLS encryption for all data in transit</li>
              <li>AES-256 encryption for stored credentials</li>
              <li>Optional Tailscale tailnet you control — you join your instance to your own tailnet from the Channels page if and when you choose</li>
              <li>Per-instance SSH keypairs with no shared credentials</li>
              <li>Regular security updates to instance software</li>
            </ul>
            <p className="mt-3">No method of transmission or storage is 100% secure. We will notify you promptly in the event of a data breach affecting your personal information.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">8. Your Rights</h2>
            <p>Depending on your location, you may have the following rights:</p>
            <ul className="list-disc list-inside mt-3 space-y-2" style={{ color: "var(--marginalia)" }}>
              <li><strong>Access:</strong> Request a copy of personal data we hold about you</li>
              <li><strong>Correction:</strong> Request correction of inaccurate data</li>
              <li><strong>Deletion:</strong> Request deletion of your account and associated data</li>
              <li><strong>Portability:</strong> Request an export of your vault data in a machine-readable format</li>
              <li><strong>Objection:</strong> Object to certain processing activities</li>
              <li><strong>Withdrawal of consent:</strong> Withdraw consent where processing is based on consent</li>
            </ul>
            <p className="mt-3">To exercise your rights, contact <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a>. We will respond within 30 days.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">9. Children's Privacy</h2>
            <p>The Service is not directed to individuals under the age of 18. We do not knowingly collect personal information from children. If you believe we have inadvertently collected such information, contact us immediately.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">10. International Transfers</h2>
            <p>We are based in the United States. If you are accessing the Service from outside the US, your information may be transferred to and processed in the US and EU (Hetzner infrastructure). We apply appropriate safeguards for international transfers in compliance with applicable data protection laws.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">11. California Privacy Rights (CCPA)</h2>
            <p>If you are a California resident, you have the right to know what personal information we collect, the right to delete it, and the right to opt out of its sale. We do not sell personal information. To exercise CCPA rights, contact <a href="mailto:help@alfred.black" className="underline" style={{ color: "var(--brass)" }}>help@alfred.black</a>.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">12. Changes to This Policy</h2>
            <p>We may update this Privacy Policy from time to time. We will notify active subscribers via email before material changes take effect. The updated policy will always be available at alfred.black/pp.</p>
          </section>

          <section>
            <h2 className="font-display text-2xl tracking-tight mb-3">13. Contact</h2>
            <p>Questions or concerns about this Privacy Policy:</p>
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
