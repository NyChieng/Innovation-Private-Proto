import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

// Unsent emails are also appended here (gitignored), so the test suite can
// read a code without an inbox. Anyone who can read it can already read the
// database on the same machine.
export const OUTBOX = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.outbox.log');

/*
 * Outgoing email - for now only administrators' recovery codes.
 *
 * With SMTP_USER and SMTP_PASS in .env it sends for real (Gmail by default,
 * through an app password - see .env.example). Without them it prints the
 * message in the server terminal instead, so the whole flow can be shown in a
 * demo with nothing set up, and switched to real email by configuration alone.
 */

let transport = null;

function configured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  if (transport) return transport;
  const auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
  transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth,
    })
    : nodemailer.createTransport({ service: 'gmail', auth });
  return transport;
}

/** Sends, or prints in the terminal when no mail account is configured. */
export async function sendMail({ to, subject, text }) {
  if (!configured()) {
    const bar = '-'.repeat(64);
    console.log(`\n  \x1b[33m${bar}\x1b[0m`);
    console.log('  \x1b[1mEmail (not sent - no SMTP_USER / SMTP_PASS in .env)\x1b[0m');
    console.log(`  To:      ${to}\n  Subject: ${subject}\n`);
    console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
    console.log(`  \x1b[33m${bar}\x1b[0m\n`);
    try {
      fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), to, subject, text }) + '\n');
    } catch { /* the terminal copy is the one that matters */ }
    return { printed: true };
  }
  await getTransport().sendMail({
    from: process.env.SMTP_FROM || `FloraScan <${process.env.SMTP_USER}>`,
    to, subject, text,
  });
  return { sent: true };
}

/** h***@gmail.com - enough for the owner to recognise, not enough to collect. */
export function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!name || !domain) return null;
  return `${name.slice(0, Math.min(2, name.length - 1) || 1)}***@${domain}`;
}
