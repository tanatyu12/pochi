export const ExitCode = {
  OK: 0,
  INTERNAL: 1,
  CONFIG: 2,
  LLM: 3,
  SLACK: 4,
  SOURCES: 5,
  INTERRUPTED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class PochiError extends Error {
  readonly exitCode: ExitCodeValue;

  constructor(message: string, exitCode: ExitCodeValue, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

export function exitCodeOf(err: unknown): ExitCodeValue {
  return err instanceof PochiError ? err.exitCode : ExitCode.INTERNAL;
}
