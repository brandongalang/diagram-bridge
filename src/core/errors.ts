export class DiagramError extends Error {
  public readonly code: string;
  public readonly exitCode: number;
  public readonly details?: unknown;

  constructor(code: string, message: string, exitCode = 4, details?: unknown) {
    super(message);
    this.name = 'DiagramError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    Object.setPrototypeOf(this, DiagramError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      ...(this.details !== undefined ? { details: this.details } : {})
    };
  }
}
