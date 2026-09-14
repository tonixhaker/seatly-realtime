import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorBodyDto {
  @ApiProperty({
    description:
      'Stable SCREAMING_SNAKE_CASE identity of the failure. Clients branch on this, never on message.',
    example: 'VALIDATION_FAILED',
  })
  code!: string;

  @ApiProperty({
    description: 'One human-readable English sentence, safe to show a user.',
    example: 'Request validation failed.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Per-code payload. Omitted entirely when empty.',
  })
  details?: Record<string, unknown>;
}

export class ErrorResponseDto {
  @ApiProperty({ type: () => ErrorBodyDto })
  error!: ErrorBodyDto;
}
