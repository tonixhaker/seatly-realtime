import { ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'socket.io';
import { SeatEventsService } from '../events/seat-events.service';
import { HoldsService } from '../holds/holds.service';
import { EventsGateway, roomOf } from './events.gateway';

const EVENT = 42;

interface FakeSocket {
  join: jest.Mock;
  emit: jest.Mock;
}

describe('roomOf', () => {
  it('names one room per event and nothing else', () => {
    expect(roomOf(1)).toBe('event:1');
    expect(roomOf(200042)).toBe('event:200042');
  });
});

describe('EventsGateway', () => {
  let gateway: EventsGateway;
  let holds: { liveSeats: jest.Mock };
  let seatEvents: SeatEventsService;
  let socket: FakeSocket;
  let room: { emit: jest.Mock };
  let server: { to: jest.Mock; emit: jest.Mock };

  const asSocket = (): Socket => socket as unknown as Socket;

  beforeEach(() => {
    jest.clearAllMocks();
    holds = { liveSeats: jest.fn().mockResolvedValue({ held: [], sold: [] }) };
    seatEvents = new SeatEventsService();
    socket = { join: jest.fn(), emit: jest.fn() };
    room = { emit: jest.fn() };
    server = { to: jest.fn().mockReturnValue(room), emit: jest.fn() };

    gateway = new EventsGateway(holds as unknown as HoldsService, seatEvents);
    Object.defineProperty(gateway, 'server', { value: server });
    gateway.onModuleInit();
  });

  describe('join', () => {
    it('joins the room and sends that socket a snapshot of the event', async () => {
      holds.liveSeats.mockResolvedValue({ held: [3, 7], sold: [5] });

      await gateway.handleJoin({ event_id: EVENT }, asSocket());

      expect(socket.join).toHaveBeenCalledWith('event:42');
      expect(socket.emit).toHaveBeenCalledWith('snapshot', {
        event_id: EVENT,
        held: [3, 7],
        sold: [5],
      });
    });

    it('joins the room BEFORE reading state, so no delta falls in the gap', async () => {
      await gateway.handleJoin({ event_id: EVENT }, asSocket());

      expect(socket.join.mock.invocationCallOrder[0]).toBeLessThan(
        holds.liveSeats.mock.invocationCallOrder[0],
      );
      expect(holds.liveSeats.mock.invocationCallOrder[0]).toBeLessThan(
        socket.emit.mock.invocationCallOrder[0],
      );
    });

    it('sends the snapshot to the joining socket only, never to the room', async () => {
      await gateway.handleJoin({ event_id: EVENT }, asSocket());

      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(server.to).not.toHaveBeenCalled();
      expect(server.emit).not.toHaveBeenCalled();
    });

    it('sends a fresh snapshot on a repeat join, because reconnect depends on it', async () => {
      await gateway.handleJoin({ event_id: EVENT }, asSocket());
      await gateway.handleJoin({ event_id: EVENT }, asSocket());

      expect(socket.join).toHaveBeenCalledTimes(2);
      expect(socket.emit).toHaveBeenCalledTimes(2);
    });

    it('joins every event a socket asks for, keeping the earlier rooms', async () => {
      await gateway.handleJoin({ event_id: 1 }, asSocket());
      await gateway.handleJoin({ event_id: 2 }, asSocket());

      expect(socket.join.mock.calls).toEqual([['event:1'], ['event:2']]);
    });

    it.each([
      ['an empty object', {}],
      ['a string event_id', { event_id: '7' }],
      ['zero', { event_id: 0 }],
      ['a negative id', { event_id: -1 }],
      ['a fractional id', { event_id: 1.5 }],
      ['NaN', { event_id: Number.NaN }],
      ['Infinity', { event_id: Number.POSITIVE_INFINITY }],
      ['null event_id', { event_id: null }],
      ['null', null],
      ['undefined', undefined],
      ['a bare string', '7'],
      ['a bare number', 7],
      ['an array', [7]],
    ])('joins nothing and emits nothing for %s', async (_name, payload) => {
      await gateway.handleJoin(payload, asSocket());

      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).not.toHaveBeenCalled();
      expect(holds.liveSeats).not.toHaveBeenCalled();
    });

    it('stays in the room and emits nothing when the sold state is unavailable', async () => {
      holds.liveSeats.mockRejectedValue(
        new ServiceUnavailableException({ code: 'SOLD_STATE_UNAVAILABLE' }),
      );

      await expect(
        gateway.handleJoin({ event_id: EVENT }, asSocket()),
      ).resolves.toBeUndefined();

      expect(socket.join).toHaveBeenCalledWith('event:42');
      expect(socket.emit).not.toHaveBeenCalled();
    });
  });

  describe('broadcasts', () => {
    it('sends seat.held to the event room without a session', () => {
      seatEvents.emitHeld(EVENT, [1, 2]);

      expect(server.to).toHaveBeenCalledWith('event:42');
      expect(room.emit).toHaveBeenCalledWith('seat.held', {
        event_id: EVENT,
        seat_ids: [1, 2],
      });
      const [[, payload]] = room.emit.mock.calls as [string, object][];
      expect(Object.keys(payload).sort()).toEqual(['event_id', 'seat_ids']);
    });

    it('sends seat.released to the event room without a session', () => {
      seatEvents.emitReleased(EVENT, [3]);

      expect(server.to).toHaveBeenCalledWith('event:42');
      expect(room.emit).toHaveBeenCalledWith('seat.released', {
        event_id: EVENT,
        seat_ids: [3],
      });
    });

    it('sends seat.sold to the event room without a session', () => {
      seatEvents.emitSold(EVENT, [4]);

      expect(server.to).toHaveBeenCalledWith('event:42');
      expect(room.emit).toHaveBeenCalledWith('seat.sold', {
        event_id: EVENT,
        seat_ids: [4],
      });
    });

    it('never broadcasts globally, because one event must not see another', () => {
      seatEvents.emitHeld(EVENT, [1]);
      seatEvents.emitReleased(EVENT, [1]);
      seatEvents.emitSold(EVENT, [1]);

      expect(server.emit).not.toHaveBeenCalled();
    });

    it.each([
      ['seat.held', () => seatEvents.emitHeld(EVENT, [])],
      ['seat.released', () => seatEvents.emitReleased(EVENT, [])],
      ['seat.sold', () => seatEvents.emitSold(EVENT, [])],
    ])('drops an empty %s rather than framing it', (_name, emit) => {
      emit();

      expect(server.to).not.toHaveBeenCalled();
      expect(room.emit).not.toHaveBeenCalled();
    });
  });
});
