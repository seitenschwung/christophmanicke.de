// Request mailer: checks a request from the form on index.html#kontakt and turns it into one plain-text mail.
// Every check here has a test.

// One plain address: no spaces, commas, angle brackets, quotes or second @, so it can never become several recipients.
const EMAIL = /^[^\s@<>,;:"()[\]\\]+@[^\s@<>,;:"()[\]\\]+\.[A-Za-z]{2,}$/;
// Single-line fields must not contain line breaks or other control characters (header injection).
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
// The message may contain line breaks and tabs, nothing else from the control range.
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

// The choices offered by the form; anything else is refused.
export const TOPICS = [
  'Zweitmeinung vor einer Operation',
  'Beschwerden nach einer Operation',
  'Beratung bei Rückenbeschwerden',
  'Andere neurochirurgische Frage',
];
export const TIMES = ['So bald wie möglich', 'In den nächsten zwei Wochen', 'Im nächsten Monat', 'Ich bin flexibel'];

const FIELDS = {
  name: { max: 100, required: true },
  email: { max: 254, required: true },
  anliegen: { max: 80, required: true, oneOf: TOPICS },
  zeitraum: { max: 80, required: true, oneOf: TIMES },
  nachricht: { max: 2000, required: false, multiLine: true },
  einwilligung: { max: 2, required: true, oneOf: ['ja'] },
  website: { max: 200, required: false }, // honeypot, must stay empty for people
};

const isEmail = (s) => s.length <= 254 && EMAIL.test(s);

export function readConfig(env) {
  const dryRun = env.MAIL_DRY_RUN === '1';
  const needed = ['MAIL_FROM', 'MAIL_TO', 'ALLOWED_ORIGINS', ...(dryRun ? [] : ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'])];
  const missing = needed.filter((key) => !String(env[key] ?? '').trim());
  if (!missing.length) {
    for (const key of ['MAIL_FROM', 'MAIL_TO']) if (!isEmail(env[key].trim())) missing.push(key);
  }
  return {
    disabled: missing.length > 0,
    missing,
    dryRun,
    smtp: { host: env.SMTP_HOST, port: Number(env.SMTP_PORT), user: env.SMTP_USER, pass: env.SMTP_PASS },
    from: env.MAIL_FROM?.trim(),
    to: env.MAIL_TO?.trim(),
    origins: new Set(String(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean)),
  };
}

export function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body' };
  for (const key of Object.keys(body)) if (!(key in FIELDS)) return { ok: false, field: key };
  const data = {};
  for (const [field, rule] of Object.entries(FIELDS)) {
    const raw = body[field] ?? '';
    if (typeof raw !== 'string') return { ok: false, field };
    const value = raw.trim();
    if (rule.required && !value) return { ok: false, field };
    if (value.length > rule.max) return { ok: false, field };
    if ((rule.multiLine ? MULTI_LINE_BAD : SINGLE_LINE_BAD).test(value)) return { ok: false, field };
    if (rule.oneOf && !rule.oneOf.includes(value)) return { ok: false, field };
    data[field] = value;
  }
  if (!isEmail(data.email)) return { ok: false, field: 'email' };
  return { ok: true, data };
}

export function buildMail(data, config, now = new Date()) {
  const when = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
  return {
    from: config.from,
    to: config.to,
    replyTo: data.email,
    subject: `Anfrage: ${data.anliegen}`,
    text: [
      'Neue Anfrage über christophmanicke.de',
      '',
      `Name: ${data.name}`,
      `E-Mail: ${data.email}`,
      `Anliegen: ${data.anliegen}`,
      `Zeitraum: ${data.zeitraum}`,
      ...(data.nachricht ? ['', data.nachricht] : []),
      '',
      `Einwilligung zur Verarbeitung erteilt am ${when}.`,
      '— Mit „Antworten“ geht die Mail direkt an die anfragende Person.',
    ].join('\n'),
  };
}

export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    hit(ip) {
      const t = now();
      const recent = (hits.get(ip) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= max) {
        hits.set(ip, recent);
        return false;
      }
      recent.push(t);
      hits.set(ip, recent);
      if (hits.size > 10_000) for (const [key, list] of hits) if (!list.some((at) => t - at < windowMs)) hits.delete(key);
      return true;
    },
  };
}

const MAX_BODY = 16 * 1024;

const reply = (res, status, payload, extra = {}) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
};

// Reads at most MAX_BODY bytes within readTimeoutMs. Resolves with the text, or with a status code to answer.
const readBody = (req, readTimeoutMs) => new Promise((resolve) => {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return resolve({ status: 413 });
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (result) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
  const timer = setTimeout(() => finish({ status: 408 }), readTimeoutMs);
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) return finish({ status: 413 });
    chunks.push(chunk);
  });
  req.on('end', () => finish({ text: Buffer.concat(chunks).toString('utf8') }));
  req.on('error', () => finish({ status: 400 }));
});

// HTTP handler for the mailer service. Only POST /api/anfrage (via nginx) and GET /healthz exist.
// Responses never contain submitted values; logs never contain content, addresses or SMTP messages.
export function createHandler({ config, transport, limiter, maxConcurrent = 2, log = console.log, readTimeoutMs = 10_000 }) {
  let active = 0;
  return async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') return reply(res, 200, { ok: true });
    if (path !== '/api/anfrage') return reply(res, 404, { ok: false });
    if (req.method !== 'POST') return reply(res, 405, { ok: false }, { Allow: 'POST' });
    if (!config.origins.has(req.headers.origin ?? '')) return reply(res, 403, { ok: false });
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return reply(res, 415, { ok: false });
    if (config.disabled) return reply(res, 503, { ok: false });
    const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '');
    if (!limiter.hit(ip)) return reply(res, 429, { ok: false });

    const body = await readBody(req, readTimeoutMs);
    if (body.status) {
      reply(res, body.status, { ok: false }, { Connection: 'close' });
      return req.resume();
    }
    let parsed;
    try { parsed = JSON.parse(body.text); } catch { return reply(res, 400, { ok: false, field: 'body' }); }
    const checked = validate(parsed);
    if (!checked.ok) return reply(res, 400, { ok: false, field: checked.field });
    if (checked.data.website) return reply(res, 200, { ok: true }); // honeypot: pretend success, send nothing

    if (active >= maxConcurrent) return reply(res, 503, { ok: false });
    active++;
    try {
      await transport.sendMail(buildMail(checked.data, config));
      log('anfrage sent');
      return reply(res, 200, { ok: true });
    } catch (error) {
      log(`anfrage failed: ${String(error?.code ?? 'ERROR').replace(/[^A-Z0-9_]/gi, '')}`);
      return reply(res, 502, { ok: false });
    } finally {
      active--;
    }
  };
}
