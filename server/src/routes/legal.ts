import { Hono } from 'hono';

import { hardDeleteUser } from '../lib/account-deletion.ts';
import { db } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.ts';
import { issueOtpForPhone, verifyAndConsumeOtp } from '../lib/otp.ts';
import { normalizePhone } from '../lib/phone.ts';
import { smsSender } from '../sms/sender.ts';

// Legal + support pages and the Google-required WEB account-deletion flow,
// served as self-contained dark HTML from the same Hono server the app talks to
// (zero new infra). The web-deletion flow reuses the exact OTP logic (lib/otp.ts)
// and the exact hard-delete transaction (lib/account-deletion.ts) as the app.
//
// ── REVIEW GATE ─────────────────────────────────────────────────────────────
// The /privacy, /terms, /support COPY below is drafted from the code-verified
// data inventory (docs/data-inventory.md) and is LEGALLY BINDING once public. It
// still contains [PLACEHOLDER] tokens and has NOT been reviewed. Do not deploy
// this publicly until the copy is reviewed and the placeholders are filled. See
// docs/legal/*-draft.md for the source drafts and their review banner.
// Also: scope CORS (index.ts currently uses `*`, dev-only) before public.
// ────────────────────────────────────────────────────────────────────────────

export const legalRoutes = new Hono();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// One shell for every page — dark, responsive, no external assets.
function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · Meroa</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #030507; color: #F5F7FA;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; padding: 40px 22px 80px; }
  h1 { font-size: 28px; letter-spacing: -0.5px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 34px 0 10px; }
  h3 { font-size: 15px; margin: 22px 0 8px; color: #F5F7FA; }
  p, li { color: #C7CCD3; }
  a { color: #5AB0FF; }
  .muted { color: #8E949E; font-size: 14px; }
  .eyebrow { text-transform: uppercase; letter-spacing: 1.2px; font-size: 11px; font-weight: 700; color: #8E949E; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; display: block; overflow-x: auto; }
  th, td { border: 1px solid rgba(255,255,255,0.1); padding: 8px 10px; text-align: left; vertical-align: top; }
  th { color: #F5F7FA; }
  .card { background: #111318; border: 1px solid rgba(255,255,255,0.06); border-radius: 16px; padding: 22px; margin: 18px 0; }
  label { display: block; font-size: 13px; color: #8E949E; margin: 16px 0 6px; }
  input {
    width: 100%; padding: 13px 14px; font-size: 16px; color: #F5F7FA;
    background: #191C22; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
  }
  button {
    margin-top: 20px; width: 100%; padding: 14px; font-size: 16px; font-weight: 600;
    color: #fff; background: #0A6DF0; border: none; border-radius: 12px; cursor: pointer;
  }
  button.danger { background: #FF453A; }
  .error { color: #FF453A; font-size: 14px; margin-top: 14px; }
  .ok { color: #30D158; }
  footer { margin-top: 48px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,0.06); }
  footer a { margin-right: 16px; }
</style>
</head>
<body>
  <div class="wrap">
    ${bodyHtml}
    <footer class="muted">
      <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a>
    </footer>
  </div>
</body>
</html>`;
}

const SUPPORT_EMAIL = 'meroa.app@gmail.com';

// ── Privacy ──────────────────────────────────────────────────────────────────
const PRIVACY_BODY = `
  <span class="eyebrow">Meroa</span>
  <h1>Privacy Policy</h1>
  <p class="muted">Effective: July 20, 2026 · Last updated: July 20, 2026</p>
  <p>This Privacy Policy explains what information Meroa ("Meroa", "we", "us") collects, how we use it, and the choices you have. Meroa is a relationship-first AI companion app.</p>
  <p><strong>Who we are.</strong> Meroa is operated by Jun Kwon, California. Contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

  <div class="card">
    <h3>The short version</h3>
    <ul>
      <li>We collect your <strong>phone number</strong>, the <strong>messages</strong> you send Meroa, and the <strong>tasks, goals, and memories</strong> you create.</li>
      <li>Your <strong>messages are sent to a third-party AI service</strong> to generate replies. We ask for your explicit permission first, and you can withdraw it anytime.</li>
      <li>We <strong>do not</strong> use advertising, <strong>do not</strong> sell your data, and <strong>do not</strong> track you across other apps.</li>
      <li>You can <strong>export</strong> your data and <strong>delete your account</strong> — deletion is immediate and permanent.</li>
    </ul>
  </div>

  <h2>1. Information we collect</h2>
  <ul>
    <li><strong>Phone number</strong> — your account identity and for one-time login codes.</li>
    <li><strong>Your messages</strong> — what you send Meroa and the replies it generates.</li>
    <li><strong>Your content</strong> — tasks, goals, progress entries, and records you create.</li>
    <li><strong>Memories</strong> — facts Meroa remembers to personalize your experience; you can view, edit, mark sensitive, suppress, or delete these anytime.</li>
    <li><strong>Preferences</strong> — chat style, quiet hours, timezone, and your AI data-sharing consent.</li>
    <li><strong>Subscription status</strong> — verified through the app store and our payments processor.</li>
    <li><strong>Diagnostics</strong> — technical error reports, used to find and fix crashes.</li>
  </ul>
  <p><strong>What we do not collect.</strong> We do not collect location, contacts, photos, your microphone or camera, device advertising identifiers, or any product-analytics tracking. We do not use third-party analytics or advertising SDKs.</p>

  <h2>2. How we use your information</h2>
  <p>To hold a conversation, create and update your tasks and goals, remember relevant context, sign you in securely, generate AI replies (Section 3), manage your subscription, and keep the app reliable. We do not use your information for advertising and do not sell it.</p>

  <h2>3. AI processing and third-party sharing</h2>
  <p>Meroa's replies are generated by a <strong>third-party AI service</strong>. When you send a message, the <strong>content of that message</strong> — with the task/goal context needed to respond — is transmitted over an encrypted connection (HTTPS) to that service. We do <strong>not</strong> send your phone number or account identifier to the AI service.</p>
  <p><strong>Your consent is required.</strong> Before any of your messages are sent to the AI service, we ask for your explicit permission in the app. You can withdraw it anytime in Settings; chat then stops working until you grant it again, because the feature cannot function without it.</p>
  <table>
    <tr><th>Provider</th><th>What it receives</th><th>Why</th></tr>
    <tr><td>Our AI provider (a third-party AI service)</td><td>The content of your messages and related task/goal context</td><td>To generate replies</td></tr>
    <tr><td>Our payments provider and the app stores (Apple / Google)</td><td>Subscription status and an account identifier</td><td>To manage subscriptions</td></tr>
    <tr><td>Our error-monitoring provider</td><td>Technical error reports</td><td>To keep the app working</td></tr>
    <tr><td>Our hosting provider</td><td>Hosts our servers and database</td><td>Infrastructure</td></tr>
  </table>
  <p>We do not otherwise share, rent, or sell your personal information.</p>

  <h2>4. How your information is protected</h2>
  <p>Information is encrypted in transit (HTTPS) and at rest in our database. Login codes and session tokens are stored hashed, not in plain text.</p>

  <h2>5. How long we keep it</h2>
  <p>We keep your information for as long as your account exists. <strong>When you delete your account, we permanently and immediately delete your data.</strong> Login codes are short-lived and expire on their own. Deleting your account does not cancel a subscription bought through the App Store or Google Play — cancel that in the store to stop billing.</p>

  <h2>6. Your rights and choices</h2>
  <ul>
    <li><strong>Access / export</strong> your data from within the app.</li>
    <li><strong>Correct or delete memories</strong>, and tell Meroa not to bring something up.</li>
    <li><strong>Delete your account</strong> in the app or at <a href="/account/delete">our web deletion page</a> — immediate and permanent.</li>
    <li><strong>Withdraw AI consent</strong> anytime in Settings.</li>
  </ul>
  <h3>California privacy rights (CCPA/CPRA)</h3>
  <p>If you are a California resident, you have the following rights over your personal information:</p>
  <ul>
    <li><strong>Right to know / access</strong> — request the categories and specific pieces of personal information we have collected, the sources we collected it from, the business purpose, and the categories of third parties we share it with.</li>
    <li><strong>Right to delete</strong> — request deletion of the personal information we hold about you. You can do this yourself at any time by deleting your account (above); deletion is immediate and permanent.</li>
    <li><strong>Right to correct</strong> — request that we correct inaccurate personal information about you.</li>
    <li><strong>Right to opt out of sale or sharing</strong> — we do <strong>not</strong> sell your personal information and do <strong>not</strong> share it for cross-context behavioral advertising, so there is nothing to opt out of.</li>
    <li><strong>Right to limit the use of sensitive personal information</strong> — your messages may contain sensitive information. We use it only to provide the service to you (to reply, and to create and update the tasks, goals, and memories you ask for); we do not use it to infer characteristics about you, and we do not sell or share it.</li>
    <li><strong>Right to non-discrimination</strong> — we will not discriminate against you for exercising any of these rights.</li>
  </ul>
  <p>To exercise these rights, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> or use the in-app controls (data export, memory management, and account deletion). We verify requests using your account (your verified phone number), and you may use an authorized agent to submit a request on your behalf. If you live outside California, you may have other rights under your local law — contact us and we will do our best to help.</p>

  <h2>7. Children</h2>
  <p>Meroa is not directed to children under 13, and we do not knowingly collect their information. [REVIEW: confirm minimum age.]</p>

  <h2>8. International users and data transfers</h2>
  <p>Meroa is operated from the United States, and your information is stored and processed in the <strong>United States</strong> (our servers and database are hosted in a US-West region). We do not store your information outside the United States, though some of our service providers — for example, the third-party AI service that generates replies — may process the data they receive in other locations.</p>
  <p>If you access Meroa from outside the United States, you understand that your information will be transferred to, stored, and processed in the United States, where data-protection laws may differ from those in your country. Where a transfer of personal information is subject to laws requiring a specific safeguard, we will take steps to provide an appropriate one.</p>

  <h2>9. Changes</h2>
  <p>We may update this policy. If we materially change how your data is shared with the AI service, we will ask for your consent again first.</p>

  <h2>10. Contact</h2>
  <p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
`;

// ── Terms ────────────────────────────────────────────────────────────────────
const TERMS_BODY = `
  <span class="eyebrow">Meroa</span>
  <h1>Terms of Use</h1>
  <p class="muted">Effective: July 20, 2026 · Last updated: July 20, 2026</p>
  <p>These Terms are an agreement between you and Jun Kwon ("Meroa", "we", "us") governing your use of the Meroa app. By using Meroa, you agree to these Terms.</p>

  <h2>1. What Meroa is</h2>
  <p>Meroa is a relationship-first AI companion that helps you turn intentions into tasks and track goals through conversation. <strong>Meroa is an AI service — not a human</strong>, and is clearly identified as AI throughout.</p>
  <p><strong>Meroa is not a professional service.</strong> It is not a therapist, doctor, financial adviser, lawyer, or emergency service, and does not provide medical, mental-health, financial, or legal advice. <strong>If you are in crisis or have an emergency, contact your local emergency services or a qualified professional.</strong></p>

  <h2>2. Eligibility</h2>
  <p>You must be at least 13 years old and able to form a binding contract. [REVIEW: confirm minimum age.]</p>

  <h2>3. Your account</h2>
  <p>You sign in with your phone number and are responsible for keeping it and your account secure. Contact <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> if your account may be compromised.</p>

  <h2>4. Subscriptions and billing</h2>
  <p>Meroa is a paid subscription with a <strong>7-day free trial</strong> for new users. During the trial and while subscribed you have full access; without an active subscription, access is blocked but <strong>your data is not deleted</strong> — subscribing again resumes where you left off.</p>
  <ul>
    <li>Billed through the <strong>Apple App Store</strong> or <strong>Google Play</strong> under their terms, using your store account.</li>
    <li>Renews automatically unless cancelled at least 24 hours before the period ends.</li>
    <li><strong>Manage or cancel</strong> in your App Store or Google Play settings. Deleting your Meroa account does not cancel a store subscription.</li>
  </ul>
  <p class="muted">[REVIEW: refunds are governed by the app stores' policies — confirm any additional terms with counsel.]</p>

  <h2>5. Acceptable use</h2>
  <p>You agree not to use Meroa unlawfully or abusively; not to break, overload, reverse-engineer, or gain unauthorized access to it; and not to generate or distribute content that is illegal or violates others' rights. We may suspend or terminate accounts that violate these Terms.</p>

  <h2>6. Your content</h2>
  <p>You own the content you create (messages, tasks, goals, memories). You grant us a limited license to process it <strong>solely to operate the service for you</strong> — including sending your messages to a third-party AI service to generate replies, as described in the Privacy Policy. We do not sell your content.</p>

  <h2>7. AI-generated content</h2>
  <p>Meroa's replies are AI-generated and <strong>may be inaccurate or incomplete</strong>. You are responsible for how you use them, and should not treat them as professional advice (Section 1). You can report an offensive response from within the app.</p>

  <h2>8. Disclaimers</h2>
  <p>Meroa is provided <strong>"as is" and "as available", without warranties of any kind</strong>, whether express, implied, or statutory, to the maximum extent permitted by law. This includes any implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement.</p>
  <p>We do not warrant that the service will be uninterrupted, timely, secure, or error-free; that defects will be corrected; or that any AI-generated output will be accurate, complete, reliable, or suitable for your purposes. AI output may be wrong and is not professional advice (see Section 1). Reminders and notifications are provided on a best-effort basis and may be delayed or not delivered.</p>
  <p>Some jurisdictions do not allow the exclusion of certain warranties, so some of the above exclusions may not apply to you.</p>

  <h2>9. Limitation of liability</h2>
  <p>To the maximum extent permitted by law, Jun Kwon will not be liable for indirect, incidental, special, consequential, or punitive damages, or loss of data, arising from your use of Meroa. [REVIEW with counsel.]</p>

  <h2>10. Termination</h2>
  <p>You may stop using Meroa and delete your account anytime. We may suspend or terminate access for a violation of these Terms or where required by law.</p>

  <h2>11. Changes</h2>
  <p>We may update these Terms; continued use after an update means you accept the revised Terms.</p>

  <h2>12. Governing law</h2>
  <p>These Terms are governed by the laws of California, without regard to conflict-of-law rules. [REVIEW with counsel.]</p>

  <h2>13. Contact</h2>
  <p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
`;

// ── Support ──────────────────────────────────────────────────────────────────
const SUPPORT_BODY = `
  <span class="eyebrow">Meroa</span>
  <h1>Support</h1>
  <p>Need help with Meroa? You're in the right place.</p>

  <div class="card">
    <h3>Contact us</h3>
    <p>The fastest way to reach us is by email:</p>
    <p><a href="mailto:${SUPPORT_EMAIL}"><strong>${SUPPORT_EMAIL}</strong></a></p>
    <p class="muted">We read every message. We can't promise a specific response time, but including your device type (iPhone / Android), the app version, and a short description of what happened helps us help you faster.</p>
  </div>

  <h2>Common questions</h2>
  <h3>How do I delete my account?</h3>
  <p>In the app: <strong>You</strong> tab → <strong>Delete account</strong> (immediate and permanent). Or delete it on the web at <a href="/account/delete">our deletion page</a> — no app required.</p>
  <h3>How do I export my data?</h3>
  <p>In the app: <strong>You</strong> tab → <strong>Export my data</strong>.</p>
  <h3>How do I cancel my subscription?</h3>
  <p>Subscriptions are billed by the App Store or Google Play. Cancel in your store account settings. Deleting your Meroa account does not cancel a store subscription.</p>
  <h3>Is Meroa a real person?</h3>
  <p>No — Meroa is an AI companion, always identified as AI. It is not a therapist, doctor, or financial adviser. If you're in crisis or have an emergency, contact your local emergency services or a qualified professional.</p>
  <h3>How do I report an offensive AI response?</h3>
  <p>In chat, long-press the AI message and choose <strong>Report this response</strong>.</p>
  <h3>How is my data used?</h3>
  <p>See our <a href="/privacy">Privacy Policy</a>. In short: your messages are sent to a third-party AI service to generate replies (with your consent), and we don't sell your data or track you across other apps.</p>
`;

legalRoutes.get('/privacy', (c) => c.html(page('Privacy Policy', PRIVACY_BODY)));
legalRoutes.get('/terms', (c) => c.html(page('Terms of Use', TERMS_BODY)));
legalRoutes.get('/support', (c) => c.html(page('Support', SUPPORT_BODY)));

// ── Web account deletion (Google Play requirement) ───────────────────────────
// A server-rendered 3-step OTP flow — no app, no browser session. It reuses the
// exact OTP issuance/verification and the exact hard-delete transaction as the
// in-app path, so the two can never diverge.

function deleteStartPage(error?: string): string {
  return page(
    'Delete your account',
    `
    <span class="eyebrow">Meroa</span>
    <h1>Delete your account</h1>
    <p>Deleting your account <strong>permanently and immediately</strong> removes everything in it — your messages, tasks, goals, and memories. This cannot be undone.</p>
    <p class="muted">Deleting your account does <strong>not</strong> cancel your subscription. To stop billing, cancel it in the App Store or Google Play.</p>
    <div class="card">
      <form method="POST" action="/account/delete/request">
        <label for="phone">Your phone number</label>
        <input id="phone" name="phone" type="tel" inputmode="tel" placeholder="+1 555 555 0100" autocomplete="tel" required />
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
        <button type="submit">Send verification code</button>
      </form>
    </div>
    <p class="muted">We'll text a one-time code to confirm it's you.</p>
    `,
  );
}

function deleteCodePage(phone: string, error?: string): string {
  return page(
    'Enter your code',
    `
    <span class="eyebrow">Meroa</span>
    <h1>Enter your code</h1>
    <p>We texted a 6-digit code to <strong>${escapeHtml(phone)}</strong>. Enter it below to confirm deletion.</p>
    <div class="card">
      <form method="POST" action="/account/delete/verify">
        <input type="hidden" name="phone" value="${escapeHtml(phone)}" />
        <label for="code">Verification code</label>
        <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" required />
        ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
        <button type="submit" class="danger">Delete my account permanently</button>
      </form>
    </div>
    <p class="muted"><a href="/account/delete">Start over</a></p>
    `,
  );
}

function deleteDonePage(): string {
  return page(
    'Account deleted',
    `
    <span class="eyebrow">Meroa</span>
    <h1 class="ok">Your account has been deleted</h1>
    <p>Your Meroa account and all of its data have been permanently removed. There's nothing left to recover.</p>
    <p class="muted">Remember: if you had a subscription, deleting your account did not cancel it. Cancel it in the App Store or Google Play to stop billing.</p>
    `,
  );
}

legalRoutes.get('/account/delete', (c) => c.html(deleteStartPage()));

legalRoutes.post('/account/delete/request', async (c) => {
  const form = await c.req.parseBody();
  const rawPhone = typeof form.phone === 'string' ? form.phone : '';
  let phone: string;
  try {
    phone = normalizePhone(rawPhone);
  } catch {
    return c.html(deleteStartPage('That doesn’t look like a valid phone number. Try again.'), 400);
  }

  const result = await issueOtpForPhone(phone);
  if (result.status === 429) {
    return c.html(deleteStartPage('Too many requests. Please wait a little and try again.'), 429);
  }

  // Send the code even if we don't yet know whether an account exists — the same
  // non-enumerating behavior as the app's OTP request. Whether an account exists
  // is only acted on after the code is verified (below).
  await smsSender.send(phone, `Your Meroa code is ${result.code}`);
  return c.html(deleteCodePage(phone));
});

legalRoutes.post('/account/delete/verify', async (c) => {
  const form = await c.req.parseBody();
  const rawPhone = typeof form.phone === 'string' ? form.phone : '';
  const code = typeof form.code === 'string' ? form.code.trim() : '';
  let phone: string;
  try {
    phone = normalizePhone(rawPhone);
  } catch {
    return c.html(deleteStartPage('Something went wrong. Please start over.'), 400);
  }

  const verification = await verifyAndConsumeOtp(phone, code);
  if (!verification.ok) {
    const message =
      verification.error === 'invalid_code'
        ? 'That code isn’t right. Check it and try again.'
        : verification.error === 'too_many_attempts'
          ? 'Too many attempts. Please start over.'
          : 'That code has expired. Please start over.';
    return c.html(deleteCodePage(phone, message), verification.status);
  }

  // Verified. Delete the account if one exists for this phone. If none does, we
  // still show the same success page — the identity was proven and there's
  // nothing to delete, and revealing "no account" would leak who has one.
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.phoneE164, phone)).limit(1);
  if (user) await hardDeleteUser(user.id);

  return c.html(deleteDonePage());
});
