import { Logger, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";

import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    {
      // Keeps the original bytes on req.rawBody. The request fingerprint has
      // to hash what the client sent, not a re-serialised DTO.
      rawBody: true,
    },
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Closes the pg pool via DbModule's onApplicationShutdown.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = Number(config.get("PORT") ?? 8080);
  const instance = config.get<string>("INSTANCE_ID") ?? "api-local";

  await app.listen(port, "0.0.0.0");
  new Logger("Bootstrap").log(`${instance} listening on :${port}`);
}

void bootstrap();
