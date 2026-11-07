export class PermanentJobError extends Error {
  readonly permanent = true;
}

export class TransientJobError extends Error {
  readonly permanent = false;
}

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

export function isPermanent(error: unknown): boolean {
  return error instanceof PermanentJobError || (typeof error === 'object' && error !== null && 'permanent' in error && error.permanent === true);
}
