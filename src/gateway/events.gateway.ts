import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { SeatEventsService } from '../events/seat-events.service';
import { HoldsService } from '../holds/holds.service';

export const EVENTS_NAMESPACE = '/events';

export const roomOf = (eventId: number): string => `event:${String(eventId)}`;

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

const joinedEventId = (payload: unknown): number | null => {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }

  const eventId = (payload as { event_id?: unknown }).event_id;

  if (
    typeof eventId !== 'number' ||
    !Number.isInteger(eventId) ||
    eventId < 1
  ) {
    return null;
  }

  return eventId;
};

@WebSocketGateway({ namespace: EVENTS_NAMESPACE })
export class EventsGateway implements OnModuleInit {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  private readonly server!: Namespace;

  constructor(
    private readonly holds: HoldsService,
    private readonly seatEvents: SeatEventsService,
  ) {}

  onModuleInit(): void {
    this.seatEvents.onHeld(({ eventId, seatIds, sessionId }) =>
      this.broadcast('seat.held', eventId, seatIds, {
        event_id: eventId,
        seat_ids: seatIds,
        session_id: sessionId,
      }),
    );

    this.seatEvents.onReleased(({ eventId, seatIds }) =>
      this.broadcast('seat.released', eventId, seatIds, {
        event_id: eventId,
        seat_ids: seatIds,
      }),
    );

    this.seatEvents.onSold(({ eventId, seatIds }) =>
      this.broadcast('seat.sold', eventId, seatIds, {
        event_id: eventId,
        seat_ids: seatIds,
      }),
    );
  }

  @SubscribeMessage('join')
  async handleJoin(
    @MessageBody() payload: unknown,
    @ConnectedSocket() socket: Socket,
  ): Promise<void> {
    const eventId = joinedEventId(payload);

    if (eventId === null) {
      this.logger.warn(`ignoring a malformed join: ${JSON.stringify(payload)}`);
      return;
    }

    await socket.join(roomOf(eventId));

    try {
      const { held, sold } = await this.holds.liveSeats(eventId);

      socket.emit('snapshot', { event_id: eventId, held, sold });
    } catch (error) {
      this.logger.warn(
        `no snapshot for event ${String(eventId)}: ${reasonOf(error)}`,
      );
    }
  }

  private broadcast(
    name: string,
    eventId: number,
    seatIds: number[],
    payload: Record<string, unknown>,
  ): void {
    if (seatIds.length === 0) {
      return;
    }

    this.server.to(roomOf(eventId)).emit(name, payload);
  }
}
