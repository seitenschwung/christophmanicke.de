### Links

#### Style guide
https://n26.com/de-de
https://www.gyn-paradeplatz.ch

#### Personal Information
https://www.doctolib.de/neurochirurgie/kiel/christoph-manicke
### Deploy

Live: https://christophmanicke.de (Coolify). `.github/workflows/ci.yml` calls the shared pipeline
`seitenschwung/template` (mailer tests, hardened Docker run, axe + Lighthouse). A push to `main` deploys
after green CI; the Coolify app is found or created by name (repository variables `DEPLOY=auto`,
`APP_DOMAIN=christophmanicke.de`).

- `Dockerfile`: nginx (port 8080, `/healthz`, `/version.txt`) plus the mailer. Only assets the pages
  reference go into the image; the screenshot with patient data never does.
- `docker-compose.yml`: what Coolify runs (`web` and `mailer`).
- `mailer/`: `POST /api/anfrage` from the request form, sent via SMTP. Tests: `cd mailer && npm ci && node --test *.test.mjs`.

**Request form mail (owner, once):** in Coolify set `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (secret) and
`MAIL_FROM` for a mailbox on the practice's domain, optionally `MAIL_TO` (default christoph.manicke@gmx.de),
then redeploy. Until then the mailer answers 503 and the form opens the visitor's mail program instead.
