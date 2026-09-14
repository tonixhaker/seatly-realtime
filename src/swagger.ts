import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { INTERNAL_SECURITY_SCHEME } from './holds/holds.swagger';
import { INTERNAL_TOKEN_HEADER } from './holds/internal-token.guard';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Seatly Realtime')
    .setDescription('Seat holds and live seat state')
    .setVersion('1.0.0')
    .addTag('holds', 'Public seat hold and live seat state routes.')
    .addTag(
      'internal',
      'Reachable on the docker network only and requires the X-Internal-Token header. Never call these from a browser.',
    )
    .addApiKey(
      { type: 'apiKey', name: INTERNAL_TOKEN_HEADER, in: 'header' },
      INTERNAL_SECURITY_SCHEME,
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
