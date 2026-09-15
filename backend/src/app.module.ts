import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { DbModule } from "./db/db.module";
import { HealthController } from "./health/health.controller";
import { PaymentsModule } from "./payments/payments.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    DbModule,
    PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
