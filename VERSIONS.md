# Pinned versions

Checked against upstream documentation, not recalled from memory.

| Component | Version | Note |
|---|---|---|
| Node | 20.11+ / 22 | NestJS 12 requires 20.11 minimum |
| NestJS | 12.0.x | `@nestjs/common`, `core`, `platform-fastify` |
| Fastify adapter | via NestJS 12 | `rawBody: true` for request fingerprinting |
| Drizzle ORM | 0.38 | `onConflictDoNothing().returning()`, `db.transaction` |
| drizzle-kit | 0.31.5 | only for `db:generate`; runtime uses plain SQL |
| node-postgres (`pg`) | 8.13 | pool, `max` capped at 20 |
| undici | 7.x | explicit `Agent` in the proof harness |
| Postgres | 16-alpine | `ON CONFLICT` needs 9.5+ |
| Next.js (console) | 16.2.x | unchanged from the Go build |
| Tailwind CSS | 4.1 | no JS config; tokens live in `@theme` |

## Things that will bite you

**Fastify, not Express.** Chosen because `rawBody` is well supported and it is
measurably faster under burst load. The Fastify adapter registers only JSON
and urlencoded parsers — no multipart. This project does not need it, but do
not assume file uploads work.

**Drizzle, not Prisma or TypeORM.** The whole design is one SQL statement:
`INSERT ... ON CONFLICT DO NOTHING RETURNING`. Drizzle expresses it directly
as `.onConflictDoNothing({ target }).returning()`. Prisma's `skipDuplicates`
does not return the rows you need, so you would drop to `$queryRaw` and lose
the reason you brought an ORM.

**`response_body` is `text`, not `jsonb`.** Postgres normalises jsonb: key
order and whitespace are not preserved. Storing the response as jsonb means a
replay returns different bytes than the original 201, for the same value.
Every replay would be self-consistent and still fail a byte-comparison against
the first response.

**The proof needs an explicit undici `Agent`.** Node's default dispatcher caps
concurrent connections per origin. Without `new Agent({ connections: N })` the
burst quietly serialises and the naive build passes.

**Tailwind v4 has no `tailwind.config.js`.** Tokens are declared with `@theme`
inside the CSS and the PostCSS plugin lives in `@tailwindcss/postcss`.
