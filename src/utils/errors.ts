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
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const stackTrace = error instanceof Error ? error.stack : null;

    this.logger.error(`Error in ${context || 'unknown context'}: ${errorMessage}`, {
      stack: stackTrace,
    });
  }
}
export class BeeVersionError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class StampError extends Error {
  public constructor(message: string) {
    super(message);
  }
}
// TODO: introduce new errors for folder, drive management
export class DriveError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class SignerError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class FileInfoError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class FileError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class SubscriptionError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class GranteeError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export class SendShareMessageError extends Error {
  public constructor(message: string) {
    super(message);
  }
}
