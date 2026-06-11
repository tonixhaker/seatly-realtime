import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
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
import { MAX_SEATS_PER_REQUEST } from './hold-seats.dto';
import { toInteger } from './to-integer';

const toNumericArray = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) {
    return value;
  }
  const items: unknown[] = Array.isArray(value) ? value : [value];
  return items.map((item) => toInteger(item));
};

export class ValidateHoldsQueryDto {
  @ApiProperty({ type: 'integer', minimum: 1, example: 1 })
  @Transform(({ value }: { value: unknown }) => toInteger(value))
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
    description: 'Repeat the parameter once per seat: seat_ids=4&seat_ids=7.',
    example: [4, 7],
  })
  @Transform(toNumericArray)
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
    example: '0b5f9d6e-3b4a-4c2d-8e1f-7a6b5c4d3e2f',
  })
  @IsUUID()
  session_id!: string;
}
