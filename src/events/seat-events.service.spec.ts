import {
  SeatEventsService,
  SeatsHeld,
  SeatsReleased,
  SeatsSold,
} from './seat-events.service';

const SESSION = '0b5f9d6e-3b4a-4c2d-8e1f-7a6b5c4d3e2f';

describe('SeatEventsService', () => {
  let events: SeatEventsService;

  beforeEach(() => {
    jest.clearAllMocks();
    events = new SeatEventsService();
  });

  it('hands a sale to a registered listener exactly once', () => {
    const seen: SeatsSold[] = [];
    events.onSold((sale) => seen.push(sale));

    events.emitSold(42, [1, 2, 3]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ eventId: 42, seatIds: [1, 2, 3] });
  });

  it('reaches every listener when more than one is registered', () => {
    const first: SeatsSold[] = [];
    const second: SeatsSold[] = [];
    events.onSold((sale) => first.push(sale));
    events.onSold((sale) => second.push(sale));

    events.emitSold(42, [7]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('emits without a listener rather than throwing', () => {
    expect(() => events.emitSold(42, [1])).not.toThrow();
  });

  it('hands a hold to a registered listener with the session that took it', () => {
    const seen: SeatsHeld[] = [];
    events.onHeld((held) => seen.push(held));

    events.emitHeld(42, [1, 2], SESSION);

    expect(seen).toEqual([
      { eventId: 42, seatIds: [1, 2], sessionId: SESSION },
    ]);
  });

  it('hands a release to a registered listener exactly once', () => {
    const seen: SeatsReleased[] = [];
    events.onReleased((release) => seen.push(release));

    events.emitReleased(42, [3]);

    expect(seen).toEqual([{ eventId: 42, seatIds: [3] }]);
  });

  it('keeps the three channels apart, so a hold is not heard as a release', () => {
    const held: SeatsHeld[] = [];
    const released: SeatsReleased[] = [];
    const sold: SeatsSold[] = [];
    events.onHeld((event) => held.push(event));
    events.onReleased((event) => released.push(event));
    events.onSold((event) => sold.push(event));

    events.emitHeld(42, [1], SESSION);

    expect(held).toHaveLength(1);
    expect(released).toHaveLength(0);
    expect(sold).toHaveLength(0);
  });

  it('emits on the new channels without a listener rather than throwing', () => {
    expect(() => events.emitHeld(42, [1], SESSION)).not.toThrow();
    expect(() => events.emitReleased(42, [1])).not.toThrow();
  });
});
