import type { FastifyReply } from 'fastify';

export function apiOk<T>(reply: FastifyReply, data: T) {
  return reply.send({ ok: true, data });
}

export function apiError(reply: FastifyReply, message: string, code: string, status = 400) {
  return reply.code(status).send({ ok: false, error: message, code });
}

export function fromServiceError(err: unknown): { message: string; code: string } {
  if (err instanceof Error) {
    const code = 'code' in err ? String((err as Error & { code: unknown }).code) : 'UNKNOWN';
    return { message: err.message, code };
  }
  return { message: String(err), code: 'UNKNOWN' };
}
