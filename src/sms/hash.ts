// Non-cryptographic — this only needs to tell "byte-identical resend" apart from "a different
// message", not resist tampering. FNV-1a keeps the sms_drafts.body_hash column short and indexed
// instead of storing/comparing the full raw text for uniqueness.
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
