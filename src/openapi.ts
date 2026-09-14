import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { buildOpenApiDocument } from './swagger';

async function generate(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  await app.init();
  const target = join(__dirname, '..', 'docs', 'openapi.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`,
  );
  await app.close();
}

void generate();
