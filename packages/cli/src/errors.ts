/** An error with the exit code the CLI should end with. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}
