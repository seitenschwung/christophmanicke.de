// Entry point of the mailer container (docker-compose service "mailer"). nginx forwards POST /api/anfrage here.
// Configuration only from environment variables (Coolify, docker-compose.yml).
import http from 'node:http';
import nodemailer from 'nodemailer';
import { readConfig, createLimiter, createHandler } from './lib.mjs';

const config = readConfig(process.env);
if (config.disabled) console.log(`mailer disabled, missing or invalid: ${config.missing.join(', ')}`);

const transport = config.dryRun
  ? nodemailer.createTransport({ jsonTransport: true })
  : nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      requireTLS: config.smtp.port !== 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

const handler = createHandler({ config, transport, limiter: createLimiter({ max: 10, windowMs: 3600_000 }) });
const server = http.createServer(handler);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.maxHeadersCount = 50;
server.listen(3000, '0.0.0.0', () => console.log(`mailer listening on 3000${config.dryRun ? ' (dry run)' : ''}`));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
