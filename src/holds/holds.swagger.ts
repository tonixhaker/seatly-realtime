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
  ApiServiceUnavailableResponse,
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

export const BEARER_SECURITY_SCHEME = 'bearer';

const optionalBearer: Record<string, string[]>[] = [
  {},
  { [BEARER_SECURITY_SCHEME]: [] },
];

const unverifiedCredential = () => [
  ApiUnauthorizedResponse({
    description:
      'UNAUTHENTICATED — a bearer token was presented and seatly-api rejected it. A request with no token is a guest and is never refused here.',
    type: ErrorResponseDto,
  }),
  ApiServiceUnavailableResponse({
    description:
      'AUTH_STATE_UNAVAILABLE — a bearer token was presented and seatly-api could not be asked about it, so the caller is neither verified nor assumed to be a guest.',
    type: ErrorResponseDto,
  }),
];

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
        'Acquisition is all or nothing. A partial conflict releases everything the request took before responding. The bearer token is optional: with one the hold records the buyer, without one the caller is an anonymous guest identified by session_id alone.',
      security: optionalBearer,
    }),
    ApiCreatedResponse({
      description: 'Every requested seat is held by this session.',
    }),
    badRequest(),
    ...unverifiedCredential(),
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
        'Idempotent. Seats held by another session are silently not released rather than erroring. The bearer token is optional, and ownership is decided by session_id either way.',
      security: optionalBearer,
    }),
    ApiNoContentResponse({ description: 'Release processed.' }),
    badRequest(),
    ...unverifiedCredential(),
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
    ApiServiceUnavailableResponse({
      description:
        'SOLD_STATE_UNAVAILABLE — the sold cache is cold and seatly-api is unreachable, so the sold set is unknown rather than empty.',
      type: ErrorResponseDto,
    }),
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
