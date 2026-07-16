import { SeatEventsService, SeatsSold } from './seat-events.service';

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
});
