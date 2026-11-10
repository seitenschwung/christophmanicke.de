# christophmanicke.de

Praxis-Website (Neurochirurg, Kiel): statische HTML-Seiten, kein Build-Schritt, kein Framework. Dazu ein kleiner
Node-Mailer für das Anfrageformular. Sprache der Seiten und Commits: Deutsch (Commits teils englisch, Dependabot).

## Wo was liegt
- `index.html` Startseite (Wirbelsäule, Karte, Formular, Inline-CSS/JS, ~800 Zeilen); `fancy/index.html` alte Seite unter `/fancy`
- `impressum.html`, `datenschutz.html` (+ `assets/legal.css`), `robots.txt`, `sitemap.xml`
- `assets/` Bilder/Fonts/Video; `assets/credits.json` + `assets/v2/credits.json` Lizenz-/Bildnachweise
- `mailer/` `POST /api/anfrage`: `lib.mjs` (Config, Validierung, Limiter, Handler), `server.mjs` (Port 3000), `*.test.mjs`
- `nginx.conf` Port 8080, `/healthz`, `/version.txt`, Rate-Limit 5/min für `/api/anfrage`, Proxy zum Mailer
- `Dockerfile` (Stages: mailer-deps, site, test, final), `docker-compose.yml` (`web` + `mailer`), `.dockerignore` (Allowlist)
- `.github/workflows/ci.yml` dünner Aufruf von `seitenschwung/template/.github/workflows/pipeline.yml@v1`
- `README.md` Deploy-Notizen und Style-Guide-Links

## Befehle (alle geprüft)
- Dev-Server (statisch): `python3 -m http.server 8080 --bind 0.0.0.0` im Repo-Root (nginx-Regeln gelten dort nicht;
  `/fancy` wird als Verzeichnis ausgeliefert, `/api/anfrage` fehlt, das Formular fällt auf `mailto:` zurück)
- Mailer-Tests: `cd mailer && npm ci && node --test *.test.mjs` (49 Tests, <5 s)
- Mailer lokal ohne SMTP: `cd mailer && MAIL_DRY_RUN=1 MAIL_FROM=a@b.de MAIL_TO=c@d.de ALLOWED_ORIGINS=http://localhost:8080 node server.mjs`
  (Port 3000 fest; ohne Dry-Run SMTP_HOST/PORT/USER/PASS nötig, sonst 503)
- Build/Test des Images wie CI: `docker build --target test .` (Docker in der Sandbox nicht vorhanden, nur CI)
- Deploy: kein manueller Schritt. Push auf `main` → CI grün → Image nach ghcr.io → Coolify (Repo-Variablen `DEPLOY=auto`,
  `APP_DOMAIN=christophmanicke.de`), Rollback bei falscher `/version.txt`. Preview pro PR nach grüner CI.

## Konventionen
- Neue Abhängigkeiten nur in `mailer/` (nodemailer exakt gepinnt); Dependabot (wöchentlich, nur minor/patch) pflegt `mailer/` und FROM-Zeilen
- Mindestschrift 16 px, Animationen müssen Sprüngen/`prefers-reduced-motion` weichen (siehe Git-Historie); axe + Lighthouse laufen in CI
- Bilder als WebP in mehreren Breiten (`-800/-1200/-1600`) plus JPG-Original; Fremdbilder mit Eintrag in `credits.json` und Nachweis im Footer
- Das Image enthält nur Assets, deren Dateiname in einer HTML-Seite vorkommt (Dockerfile löscht den Rest). Neues Bild also in HTML referenzieren
- Compose: Labels `crowdsec.enable=true` und `crowdsec.labels.type=…` beibehalten; `read_only`, `cap_drop: ALL`, journald-Logging (14 Tage, in der Datenschutzerklärung zugesagt)

## Stolperstellen
- `assets/v2/l4-l5-disc-herniation.png` (Patientendaten) darf nie ins Image/Repo-Auslieferung; steht in `.gitignore` und wird im Dockerfile gelöscht; Test-Stage schlägt bei `*herniation*`/`*sagittal*` fehl
- `.dockerignore` ist eine Allowlist: neue Top-Level-Dateien/Ordner dort freigeben, sonst fehlen sie im Image
- `docker-compose.yml`: `SMTP_PASS` bewusst ohne Default (Coolify schreibt sonst die Variable nicht); ohne Wert antwortet der Mailer 503
- Mailer-Env: `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`, `MAIL_TO`, `ALLOWED_ORIGINS`, `MAIL_DRY_RUN=1`; Werte nur in Coolify, nie ins Repo
- `.github/workflows/` kann der Bot nicht pushen → `request_workflow_push`
- nginx leitet `www.christophmanicke.de` per 301 auf die Hauptdomain; `/healthz` und `/version.txt` bleiben auf allen Namen erreichbar (Deploy-Check braucht sie)
- Dev-Server-Header/Caching (`nginx.conf`) gelten nur im Container; für CSP/Cache-Fragen das Image-Verhalten in CI prüfen
