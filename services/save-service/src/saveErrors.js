export class SaveValidationError extends Error {}
export class SaveConflictError extends Error {
  constructor(envelope = null) {
    super("save changed concurrently; retry with the latest envelope");
    this.envelope = envelope;
    this.retryable = true;
  }
}
