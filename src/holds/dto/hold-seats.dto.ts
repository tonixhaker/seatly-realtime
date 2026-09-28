import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export const MAX_SEATS_PER_REQUEST = 50;

export class HoldSeatsDto {
  @ApiProperty({ type: 'integer', minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  event_id!: number;

  @ApiProperty({
    type: 'array',
    items: { type: 'integer', minimum: 1 },
    minItems: 1,
    maxItems: MAX_SEATS_PER_REQUEST,
    uniqueItems: true,
    example: [1, 2],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_SEATS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(Number.MAX_SAFE_INTEGER, { each: true })
  seat_ids!: number[];

  @ApiProperty({
    format: 'uuid',
    description: 'Issued by the web client. Guests have one too.',
    example: '0b5f9d6e-3b4a-4c2d-8e1f-7a6b5c4d3e2f',
  })
  @IsUUID()
  session_id!: string;
}
