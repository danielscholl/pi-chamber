/**
 * Vendored from Archon `packages/workflows/src/command-validation.ts`.
 * See ARCHON_VERSION.md for sync sha.
 *
 * Validates a command name to prevent path traversal and enforce naming conventions.
 */
export function isValidCommandName(name: string): boolean {
  // Reject names with path separators or parent directory references
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return false;
  }
  // Reject empty names or names starting with .
  if (!name || name.startsWith('.')) {
    return false;
  }
  return true;
}
