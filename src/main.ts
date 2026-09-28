import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { applyCors } from './cors';
import { EnvConfig } from './env.schema';
import { HttpExceptionFilter } from './http-exception.filter';
import { listen } from './listen';
import { buildOpenApiDocument } from './swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get(ConfigService<EnvConfig, true>);
  applyCors(app, config.get('WEB_ORIGIN'));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));
  app.enableShutdownHooks([], { useProcessExit: true });
  await listen(app, config.get('PORT'), config.get('INTERNAL_PORT'));
}
void bootstrap();
