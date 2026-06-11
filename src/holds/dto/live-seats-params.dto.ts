import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { toInteger } from './to-integer';

export class LiveSeatsParamsDto {
  @ApiProperty({ type: 'integer', minimum: 1, example: 1 })
  @Transform(({ value }: { value: unknown }) => toInteger(value))
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  id!: number;
}
