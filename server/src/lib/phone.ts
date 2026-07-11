const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Normalizes to E.164. Bare 10-digit input is assumed US/Canada (+1). */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  if (E164_RE.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  throw new Error('invalid_phone');
}
