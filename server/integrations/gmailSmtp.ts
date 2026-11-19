import nodemailer from "nodemailer";

type OrganizationInviteEmail = {
  to: string;
  organizationName: string;
  inviterName: string;
  role: "admin" | "employee";
  inviteUrl: string;
};

export async function sendOrganizationInviteEmail(input: OrganizationInviteEmail) {
  const username = process.env.GOOGLE_SMTP_USER?.trim();
  const password = process.env.GOOGLE_SMTP_APP_PASSWORD?.replace(/\s/g, "");
  if (!username || !password) return { sent: false as const, reason: "not_configured" as const };

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: username, pass: password },
  });
  const safeOrganization = escapeHtml(input.organizationName);
  const safeInviter = escapeHtml(input.inviterName);
  const roleName = input.role === "admin" ? "organization admin" : "team member";
  const roleArticle = input.role === "admin" ? "an" : "a";
  const fromName = process.env.GOOGLE_SMTP_FROM_NAME?.trim() || "Volta Finance";

  try {
    await transport.sendMail({
      from: { name: fromName, address: username },
      to: input.to,
      subject: `You’re invited to join ${input.organizationName} on Volta Finance`,
      text: `${input.inviterName} invited you to join ${input.organizationName} on Volta Finance as ${roleArticle} ${roleName}.\n\nAccept this invitation using the button below. If you already have a Volta Finance account, you can also accept it from the pending invitations section of your personal workspace dashboard. Sign in or create your account with this email address: ${input.to}.\n\n${input.inviteUrl}\n\nThis invitation expires in seven days. Do not forward this email or its invitation button. If you weren’t expecting it, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;color:#1d2b24;max-width:560px;margin:0 auto;padding:32px"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#28765b;font-weight:700">Volta Finance · Team invitation</div><h1 style="font-size:26px;margin:20px 0 12px">Join ${safeOrganization}</h1><p>${safeInviter} invited you to join <strong>${safeOrganization}</strong> as ${roleArticle} ${roleName}.</p><p>Accept using the button below. If you already have a Volta Finance account, you can also accept from the pending invitations section of your personal workspace dashboard. Sign in or create your account with <strong>${escapeHtml(input.to)}</strong>.</p><p style="margin:28px 0"><a href="${escapeHtml(input.inviteUrl)}" style="background:#176b4c;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px;display:inline-block;font-weight:700">Accept invitation</a></p><p style="color:#64736a;font-size:13px">This invitation expires in seven days. Do not forward this email or its invitation button. If you weren’t expecting it, you can ignore this email.</p></div>`,
    });
    return { sent: true as const };
  } finally {
    transport.close();
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
