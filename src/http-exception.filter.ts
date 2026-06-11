import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface Envelope {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

const BY_STATUS: Record<number, [string, string]> = {
  [HttpStatus.BAD_REQUEST]: ['VALIDATION_FAILED', 'Request validation failed.'],
  [HttpStatus.UNAUTHORIZED]: ['UNAUTHENTICATED', 'Authentication is required.'],
  [HttpStatus.FORBIDDEN]: [
    'FORBIDDEN',
    'You are not allowed to perform this action.',
  ],
  [HttpStatus.NOT_FOUND]: ['NOT_FOUND', 'Resource not found.'],
  [HttpStatus.METHOD_NOT_ALLOWED]: [
    'METHOD_NOT_ALLOWED',
    'This method is not allowed on this resource.',
  ],
  [HttpStatus.PAYLOAD_TOO_LARGE]: [
    'PAYLOAD_TOO_LARGE',
    'The request body is too large.',
  ],
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: [
    'UNSUPPORTED_MEDIA_TYPE',
    'The request content type is not supported.',
  ],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const statusOf = (value: unknown): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const status =
    typeof value.status === 'number' ? value.status : value.statusCode;
  return typeof status === 'number' ? status : undefined;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const envelope = HttpExceptionFilter.describe(exception);

    if (envelope.status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} ${envelope.status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `${request.method} ${request.url} ${envelope.status} ${envelope.code}`,
      );
    }

    const body: { error: Record<string, unknown> } = {
      error: { code: envelope.code, message: envelope.message },
    };
    if (envelope.details !== undefined) {
      body.error.details = envelope.details;
    }
    response.status(envelope.status).json(body);
  }

  private static describe(exception: unknown): Envelope {
    if (!(exception instanceof HttpException)) {
      const raw = statusOf(exception);
      const mapped = raw === undefined ? undefined : BY_STATUS[raw];
      if (raw !== undefined && mapped !== undefined) {
        return { status: raw, code: mapped[0], message: mapped[1] };
      }
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      };
    }

    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (isRecord(payload) && typeof payload.code === 'string') {
      return {
        status,
        code: payload.code,
        message: typeof payload.message === 'string' ? payload.message : '',
        details: isRecord(payload.details) ? payload.details : undefined,
      };
    }

    const [code, message] = BY_STATUS[status] ?? [
      'INTERNAL_ERROR',
      'An unexpected error occurred.',
    ];

    if (isRecord(payload) && isStringArray(payload.message)) {
      return { status, code, message, details: { errors: payload.message } };
    }

    return { status, code, message };
  }
}
