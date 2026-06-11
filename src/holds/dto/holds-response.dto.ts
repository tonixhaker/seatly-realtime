import { ApiProperty } from '@nestjs/swagger';

export class LiveSeatsDto {
  @ApiProperty({ type: 'array', items: { type: 'integer' }, example: [5, 9] })
  held!: number[];

  @ApiProperty({
    type: 'array',
    items: { type: 'integer' },
    example: [3, 7, 11],
  })
  sold!: number[];
}

export class ValidateHoldsDto {
  @ApiProperty({
    description: 'True only when the session holds every requested seat.',
    example: false,
  })
  valid!: boolean;

  @ApiProperty({
    type: 'array',
    items: { type: 'integer' },
    description: 'The requested seats this session does not hold.',
    example: [7],
  })
  missing!: number[];
}

export class SeatsConflictDetailsDto {
  @ApiProperty({
    type: 'array',
    items: { type: 'integer' },
    description: 'The requested seats already held by another session.',
    example: [4, 7],
  })
  conflicting_seat_ids!: number[];
}

export class SeatsConflictErrorDto {
  @ApiProperty({ enum: ['SEATS_CONFLICT'], example: 'SEATS_CONFLICT' })
  code!: string;

  @ApiProperty({ example: 'Some of the requested seats are already held.' })
  message!: string;

  @ApiProperty({ type: () => SeatsConflictDetailsDto })
  details!: SeatsConflictDetailsDto;
}

export class SeatsConflictResponseDto {
  @ApiProperty({ type: () => SeatsConflictErrorDto })
  error!: SeatsConflictErrorDto;
}
