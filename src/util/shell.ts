/** Single quotes for a POSIX shell, always, so the value stays one word whatever it holds. */
export function singleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Quotes a value for a POSIX shell, leaving plain paths as they are, for commands a person reads. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : singleQuote(value);
}
