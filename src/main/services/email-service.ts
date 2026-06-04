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

  async send(
    subject: string,
    html: string,
    attachments: EmailAttachment[] = [],
  ): Promise<void> {
    const config = this.readConfig();
    if (!config) throw new Error('SMTP not configured. Set up email credentials in the Agent Config → Email tab.');

    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });

    await transporter.sendMail({
      from: config.from,
      to: config.to.join(', '),
      subject,
      html,
      attachments: attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  }
}
