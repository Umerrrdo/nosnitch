/** An error the user can act on. The CLI prints the message and the hint, never a stack trace. */
export class NosnitchError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "NosnitchError";
    this.hint = hint;
  }
}

/** Wrong command line: unknown command, missing argument, bad option. */
export class UsageError extends NosnitchError {
  constructor(message: string, hint = "Run nosnitch --help to see the commands and options.") {
    super(message, hint);
    this.name = "UsageError";
  }
}
