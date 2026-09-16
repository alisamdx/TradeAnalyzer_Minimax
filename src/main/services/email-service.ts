// EmailService — sends emails via SMTP using the same credentials configured
// in the Agent screen (Config → Email). Reads from agentProjectPath/.env.

import nodemailer from 'nodemailer';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string[];
}

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/** What the relay reported back, so a non-arrival can be diagnosed from the log alone. */
export interface EmailSendOutcome {
  readonly accepted: string[];
  readonly rejected: string[];
  readonly response: string;
  readonly messageId: string;
  readonly htmlBytes: number;
  readonly clippedByGmail: boolean;
}

export class EmailService {
  constructor(private readonly getAgentProjectPath: () => string) {}

  private readConfig(): SmtpConfig | null {
    const projectPath = this.getAgentProjectPath();
    if (!projectPath) return null;
    const envPath = join(projectPath, '.env');
    if (!existsSync(envPath)) return null;

    const env = parseEnvFile(envPath);
    const host = env['SMTP_HOST'] ?? '';
    const user = env['SMTP_USER'] ?? '';
    const pass = env['SMTP_PASS'] ?? '';
    if (!host || !user || !pass) return null;

    const to = (env['EMAIL_LIST'] ?? '').split(',').map(e => e.trim()).filter(Boolean);
    if (to.length === 0) return null;

    return {
      host,
      port: parseInt(env['SMTP_PORT'] ?? '587', 10),
      user,
      pass,
      from: env['SMTP_FROM'] || user,
      to,
    };
  }

  isConfigured(): boolean {
    return this.readConfig() !== null;
  }

  /**
   * What the relay actually said — not "we called sendMail and it did not throw".
   *
   * `sendMail` rejects only when EVERY recipient is refused, so a partial
   * rejection resolved and was logged as `sent`. And `accepted` means the
   * submission relay took the message, never that it was delivered: on
   * 2026-09-14 and 2026-09-15 the gate email logged `sent`, with no error, and
   * did not arrive. The operator had no way to tell a relay failure from a
   * spam-folder landing from a size problem, because none of the three leaves a
   * trace here. Now the outcome carries the relay's own words and the byte size,
   * which is the first thing to check when a large message vanishes.
   */
  async send(
    subject: string,
    html: string,
    attachments: EmailAttachment[] = [],
  ): Promise<EmailSendOutcome> {
    const config = this.readConfig();
    if (!config) throw new Error('SMTP not configured. Set up email credentials in the Agent Config → Email tab.');

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });

    const info = await transporter.sendMail({
      from: config.from,
      to: config.to.join(', '),
      subject,
      html,
      attachments: attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    }) as {
      accepted?: unknown[];
      rejected?: unknown[];
      response?: string;
      messageId?: string;
    };

    const accepted = (info.accepted ?? []).map(String);
    const rejected = (info.rejected ?? []).map(String);
    return {
      accepted,
      rejected,
      response: info.response ?? '',
      messageId: info.messageId ?? '',
      htmlBytes: Buffer.byteLength(html, 'utf8'),
      // Gmail truncates the visible body above ~102 KB and shows "[Message
      // clipped]". A gate email that lists every finding crosses that on a bad
      // day, so the number is reported rather than inferred.
      clippedByGmail: Buffer.byteLength(html, 'utf8') > 102_400,
    };
  }
}
