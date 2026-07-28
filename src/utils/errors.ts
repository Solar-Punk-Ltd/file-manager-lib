import { Logger } from './logger';

export class ErrorHandler {
  private static instance: ErrorHandler;
  private logger = Logger.getInstance();

  private constructor() {}

  public static getInstance(): ErrorHandler {
    if (!ErrorHandler.instance) {
      ErrorHandler.instance = new ErrorHandler();
    }

    return ErrorHandler.instance;
  }

  handleError(error: unknown, context?: string): void {
    const isError = error instanceof Error;
    const name = isError ? error.name : 'UnknownError';
    const message = isError ? error.message : String(error);

    this.logger.error(`[${name}] in ${context ?? 'unknown context'}: ${message}`, {
      stack: isError ? error.stack : undefined,
      cause: isError ? this.formatCause(error.cause) : undefined,
    });
  }

  private formatCause(cause: unknown, depth = 0): string | undefined {
    if (cause === undefined || depth > 5) {
      return undefined;
    }

    if (cause instanceof Error) {
      const nested = this.formatCause(cause.cause, depth + 1);
      return nested ? `${cause.name}: ${cause.message} <- ${nested}` : `${cause.name}: ${cause.message}`;
    }

    return String(cause);
  }
}

export class FileManagerError extends Error {
  public constructor(message: string, name: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = name;
  }
}

export class BeeVersionError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'BeeVersionError', cause);
  }
}

export class StampError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'StampError', cause);
  }
}

export class DriveError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'DriveError', cause);
  }
}

export class FolderError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'FolderError', cause);
  }
}

export class SignerError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'SignerError', cause);
  }
}

// TODO: rename to FileRecordError in v2
// Record/feed/metadata failures (record not found, wrong drive, version collision)
export class FileInfoError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'FileInfoError', cause);
  }
}

// Content/IO failures (reading, uploading, or downloading file bytes)
export class FileError extends FileManagerError {
  public constructor(message: string, cause?: unknown) {
    super(message, 'FileError', cause);
  }
}
