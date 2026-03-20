// server/emailService.js
// Nodemailer-based email service for account approval flow.

import nodemailer from 'nodemailer';

const SMTP_HOST     = process.env.SMTP_HOST;
const SMTP_PORT     = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER     = process.env.SMTP_USER;
const SMTP_PASS     = process.env.SMTP_PASS;
const ADMIN_EMAIL   = process.env.APPROVAL_EMAIL || 'cindy@pnthrfunds.com';
const FRONTEND_URL  = process.env.FRONTEND_URL  || 'https://pnthr100-scanner.vercel.app';

function createTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export async function sendApprovalRequestEmail({ applicantName, applicantEmail, approveUrl, denyUrl }) {
  const transporter = createTransport();
  if (!transporter) {
    console.warn('[EMAIL] SMTP not configured — skipping approval request email');
    console.log(`[EMAIL] Would have sent to ${ADMIN_EMAIL}: approve=${approveUrl} deny=${denyUrl}`);
    return;
  }
  await transporter.sendMail({
    from: `"PNTHR Funds" <${SMTP_USER}>`,
    to: ADMIN_EMAIL,
    subject: `New Account Request: ${applicantName}`,
    html: `
      <div style="background:#0a0a0a;color:#fff;padding:30px;font-family:Arial;max-width:600px;">
        <h1 style="color:#D4A017;margin:0 0 8px;">PNTHR FUNDS</h1>
        <h2 style="color:#fff;margin:0 0 24px;">New Account Request</h2>
        <p><strong>Name:</strong> ${applicantName}</p>
        <p><strong>Email:</strong> ${applicantEmail}</p>
        <p><strong>Requested:</strong> ${new Date().toLocaleString()}</p>
        <br/>
        <a href="${approveUrl}" style="background:#28a745;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;margin-right:12px;display:inline-block;">
          ✓ APPROVE
        </a>
        <a href="${denyUrl}" style="background:#dc3545;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block;">
          ✗ DENY
        </a>
      </div>
    `,
  });
}

export async function sendWelcomeEmail({ to, name }) {
  const transporter = createTransport();
  if (!transporter) {
    console.warn('[EMAIL] SMTP not configured — skipping welcome email');
    return;
  }
  await transporter.sendMail({
    from: `"PNTHR Funds" <${SMTP_USER}>`,
    to,
    subject: 'Welcome to PNTHR Den — Account Approved',
    html: `
      <div style="background:#0a0a0a;color:#fff;padding:30px;font-family:Arial;max-width:600px;">
        <h1 style="color:#D4A017;margin:0 0 8px;">PNTHR FUNDS</h1>
        <h2 style="color:#28a745;margin:0 0 24px;">Account Approved</h2>
        <p>Welcome ${name}! Your PNTHR Den account has been approved.</p>
        <p>You can now log in at:</p>
        <a href="${FRONTEND_URL}" style="color:#D4A017;">${FRONTEND_URL}</a>
      </div>
    `,
  });
}

export async function sendDenialEmail({ to, name }) {
  const transporter = createTransport();
  if (!transporter) {
    console.warn('[EMAIL] SMTP not configured — skipping denial email');
    return;
  }
  await transporter.sendMail({
    from: `"PNTHR Funds" <${SMTP_USER}>`,
    to,
    subject: 'PNTHR Den — Account Request Update',
    html: `
      <div style="background:#0a0a0a;color:#fff;padding:30px;font-family:Arial;max-width:600px;">
        <h1 style="color:#D4A017;margin:0 0 8px;">PNTHR FUNDS</h1>
        <h2 style="color:#fff;margin:0 0 24px;">Account Request Update</h2>
        <p>Hi ${name}, unfortunately your request for a PNTHR Den account was not approved at this time.</p>
        <p>If you believe this is an error, please contact us directly.</p>
      </div>
    `,
  });
}
