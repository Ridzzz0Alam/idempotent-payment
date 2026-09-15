import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Inject,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { FastifyReply, FastifyRequest } from "fastify";

import { CreatePaymentDto } from "./dto/create-payment.dto";
import { PaymentsService } from "./payments.service";

@Controller("payments")
export class PaymentsController {
  private readonly instance: string;

  constructor(
    private readonly payments: PaymentsService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.instance = config.get<string>("INSTANCE_ID") ?? "api-local";
  }

  @Post()
  async create(
    @Headers("idempotency-key") key: string | undefined,
    @Body() dto: CreatePaymentDto,
    @Req() req: RawBodyRequest<FastifyRequest>,
    @Res() reply: FastifyReply,
  ) {
    reply.header("X-Served-By", this.instance);
    reply.type("application/json");

    if (!key?.trim()) {
      throw new BadRequestException("missing Idempotency-Key header");
    }

    // The hash must cover the bytes the client actually sent. Re-serialising
    // the validated DTO would produce different bytes for the same request
    // and make the fingerprint check meaningless.
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException(
        "raw body unavailable; start the app with rawBody enabled",
      );
    }

    const outcome = await this.payments.create(key.trim(), raw, dto);

    switch (outcome.kind) {
      case "created":
        reply.header("Idempotency-Replayed", "false");
        return reply.status(outcome.code).send(outcome.body);

      case "replayed":
        reply.header("Idempotency-Replayed", "true");
        // Sent as a pre-serialised string so the bytes match the original
        // response exactly rather than being re-marshalled.
        return reply.status(outcome.code).send(outcome.body);

      case "in_progress":
        // There is no stored response yet. Returning 200 with an empty body
        // here is the classic data-loss bug wearing a success code.
        reply.header("Retry-After", "1");
        return reply.status(409).send(
          JSON.stringify({
            error: "request with this idempotency key is still in flight",
          }),
        );

      case "mismatch":
        return reply.status(422).send(
          JSON.stringify({
            error: "idempotency key reused with a different payload",
          }),
        );
    }
  }
}
