import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtension,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../error-response.dto';
import {
  LiveSeatsDto,
  SeatsConflictResponseDto,
  ValidateHoldsDto,
} from './dto/holds-response.dto';

export const INTERNAL_SECURITY_SCHEME = 'internal-token';

const badRequest = () =>
  ApiBadRequestResponse({
    description: 'VALIDATION_FAILED — malformed, unknown or invalid fields.',
    type: ErrorResponseDto,
  });

export const ApiCreateHold = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Hold seats for a session',
      description:
        'Acquisition is all or nothing. A partial conflict releases everything the request took before responding.',
    }),
    ApiCreatedResponse({
      description: 'Every requested seat is held by this session.',
    }),
    badRequest(),
    ApiConflictResponse({
      description:
        'SEATS_CONFLICT — at least one seat is already held by another session.',
      type: SeatsConflictResponseDto,
    }),
  );

export const ApiReleaseHold = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Release seats held by a session',
      description:
        'Idempotent. Seats held by another session are silently not released rather than erroring.',
    }),
    ApiNoContentResponse({ description: 'Release processed.' }),
    badRequest(),
  );

export const ApiLiveSeats = () =>
  applyDecorators(
    ApiOperation({
      summary: 'Read the live held and sold seats of an event',
      description:
        'The initial snapshot the web client applies before any WebSocket delta arrives.',
    }),
    ApiOkResponse({ type: LiveSeatsDto }),
    badRequest(),
  );

export const ApiValidateHolds = () =>
  applyDecorators(
    ApiTags('internal'),
    ApiExtension('x-internal', true),
    ApiSecurity(INTERNAL_SECURITY_SCHEME),
    ApiOperation({
      summary: 'INTERNAL — check that a session holds every requested seat',
      description:
        'Docker network only. Requires the X-Internal-Token header. Not callable from a browser. Called by seatly-api at checkout.',
    }),
    ApiOkResponse({ type: ValidateHoldsDto }),
    badRequest(),
    ApiUnauthorizedResponse({
      description: 'UNAUTHENTICATED — missing or wrong X-Internal-Token.',
      type: ErrorResponseDto,
    }),
  );
