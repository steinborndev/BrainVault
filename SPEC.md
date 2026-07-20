# Spezifikation: Automatisierter Second-Brain-Vault mit Ingestion-Dashboard

**Version:** 0.1 (Entwurf) · **Datum:** 2026-07-17 · **Status:** implementierungsleitend

---

## 1. Überblick und Ziele

Das Projekt erweitert einen [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian)-Vault (v1.9.2, MIT) um eine vollautomatische Ingestion-Schicht und ein lokales Web-Dashboard. Der bestehende Workflow des Repos ist manuell: Der Nutzer öffnet Claude Code im Vault-Ordner und tippt `ingest datei.pdf`. Dieses Projekt ersetzt den manuellen Trigger durch zwei automatische Eingangskanäle — eine Drag-and-Drop-Fläche im Dashboard und einen überwachten Ordner im Dateisystem — und macht den Zustand des Vaults (Statistiken, Queue, Verlauf, Gesundheit) über ein Dashboard mit vier Tabs sichtbar und steuerbar. Fragen an den Vault ("what do you know about X?") werden ebenfalls über das Dashboard möglich.

**Kernziele:**

1. Material aus Drag-and-Drop und Watch-Ordner wird ohne weiteres Zutun analysiert, verlinkt und in den Vault eingepflegt (Entities, Konzepte, Quellen-Seiten, Index-, Log- und Hot-Cache-Updates gemäß claude-obsidian-Konventionen).
2. Der Vault bleibt zu 100 % ein normaler claude-obsidian-Vault: Plain Markdown, in Obsidian nutzbar, mit Claude Code direkt weiter bedienbar. Das Dashboard ist eine Schicht *über* dem Vault, keine Ersatz-Datenhaltung.
3. Der gesamte Stack läuft lokal (WSL2 auf Windows), keine Daten verlassen die Maschine außer den Aufrufen an die Anthropic-API während der Agent-Runs.

**Nicht in v1, aber mittelfristig geplant und in der Architektur mitgedacht:** Multi-User-Betrieb, Zugriff über Geräte hinweg (Sync) und mobile Nutzung. v1 implementiert diese Features nicht, trifft aber alle Entscheidungen so, dass sie ohne Re-Architektur nachrüstbar sind — die konkreten Vorkehrungen und der Erweiterungspfad stehen in Abschnitt 12. Ebenfalls verschoben: Audio-/Video-Transkription (Preprocessing-Plugin-Schnittstelle wird in v1 vorbereitet).

---

## 2. Getroffene Rahmenentscheidungen

| Frage | Entscheidung | Begründung |
|---|---|---|
| Dashboard-Form | Lokale Web-App (Browser + lokaler Server) | Flexibel, kein Obsidian-Plugin-Sandboxing, Server wird ohnehin für Watcher/Queue gebraucht |
| Ingestion-Modus | Vollautomatisch, sofortiges Einpflegen | Kein Review-Schritt; Fehler landen sichtbar im Ingestion-Tab |
| Analyse-Engine | Claude Agent SDK (headless) + claude-obsidian-Skills | Ingestion-Logik des Repos steckt in Skills/Skripten; das SDK kann sie programmatisch ausführen |
| Betriebssystem | Windows 11, Ausführung in **WSL2** | claude-obsidian ist bash-lastig (Setup, `wiki-lock.sh`, Hooks); WSL2 nutzt es unverändert |
| Organisationsmodus | **Generic** (Standard-Wiki-Struktur) | Heterogene Themen (Science, Finance, Crypto, Coding); Domain-Trennung via Sub-Indizes, später umstellbar |
| Anthropic-Auth | **Claude-Abo** (OAuth-Token via `claude setup-token`), API-Key als gleichwertiger Konfigurationspfad | Abo vorhanden; Policy-Lage im Fluss (siehe 7.1), daher beide Pfade unterstützt |
| Vault-Sprache | **Englisch** für alle Wiki-Inhalte (Seitennamen, Konzepte, Index, Zusammenfassungen) | Gemischte Quellsprachen (de/en); eine Zielsprache verhindert Duplikat-Konzepte im Graph. Originalzitate bleiben in Quellsprache |
| Transkription | v1: nicht unterstützt | Audio/Video-Dateien werden erkannt, in `.raw/deferred/` geparkt und im Dashboard als "wartet auf Transkription" markiert |

---

## 3. Systemarchitektur

Alle Komponenten laufen innerhalb von WSL2 (empfohlen: Ubuntu 24.04). Der Browser unter Windows greift über `localhost` zu (WSL2 leitet localhost automatisch weiter).

```
Windows 11
├── Browser  ──────────────────────────► http://localhost:8420  (Dashboard)
├── Watch-Ordner (z. B. C:\inbox)  ───► in WSL sichtbar als /mnt/c/inbox
└── WSL2 (Ubuntu)
    ├── Vault-Ordner  ~/vault/            (claude-obsidian, git-initialisiert)
    │   ├── wiki/  (index.md, hot.md, log.md, concepts/, entities/, sources/, meta/)
    │   ├── .raw/  (Quelldokumente, von der Pipeline befüllt)
    │   └── .obsidian/, skills/, scripts/, agents/ …
    ├── Backend-Service  (Node.js, TypeScript)
    │   ├── HTTP-API + statisches Frontend (Port 8420, Bind 127.0.0.1)
    │   ├── SSE-Kanal für Live-Updates (Queue-Status, Log-Tail)
    │   ├── Watcher (chokidar auf Watch-Ordner)
    │   ├── Ingestion-Queue (SQLite, better-sqlite3)
    │   ├── Preprocessing-Worker (Format-Normalisierung)
    │   └── Agent-Runner (@anthropic-ai/claude-agent-sdk)
    └── Obsidian für Windows öffnet den Vault via \\wsl$\Ubuntu\home\<user>\vault
```

**Hinweis Obsidian + WSL (korrigiert nach M0-Befund):** Der Vault liegt im WSL-Dateisystem (Performance, Locking-Semantik). **Obsidian unter Windows kann einen WSL-Vault über `\\wsl$` nicht öffnen** — es scheitert beim Start mit `EISDIR … watch` (der Datei-Watcher kann Verzeichnisse über die 9p-Freigabe nicht überwachen; von Obsidian als won't-fix eingestuft). Nicht bloß „träge", sondern funktionsunfähig. **Gewählte Lösung: Obsidian läuft als Linux-App *innerhalb* von WSL via WSLg** und öffnet `~/vault` als lokalen Pfad; der Vault bleibt auf ext4, der Service behält volle Geschwindigkeit. (Verworfene Alternative: Vault auf `/mnt/c/vault` mit dem nativen Windows-Obsidian — würde jedem Agent-Run und git-Commit den 20–65×-drvfs-Aufschlag aufbürden. Die frühere Sorge um `wiki-lock.sh` auf drvfs ist unbegründet: alle Locking-Tests bestehen dort.) Einschränkung von WSLg: der Graph-View ruckelt (Software-Rendering, kein `/dev/dri`); Tippen und Note-Öffnen bleiben flüssig. Details in Abschnitt 11.

### 3.1 Komponenten

**Backend-Service (ein Prozess):** Fastify- oder Express-Server in TypeScript. Liefert das Frontend aus, stellt die REST-API und einen SSE-Endpunkt bereit, hostet Watcher, Queue-Worker und Agent-Runner. Start als systemd-user-Service in WSL (`systemctl --user enable vault-service`), damit der Dienst mit WSL hochkommt.

**Watcher:** `chokidar` beobachtet den konfigurierten Watch-Ordner rekursiv. Neue/geänderte Dateien werden erst nach Stabilitäts-Check übernommen (`awaitWriteFinish`, 2 s unveränderte Größe), um halbkopierte Dateien zu vermeiden. Nach Übernahme wird die Datei in `.raw/` des Vaults **verschoben** (Watch-Ordner = Inbox, wird geleert; verhindert Doppelverarbeitung nach Neustart).

**Ingestion-Queue:** SQLite-Tabelle `jobs` als Single Source of Truth für alle Verarbeitungsvorgänge. Jobs durchlaufen die Zustände `queued → preprocessing → ingesting → done | failed | deferred`. Ein Worker-Pool arbeitet die Queue ab; **Standard-Parallelität für Agent-Runs: 2** (konfigurierbar). Das per-File-Locking von claude-obsidian (`scripts/wiki-lock.sh`) schützt zusätzlich auf Vault-Ebene, falls parallel Claude Code manuell im Vault arbeitet.

**Preprocessing-Worker:** Normalisiert eingehendes Material in ein für die Ingestion geeignetes Format (Details Abschnitt 5), legt Original + Normalisat in `.raw/<job-id>/` ab und schreibt eine `manifest.json` (Quelle, Typ, Hashes, Zeitstempel).

**Agent-Runner:** Führt pro Job einen headless Run über das Claude Agent SDK aus (`@anthropic-ai/claude-agent-sdk`, TypeScript). Konfiguration:

- `cwd` = Vault-Root. Zwei Ladewege, die **nicht** dasselbe tun (korrigiert nach M0-Befund): `settingSources: ['project']` lädt die `CLAUDE.md` des Vaults, **nicht** aber seine Skills — der claude-obsidian-Vault ist ein Claude-Code-*Plugin* (`.claude-plugin/plugin.json`), und sein `skills/`-Ordner wird vom CLI nicht von sich aus gescannt. Zum Aktivieren der Skills (`wiki-ingest` etc.) daher zusätzlich `plugins: [{ type: 'local', path: <Vault-Root> }]` und `skills: 'all'` setzen. Ohne diesen Plugin-Ladeweg fällt der Agent auf manuelles Lesen von `SKILL.md` zurück und improvisiert (in M0 gemessen: mit Plugin-Ladeweg 143→55 Turns, 12,7→5,4 Mio. Input-Tokens, 13→15 Seiten).
- Prompt pro Job: `ingest .raw/<job-id>/<datei>` (bzw. Batch: `ingest all of these` mit Dateiliste), ergänzt um eine feste System-Prompt-Erweiterung, die Vollautomatik erzwingt: keine Rückfragen stellen, bei Ambiguität dokumentierte Default-Entscheidung treffen und im Log vermerken. Zusätzliche Sprachregel: Alle Wiki-Inhalte (Seitennamen, Konzeptbezeichnungen, Zusammenfassungen, Index-Einträge) werden auf Englisch verfasst, unabhängig von der Quellsprache; wörtliche Zitate bleiben in Originalsprache mit Sprachvermerk. Vor dem Anlegen neuer Konzept-Seiten wird gegen bestehende englische Bezeichnungen geprüft (verhindert de/en-Duplikate wie "Zinseszins" neben "Compound Interest").
- `permissionMode`: automatisches Akzeptieren von Edits innerhalb des Vault-Pfads; Bash-Whitelist auf die claude-obsidian-Skripte (`scripts/*.sh`) beschränkt. Kein Netzwerkzugriff im Ingest-Run (Web-Egress nur im Autoresearch-Flow, dort explizit erlaubt).
- Streaming-Messages des SDK werden als Job-Log in SQLite persistiert und via SSE live ans Dashboard gereicht.
- Timeout pro Job (Default 15 min), max. 2 automatische Retries bei transienten Fehlern (API-Fehler, Timeout); danach `failed` mit Fehlerdetails.
- Nach jedem erfolgreichen Job: Git-Auto-Commit (falls Obsidian-Git nicht ohnehin committet — nur einer von beiden, konfigurierbar, Default: Service committet mit Message `ingest: <quelle>`). Ein separater Hot-Cache-Refresh-Pass entfällt (korrigiert nach M0-Befund): der ingest-Skill pflegt `wiki/hot.md` selbst; ein manueller Refresh bleibt über den Wartungs-Tab verfügbar (§6.4).

**Query-Runner:** Analog zum Agent-Runner, aber read-only (`permissionMode` restriktiv, nur Lese-Tools + `wiki-retrieve`), gespeist aus dem Query/Chat-Tab. Sessions werden über die SDK-Session-Verwaltung gehalten, sodass Folgefragen Kontext behalten.

### 3.2 Datenfluss Ingestion (happy path)

1. Datei landet per Drop (HTTP-Upload) oder im Watch-Ordner.
2. Service berechnet SHA-256; existiert der Hash bereits in `jobs`, wird der Job als Duplikat markiert und übersprungen (im Verlauf sichtbar).
3. Job `queued` → Preprocessing (Normalisierung, `.raw/<job-id>/`) → `ingesting` (Agent-Run) → `done`.
4. Agent erzeugt/aktualisiert Wiki-Seiten, Index, Log, Hot Cache; Service committet; Dashboard aktualisiert Statistiken via SSE.

---

## 4. Eingangskanäle

### 4.1 Drag-and-Drop (Dashboard, Ingestion-Tab)

- Dropzone akzeptiert Dateien (Mehrfach-Drop) **und** Text/URLs (Drop oder Einfügen einer URL startet einen URL-Job).
- Upload via `multipart/form-data` an `POST /api/jobs`; Limit 200 MB pro Datei (konfigurierbar).
- Mehrere gleichzeitig gedroppte Dateien werden als **Batch** gruppiert: erst alle einzeln vorverarbeitet, dann ein gemeinsamer `ingest all of these`-Run, damit der Agent quer-referenzieren kann (Verhalten des Repos für Batch-Ingestion).

### 4.2 Watch-Ordner

- Konfigurierbarer Pfad (Default `/mnt/c/inbox` — **`/mnt/d` existiert auf der Zielmaschine nicht**, verfügbar sind C/M/T; korrigiert nach M0-Befund. Im Dashboard änderbar; mehrere Ordner in v1.1 denkbar).
- Verhalten wie 4.1, zusätzlich: Dateien, die innerhalb von 60 s gemeinsam eintreffen, werden zu einem Batch gebündelt (typischer Fall: Nutzer kopiert einen Schwung Dateien).
- Sonderfall `.md`-Dateien aus dem Obsidian Web Clipper: werden als Web-Quelle behandelt (Frontmatter-URL wird ausgewertet).
- Nicht unterstützte Typen (v1: Audio/Video, Archive): Verschieben nach `.raw/deferred/`, Job-Status `deferred`, sichtbare Markierung im Dashboard. Archive (`.zip`) werden **nicht** automatisch entpackt (Sicherheitsentscheidung v1). **Getarnte ausführbare Dateien** (Magic-Byte-Befund widerspricht der Endung) sind dagegen ein Sicherheitsbefund, kein „wartet auf Feature": Job-Status `failed` mit klarer Fehlermeldung, kein Verschieben nach deferred (Entscheidung 2026-07-18, ersetzt die frühere Einordnung unter deferred).

### 4.3 Telegram-Bot (ergänzt 2026-07-20)

Dritter Eingangskanal plus Statuskanal, primär fürs Handy („PDF vom Telefon queuen"). Bewusste Ergänzung zum §12.5-Pfad (Tailnet + PWA-Share-Target): Der Bot deckt *nur* Status + Ingest ab, dafür ohne jede Netz-Infrastruktur und plattformunabhängig (auch iOS, wo das Web-Share-Target nicht existiert); das PWA-Share-Target bleibt der privatere Vollzugriffspfad.

- **Opt-in per Konfiguration:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_USER_IDS` (kommagetrennte numerische Telegram-User-IDs) in der Service-Env-Datei. Ohne Token: Bot aus, Verhalten wie bisher. Token **ohne** Allowlist ⇒ Startabbruch mit klarer Fehlermeldung (fail-closed, analog Doppel-Credential-Guard §7.1) — ein Bot, der jedem antwortet, darf nie aus einem Vergessen entstehen.
- **Transport: Long Polling** (`getUpdates`, ausgehende HTTPS-Verbindung zu `api.telegram.org`), **kein Webhook**. Es wird kein Port geöffnet, kein Bind geändert; der Localhost-Guard (§9) bleibt unberührt. Der Client ist ein minimaler eigener Bot-API-Client (`getUpdates`, `sendMessage`, `getFile` + Download), kein Framework. `getUpdates` erlaubt genau einen Consumer pro Token; antwortet die API `409 Conflict` (zweite Instanz, z. B. Dev neben systemd), beendet der Bot das Polling mit klarer Log-Meldung, statt zu konkurrieren — der Service selbst läuft weiter.
- **Interaktion:** `/status` (Setup-Modus, Queue-/Job-Zähler, Budget — die Daten von Health/Stats), `/jobs` (letzte Jobs mit Status). Gesendete Dokumente/Fotos werden per `getFile` heruntergeladen, wie ein Dashboard-Upload gestaged und mit `source: 'telegram'` in die reguläre Queue eingereiht; gesendete URLs/Texte werden URL-/Text-Jobs. Alben (Telegram `media_group_id`) werden zu **einem Batch** gebündelt (Analogie zum Mehrfach-Drop §4.1). Der Bot bestätigt die Einreihung sofort mit der Job-ID.
- **Limit:** Die Bot-API erlaubt Bots Downloads nur bis **20 MB** (User dürfen bis 2 GB senden; `getFile` verweigert dann). Größere Dateien ⇒ sofortige Antwort mit Hinweis auf Dropzone/Watch-Ordner, kein Job.
- **Abschluss-Meldung:** Erreicht ein Telegram-Job `done`/`failed`/`deferred`/`duplicate`, meldet der Bot das in den Ursprungs-Chat — bei `done` mit den Titeln der erzeugten Seiten, **ohne Inhaltsauszüge** (§9). Die Chat-Zuordnung wird als `notify_channel` am Job persistiert (§8), damit sie einen Service-Neustart überlebt.
- **Setup-Modus (§7.1):** Der Bot startet auch ohne Anthropic-Credential, meldet auf `/status` den Setup-Modus und lehnt Ingest-Versuche mit Hinweis ab — spiegelbildlich zum `503` der Upload-Route.
- Nachrichten von Absendern außerhalb der Allowlist werden **ohne Antwort verworfen**; der erste Versuch je Absender-ID wird im Service-Log vermerkt (ergänzt 2026-07-20, Details §9).
- **Konfiguration über das Dashboard (ergänzt 2026-07-20, User-Entscheidung):** Token und Allowlist sind unter Wartung → Einstellungen eintragbar. `POST /api/v1/settings/telegram` schreibt **beide Variablen gemeinsam** in die Service-Env-Datei (der Fail-closed-Guard oben darf durch diesen Weg nicht erzeugbar sein), `DELETE` entfernt beide (Bot aus). Es gelten dieselben Regeln wie für den Credential-Endpunkt aus §7.1: Werte werden nie zurückgegeben oder geloggt (die Einstellungsansicht zeigt nur den Status „on/off + Allowlist-Größe"), Aktivierung per Neustart (unter systemd Selbst-Neustart), `409` bei Werten aus der Prozess-Umgebung (die Datei würde überlagert) oder bei laufenden Agent-Runs (der Neustart würde sie abbrechen).

---

## 5. Materialtypen und Preprocessing

| Typ | Erkennung | Normalisierung | Werkzeug |
|---|---|---|---|
| PDF | Extension + Magic Bytes | Text-Extraktion; bei Text-Ausbeute < 100 Zeichen/Seite: Seiten rastern + OCR | `pdftotext` (poppler), Fallback `ocrmypdf`/tesseract (deu+eng) |
| Office (docx, pptx, xlsx) | Extension | Konvertierung nach Markdown/Plaintext | `pandoc` (docx), `python-pptx`/`openpyxl`-basierte Extraktoren aus WSL |
| Webseite/URL | URL-Job | Abruf + Boilerplate-Entfernung nach den Egress-Hygiene-Regeln des Repos (kein `file://`, kein RFC1918, DNS-Pinning gegen Rebinding, Größenlimit); danach **Sanity-Gate**: Mindestlänge + Muster-Erkennung für Login-Walls/JS-Hüllen/Anti-Bot-Seiten — schlägt das Gate an, endet der Job `failed` mit Begründung, bevor ein Agent-Run läuft (kein Müll im Vault) | `defuddle-cli` (vom Repo als Extraktor vorgesehen), Fallback: eingebauter HTML-zu-Text-Extraktor (readability als mögliche spätere Aufwertung) |
| X/Twitter-Post | URL-Job (Domain-Handler) | Öffentliche Posts via FxTwitter-JSON-API (`api.fxtwitter.com`, ohne Login) statt HTML-Abruf — X liefert per HTML nur eine Login-Hülle. Private/gelöschte Posts → `failed` mit klarer Meldung | eingebauter Handler (`url-handlers.ts`), Fetch über die SSRF-geschützte Pipeline |
| YouTube-Video | URL-Job (Domain-Handler) | Metadaten + Untertitel/Auto-Captions (de, en) statt der inhaltsleeren Watch-Seite; ohne Untertitel: Metadaten + Beschreibung mit Hinweis | `yt-dlp` (optionales Tool; fehlt es, endet der Job `failed` mit Installationshinweis) |
| Bild (png, jpg, webp) | Extension + Magic Bytes | Kein lokales OCR nötig: Bild wird dem Agent-Run direkt als Anhang mitgegeben (Claude liest Bildinhalt/Screenshot-Text selbst); zusätzlich EXIF-Metadaten in `manifest.json` | Agent SDK (Bild-Input), `exiftool` |
| Markdown/Text/Code | Extension | Durchreichen | — |
| Audio/Video | Extension | v1: `deferred` (siehe 4.2) | später: faster-whisper oder Cloud-API, Schnittstelle: Preprocessing-Plugin |

Das Preprocessing ist als Plugin-Kette implementiert (`detect → normalize → manifest`), damit die Transkription später als weiteres Plugin einrastet, ohne Pipeline-Umbau. URL-Jobs haben analog eine **Domain-Handler-Registry** (`url-handlers.ts`): Domains, deren HTML nicht ingestierbar ist (X/Twitter, YouTube), bekommen je einen Handler, der den Inhalt über einen besseren Kanal beschafft — neue Domains werden als Handler ergänzt, nie als Sonderfall in `preprocessUrl`. Handler-HTTP läuft über denselben SSRF-geschützten Fetch; `yt-dlp` ist die bewusste Ausnahme (externes Tool mit eigenem Egress, nur für YouTube-Hosts).

---

## 6. Dashboard

Single-Page-App (React + Vite + TypeScript), ausgeliefert vom Backend-Service, gebunden an `127.0.0.1:8420`. Vier Tabs:

### 6.1 Tab "Übersicht"

Vault-Statistiken und letzte Aktivität auf einen Blick: Seitenzahlen je Typ (Konzepte, Entities, Quellen — aus dem Dateisystem gezählt und gecacht), Wachstum über Zeit (aus Git-History), zuletzt erstellte/geänderte Seiten (klickbar mit `obsidian://open?vault=…&file=…`-Deep-Link), Inhalt des Hot Cache (`wiki/hot.md` gerendert), Kennzahlen der letzten 7 Tage (Ingests, Fehler, verarbeitete Quellen), Service-Status (Watcher aktiv, Queue-Länge, letzte Git-Commits).

### 6.2 Tab "Ingestion"

Herzstück der Bedienung. Oben die Dropzone (Dateien + URLs), darunter drei Bereiche: **Aktiv** (laufende Jobs mit Live-Log-Stream aus dem Agent-Run), **Warteschlange** (Reihenfolge änderbar, Jobs abbrechbar) und **Verlauf** (filterbar nach Status/Typ/Zeitraum; pro Job: Quelle, erzeugte/aktualisierte Wiki-Seiten mit Links, Dauer, Token-/Kostenschätzung aus den SDK-Usage-Daten). Fehlgeschlagene Jobs zeigen die Fehlermeldung und bieten "Erneut versuchen". `deferred`-Jobs (Audio/Video) sind als eigene Kategorie sichtbar.

### 6.3 Tab "Query/Chat"

Chat-Oberfläche gegen den Query-Runner. Antworten enthalten die vom wiki-query-Skill gelieferten Seiten-Zitate; zitierte Seiten werden als klickbare Chips gerendert (Obsidian-Deep-Link + Inline-Preview des Seiteninhalts). Mehrere Chat-Sessions parallel, Sessions benennbar; Button "Session in Vault sichern" löst den `/save`-Flow des Repos aus.

### 6.4 Tab "Wartung"

- **Lint:** Button startet `lint the wiki` als Agent-Run; Ergebnis wird strukturiert dargestellt (Orphans, tote Links, stale Claims, fehlende Cross-Links, `[!contradiction]`-Funde), jeweils mit Link zur Seite. Optional: wöchentlicher Auto-Lint (Cron im Service), Ergebnis landet als Bericht im Tab.
- **Autoresearch:** Eingabefeld für ein Thema, startet `/autoresearch <topic>` mit explizit freigeschaltetem Web-Egress; Fortschritt (Runden, gefundene Quellen) live im Log; Ergebnis-Seiten verlinkt.
- **Hot Cache:** manueller Refresh-Button + Anzeige des letzten Refresh-Zeitpunkts.
- **Einstellungen:** Watch-Ordner-Pfad, Parallelität, Datei-Limits, Git-Commit-Verhalten, API-Key-Status (Key selbst wird nie angezeigt). **Ergänzt 2026-07-19:** hier liegt zusätzlich die Credential-Eingabe der Ersteinrichtung (Abo-Token vs. API-Key zur Auswahl, je mit Anleitung) — im Setup-Modus aufgeklappt und über ein app-weites Banner verlinkt, mit konfiguriertem Credential hinter "Replace credential…" verborgen. Angezeigt wird weiterhin nur der Status, nie der Wert.

### 6.5 API (Auszug)

Alle Endpunkte sind ab v1 unter `/api/v1/` versioniert und laufen durch eine Auth-Middleware, die in v1 im Modus "local-single-user" alles durchlässt (siehe Abschnitt 12.1) — dadurch ist der spätere Auth-Einbau eine Konfigurations-, keine Umbaufrage.

```
POST   /api/v1/jobs                 Datei-Upload oder URL-Job anlegen
GET    /api/v1/jobs?status=&type=   Jobliste (paginiert)
POST   /api/v1/jobs/:id/retry       Retry
DELETE /api/v1/jobs/:id             Abbrechen/Entfernen aus Queue
GET    /api/v1/stats                Übersichts-Kennzahlen
POST   /api/v1/query                Frage an Query-Runner (Session-ID optional)
POST   /api/v1/maintenance/lint     Lint-Run starten
POST   /api/v1/maintenance/research Autoresearch starten
GET    /api/v1/events               SSE: Job-Updates, Log-Streams, Statistik-Invalidation
GET/PUT /api/v1/settings            Konfiguration
POST   /api/v1/settings/credential  Credential der Ersteinrichtung entgegennehmen (7.1);
                                    schreibt die Service-Env-Datei, liefert den Wert nie zurück
```

---

## 7. Tech-Stack

| Schicht | Wahl | Anmerkung |
|---|---|---|
| Laufzeit | Node.js ≥ 20 LTS in WSL2 (Ubuntu 24.04) | |
| Backend | TypeScript, Fastify, better-sqlite3, chokidar, zod | ein Prozess, systemd-user-Service |
| Agent | `@anthropic-ai/claude-agent-sdk` (TypeScript) | headless Runs, `settingSources: ['project']` **+ `plugins`/`skills`** (Vault als lokales Plugin laden, damit die Skills verfügbar sind — siehe 3.1), bundelt das Claude-Code-Binary; separate Claude-Code-Installation für manuelle Nutzung im Vault weiterhin möglich |
| Frontend | React + Vite + TypeScript, TanStack Query, SSE | responsiv von Anfang an (Mobile-Viewports), PWA-fähig gebaut (Manifest + installierbar), kein UI-Framework-Zwang |
| Vault | claude-obsidian v1.9.2, Generic-Modus | via `git clone` + `bash bin/setup-vault.sh` in WSL |
| Preprocessing | poppler-utils, ocrmypdf/tesseract (deu+eng), pandoc, defuddle-cli, exiftool | apt/npm/pip in WSL |
| Versionierung | Git-Auto-Commit durch den Service | Obsidian-Git-Plugin dann deaktiviert lassen (ein Commit-Verantwortlicher) |

### 7.1 Anthropic-Authentifizierung und Nutzungslimits

**Primärer Pfad (v1): Claude-Abo.** Der Service authentifiziert sich mit einem langlebigen OAuth-Token, erzeugt via `claude setup-token` (Claude Code CLI), abgelegt als `CLAUDE_CODE_OAUTH_TOKEN` in der systemd-Service-Umgebung. Wichtig: `ANTHROPIC_API_KEY` darf dann nicht gesetzt sein, da er den Token überlagern würde — der Service prüft das beim Start und bricht bei Doppelkonfiguration mit klarer Fehlermeldung ab.

**Konsequenzen des Abo-Modells:**

1. **Geteilte Limits:** Agent-SDK-Nutzung zählt derzeit (Stand Juni/Juli 2026) gegen die Nutzungslimits des Abos — die automatische Ingestion konkurriert also mit interaktiver Claude-/Claude-Code-Nutzung desselben Accounts. Ein großer Watch-Ordner-Schwung kann das Kontingent erschöpfen.
2. **Limit-Handling statt Kostenlimit:** Meldet das SDK ein erreichtes Nutzungslimit, pausiert die Queue automatisch (Status "rate-limited" im Dashboard, inkl. Zeitpunkt der erwarteten Freigabe, sofern verfügbar) und nimmt die Arbeit selbstständig wieder auf. Das in Abschnitt 11 erwähnte Tageslimit wird im Abo-Modus als **Job-Budget pro Tag** interpretiert (Anzahl Ingests), nicht als Dollarbetrag.
3. **Anzeige:** Das Dashboard zeigt Token-Verbrauch pro Job und aggregiert (aus den SDK-Usage-Daten); die Spalte `cost_usd` wird im Abo-Modus als rechnerischer Gegenwert zu API-Preisen befüllt und als "Schätzwert (Abo)" gekennzeichnet — nützlich, um den Wechsel auf API-Key-Betrieb zu bewerten.

**Sekundärer Pfad: API-Key.** Umschalten ist reine Konfiguration (`ANTHROPIC_API_KEY` statt Token setzen); Pay-per-Use mit echten Kosten pro Job, dann greift das Tageslimit als Dollarbetrag.

**Ersteinrichtung ohne Credential: Setup-Modus (ergänzt 2026-07-19).** Ist *kein* Credential konfiguriert, bricht der Service **nicht** mehr beim Start ab, sondern läuft im **Setup-Modus**: Dashboard, Vault-Viewer und lesende Endpunkte sind verfügbar, aber alles, was einen Agent-Run starten würde, ist abgeschaltet — die Queue beansprucht keine Jobs, der Watch-Ordner wird nicht überwacht, und Upload/Query/Session-Save/Maintenance antworten mit `503` samt Hinweis. Grund für die Abweichung vom bisherigen Startabbruch: Ohne laufenden Service gibt es keine Oberfläche, in der ein Erstnutzer den Key hinterlegen könnte — der Abbruch machte die Ersteinrichtung zwingend zu einem Terminal-Vorgang. Der Startabbruch bei **doppelt** konfiguriertem Credential bleibt unverändert bestehen.

Das Credential wird über `POST /api/v1/settings/credential` entgegengenommen (Kind `oauth` | `api-key` plus Wert) und in die Service-Env-Datei `~/.config/vault-service/env` geschrieben (Modus 0600, Write-then-Rename, vorhandene Nicht-Credential-Einträge bleiben erhalten, das jeweils andere Credential wird entfernt). Diese Datei *ist* die Service-Umgebung im Sinne von Abschnitt 9 — der Wert erreicht weder SQLite noch Logs, Frontend oder API-Antworten, und wird nach dem Schreiben nie wieder ausgeliefert. Der Endpunkt validiert die Token-Form je Kind (Präfix `sk-ant-oat…` vs. `sk-ant-api…`), lehnt mit `409` ab, wenn das Credential aus der Prozess-Umgebung stammt (dort würde es die Datei überlagern) oder gerade Runs laufen. Aktivierung erfolgt per Neustart, da das Credential an allen Aufrufstellen zum Startzeitpunkt gebunden wird: unter systemd startet sich der Dienst dafür selbst neu (`Restart=on-failure`), sonst weist die Oberfläche den manuellen Neustart aus.

**Policy-Vorbehalt:** Anthropics Regelung zur Agent-SDK-Nutzung mit Abos ist in Bewegung (Feb 2026: OAuth-Verbot fürs SDK; Juni 2026: angekündigtes separates SDK-Monatsguthaben, dessen Einführung am 15. Juni pausiert wurde — aktuell zählt SDK-Nutzung laut offizieller Support-Seite weiter gegen die Abo-Limits). Die Spec behandelt die Auth deshalb als austauschbares Modul; sollte Anthropic die Abo-Nutzung fürs SDK einschränken oder das Guthabenmodell aktivieren, ist nur die Umgebungskonfiguration und ggf. die Limit-Anzeige anzupassen. Vor Implementierungsstart von M0 ist der dann aktuelle Stand unter support.claude.com zu verifizieren.

---

## 8. Datenmodell (SQLite)

```sql
jobs(
  id TEXT PRIMARY KEY,            -- ulid
  user_id TEXT DEFAULT 'local',   -- Multi-User-Vorbereitung (Abschnitt 12.1)
  batch_id TEXT,                  -- gemeinsame Batches
  source TEXT NOT NULL,           -- 'drop' | 'watch' | 'url' | 'telegram' (4.3)
  type TEXT NOT NULL,             -- 'pdf' | 'office' | 'web' | 'image' | 'text' | 'av' | 'other'
  original_name TEXT, url TEXT,
  sha256 TEXT UNIQUE,             -- Dedupe
  status TEXT NOT NULL,           -- queued|preprocessing|ingesting|done|failed|deferred|duplicate|cancelled
  raw_path TEXT,                  -- .raw/<job-id>/
  created_pages TEXT,             -- JSON-Liste erzeugter/aktualisierter Wiki-Seiten
  notify_channel TEXT,            -- z. B. 'telegram:<chat_id>' — Abschluss-Meldung an den Eingangskanal (4.3; Migration v7)
  error TEXT, attempts INTEGER DEFAULT 0,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  created_at TEXT, started_at TEXT, finished_at TEXT
);
job_logs(job_id, ts, level, message);            -- Agent-Stream + Pipeline-Events
sessions(id, user_id DEFAULT 'local', title, created_at);  -- Query-Chat
messages(session_id, role, content, citations, ts);
settings(key PRIMARY KEY, value);
users(id PRIMARY KEY, name, token_hash, role, created_at); -- in v1 nur der Seed-Eintrag 'local'
```

Der Vault selbst bleibt die einzige Wahrheit für Wissen; SQLite hält ausschließlich Betriebszustand. Ein Verlust der DB darf den Vault nicht beschädigen (Rebuild der Statistiken aus Dateisystem + Git möglich).

---

## 9. Sicherheit

- Server bindet in v1 ausschließlich an `127.0.0.1`; die Auth-Middleware läuft im Modus "local-single-user" (alles erlaubt). Der Guard ist im Code verankert: Bind ≠ localhost ⇒ Startabbruch, solange kein Auth-Modus mit Token/Passwort aktiviert ist. Damit ist der Remote-Zugriff (Abschnitt 12.2/12.3) ein Konfigurationsschritt mit erzwungener Auth, kein ungeschützter Zufallszustand.
- Agent-Runs: Schreibrechte nur unterhalb des Vault-Pfads; Bash auf Skript-Whitelist; Web-Egress nur im Autoresearch-Flow, dort mit den Hygiene-Regeln des Repos (URL-Validierung, Sanitization, 50-KB-Fetch-Cap).
- Eingehende Dateien werden nie ausgeführt; Magic-Byte-Prüfung gegen getarnte Executables; Archive nicht auto-entpackt.
- Credentials (OAuth-Token bzw. API-Key) nur in der Service-Umgebung, nie im Frontend, nie in Logs, nie im Repo. Die Env-Datei `~/.config/vault-service/env` (0600) gilt als diese Umgebung; sie darf durch den Credential-Endpunkt aus Abschnitt 7.1 beschrieben, aber niemals ausgelesen und zurückgegeben werden. Ohne konfiguriertes Credential läuft der Service im Setup-Modus (ebenfalls 7.1) statt zu terminieren.
- **Schutz gegen Drive-by-Zugriffe aus dem Browser (ergänzt 2026-07-19):** Zustandsändernde Requests (`POST`/`PUT`/`PATCH`/`DELETE`) mit fremdem `Origin`-Header werden mit `403` abgelehnt. Der Modus "local-single-user" kennt kein Credential, und ein Multipart-Upload ist ein CORS-"simple request" ohne Preflight — ohne diese Prüfung könnte jede beliebige besuchte Webseite Uploads und damit kostenpflichtige Agent-Runs gegen `127.0.0.1` auslösen. Loopback-Origins (beliebiger Port, für den Vite-Dev-Proxy) und Requests ohne `Origin` (curl, systemd-Probe) passieren.
- **Telegram-Bot (ergänzt 2026-07-20, Abschnitt 4.3):** Der Bot-Token ist ein Secret derselben Klasse wie das Anthropic-Credential — nur in der Service-Env-Datei, nie in Logs, Frontend, SQLite oder API-Antworten; in Konfigurations-Ausgaben redigiert. Autorisierung ausschließlich über die User-ID-Allowlist, fail-closed: Token ohne Allowlist ⇒ Startabbruch; Nachrichten nicht gelisteter Absender werden ohne jede Antwort verworfen (eine Antwort würde die Bot-Existenz bestätigen — Bot-Usernamen sind enumerierbar, und jeder angenommene Befehl kann einen kostenpflichtigen Agent-Run auslösen; dieselbe Bedrohungsklasse wie der Origin-Check oben). Für den Betreiber sichtbar bleibt der Vorgang trotzdem (ergänzt 2026-07-20, User-Entscheidung): der **erste** Versuch je Absender-ID wird als Warnung ins Service-Log geschrieben — ID und ggf. Username, niemals der Nachrichteninhalt; Folgeversuche derselben ID werden nicht geloggt (Flutschutz fürs Journal). Der ausgehende HTTPS-Verkehr zu `api.telegram.org` ist **Service-Egress, nicht Agent-Egress** — die Regel „kein Web-Egress in Ingest-Runs" betrifft Agent-Runs und gilt unverändert. Dateien aus Telegram durchlaufen dieselbe Pipeline wie alle Eingänge (Basename-Reduktion, Magic-Byte-Prüfung, keine Ausführung, kein Auto-Entpacken). Abschluss-Meldungen nennen nur Seitentitel, nie Inhaltsauszüge — Vault-Inhalt soll nicht in der Telegram-Cloud liegen (die gesendete Datei selbst liegt dort ohnehin; das ist die bewusste Entscheidung des Nutzers beim Senden).
- **Dateinamen aus Uploads werden auf den reinen Basename reduziert**, bevor sie unter `.raw/<job-id>/` abgelegt werden; ein `../`-haltiger Name aus dem Multipart-Header könnte sonst *außerhalb* von `VAULT_ROOT` schreiben — an der Sandbox vorbei, da diese nur Agent-Runs umschließt, nicht den HTTP-Pfad.
- Git-History als Undo-Mechanismus: Jeder Ingest ist ein Commit, fehlerhafte Läufe sind per `git revert` rückholbar (Button "Ingest rückgängig" im Verlauf, v1.1).

---

## 10. Meilensteine

| # | Meilenstein | Inhalt | Abnahmekriterium |
|---|---|---|---|
| M0 | Fundament | WSL2-Setup, Vault geclont + `setup-vault.sh`, Obsidian öffnet Vault, Agent SDK führt manuell getriggerten `ingest`-Run erfolgreich aus | Eine PDF wird per CLI-Aufruf des Services korrekt eingepflegt (Seiten + Index + Hot Cache) |
| M1 | Pipeline | Queue, Preprocessing (PDF, Office, Text, Bild, URL), Agent-Runner mit Retry/Timeout, Dedupe, Git-Commits | 10 gemischte Dateien in `.raw` → alle `done`, keine Vault-Korruption bei Parallelität 2 |
| M2 | Eingangskanäle | Watch-Ordner (Stabilitäts-Check, Batching), Upload-Endpunkt | Dateien in `D:\inbox` erscheinen ohne Interaktion im Vault |
| M3 | Dashboard-Kern | Tabs Übersicht + Ingestion, SSE-Live-Updates, Dropzone | Drop im Browser → Live-Log → Ergebnis-Links funktionieren in Obsidian |
| M4 | Query + Wartung | Chat-Tab mit Zitaten und Sessions, Lint-, Autoresearch-, Hot-Cache-Steuerung | Frage liefert zitierte, klickbare Vault-Seiten; Lint-Bericht strukturiert |
| M5 | Härtung | systemd-Autostart, Fehlerpfade, Kosten-Anzeige, Settings-UI, Doku | Service übersteht WSL-Neustart; failed-Jobs sind diagnostizier- und wiederholbar |

---

## 11. Risiken und offene Punkte

1. **Obsidian über `\\wsl$`: GELÖST in M0 (Befund korrigiert die ursprüngliche Annahme).** Erwartet wurde 9p-*Trägheit*; tatsächlich **öffnet Obsidian für Windows den WSL-Vault gar nicht** (`EISDIR … watch`, won't-fix). Gewählte Lösung: **Obsidian in WSLg** (Linux-App in WSL, Vault bleibt auf ext4). Verbleibende Einschränkung: Graph-View ruckelt (WSLg-Software-Rendering), Tippen/Öffnen flüssig — kein Dateisystem-Problem, per 249-Notes-Test verifiziert. Die drvfs-Fallback-Sorge um `wiki-lock.sh` ist erledigt: Locking besteht dort alle Tests.
2. **Skill-Determinismus bei Vollautomatik:** Der ingest-Skill ist auf interaktive Nutzung ausgelegt und kann Rückfragen stellen. Mitigation: System-Prompt-Erweiterung "keine Rückfragen, Defaults dokumentieren"; in M1 gegen reale Quellen validieren und ggf. einen dünnen Auto-Ingest-Wrapper-Skill ins Vault-Repo legen.
3. **Nutzungslimits/Kosten:** Im Abo-Modus konkurriert die Vollautomatik mit interaktiver Nutzung um dieselben Limits; im API-Key-Modus entstehen echte Kosten. Mitigation: Rate-Limit-Pause mit Auto-Resume (7.1), Token-Verbrauch pro Job sichtbar, konfigurierbares Tagesbudget (Jobs/Tag im Abo-Modus, USD im API-Modus; Queue pausiert bei Überschreitung).
4. **Repo-Weiterentwicklung:** claude-obsidian entwickelt sich schnell (v1.7→v1.9 in Monaten). Mitigation: Vault als Fork/Pin auf getesteter Version; Upgrades bewusst.
5. **Gleichzeitige manuelle Nutzung:** Nutzer arbeitet mit Claude Code im Vault, während die Pipeline läuft. Das Advisory-Locking des Repos adressiert das; trotzdem in M1 explizit testen.
6. **Offen:** Mehrere Watch-Ordner mit unterschiedlichen Ziel-Domains? Tageslimit-Höhe? Modellwahl pro Job-Typ (kleines Modell für simple Texte, großes für komplexe Papers)? → Entscheidung nach ersten Betriebserfahrungen (M5).

---

## 12. Mittelfristige Erweiterungen: Multi-User, Sync, Mobile

Diese drei Anforderungen hängen architektonisch zusammen und werden deshalb gemeinsam gedacht. Die tragende Leitentscheidung lautet: **Server-zentrisch statt Datei-Sync.** Der Service auf der Hauptmaschine bleibt der einzige Schreiber des Vaults; andere Nutzer und Geräte greifen über die HTTP-API auf denselben Server zu, statt Vault-Kopien zu synchronisieren. Begründung: Das Advisory-Locking von claude-obsidian (`wiki-lock.sh`) funktioniert nur innerhalb einer Maschine — würden mehrere Geräte je eine Vault-Kopie per Dateisync (Syncthing, Obsidian Sync) beschreiben *und* dort eigene Ingestion-Pipelines betreiben, wären Merge-Konflikte in Index, Log und Hot Cache unvermeidbar. Ein zentraler Server mit Queue serialisiert alle Schreibzugriffe von Natur aus; die v1-Architektur (API-first, Queue als Single Writer) ist dafür bereits die richtige Form.

### 12.1 Multi-User

**v1-Vorkehrungen (bereits umgesetzt):** Auth-Middleware vor allen Endpunkten (Modus "local-single-user"), `user_id`-Spalten in `jobs` und `sessions` (Default `'local'`), `users`-Tabelle mit Seed-Eintrag, versionierte API.

**Ausbaustufe:** Aktivierung des Auth-Modus (Token/Passwort pro Nutzer, Argon2-Hash in `users.token_hash`), Login-Screen im Frontend, Rollen `admin` (Einstellungen, Wartung, alle Jobs) und `member` (eigene Jobs, Query, Ingestion). Chat-Sessions sind nutzerprivat; der Vault selbst bleibt in der ersten Multi-User-Stufe **geteilt** (ein gemeinsames Second Brain — das ist der Sinn eines gemeinsamen Vaults). Sollten später getrennte Wissensräume nötig sein, ist die Erweiterung "mehrere Vaults pro Server" (Vault-Registry-Tabelle, `vault_id` an Jobs/Sessions) der saubere Weg — v1 vermeidet daher hartkodierte Ein-Vault-Annahmen in der Pfadlogik (Vault-Root als Konfigurationswert, überall durchgereicht statt global konstant).

### 12.2 Zugriff über Geräte hinweg ("Sync")

**Modell:** Kein Vault-Sync zwischen Geräten, sondern Fernzugriff auf den einen Server. Der einfachste sichere Weg ist ein Overlay-Netz (Tailscale/WireGuard): Der Service wird zusätzlich an die Tailnet-Adresse gebunden (mit dann erzwungener Auth, siehe Guard in Abschnitt 9) und ist von allen eigenen Geräten erreichbar, ohne einen Port ins Internet zu öffnen. Alternative für den öffentlichen Zugriff: Reverse Proxy (Caddy) mit TLS + Auth.

**Lesender Zugriff auf die Notizen selbst** (Obsidian auf einem Zweitgerät): bleibt über Git möglich — der Service committet ohnehin jeden Ingest. Ein `git remote` (privates Repo oder selbstgehostet via Gitea) plus Pull auf dem Zweitgerät liefert eine lesende bzw. vorsichtig-schreibende Kopie. Regel, die die Spec festschreibt: **Automatisierte Schreiber gibt es nur auf dem Server.** Manuelle Edits von Zweitgeräten laufen über Git-Push und werden vom Server vor dem nächsten Ingest gepullt (Pipeline-Schritt "pull before ingest" wird in dieser Ausbaustufe ergänzt; Konfliktfall pausiert die Queue und meldet sich im Dashboard).

**Voraussetzung:** Die Hauptmaschine muss erreichbar sein, wenn andere Geräte zugreifen. Mittelfristig ist deshalb der Umzug des Services von WSL2 auf einen kleinen Always-on-Host (Heimserver, NUC, VPS) der natürliche Schritt — die Container-Fähigkeit des Stacks (reines Linux-Userland, keine Windows-Abhängigkeiten im Service selbst) ist dafür die v1-Vorkehrung: ein Dockerfile gehört ab M5 zum Repo, auch wenn es unter WSL2 nicht gebraucht wird.

### 12.3 Mobile Nutzung

**v1-Vorkehrungen (bereits umgesetzt):** Frontend responsiv für schmale Viewports, PWA-Manifest (installierbar auf dem Homescreen), SSE statt WebSockets (robuster über Proxies/Mobilnetze).

**Ausbaustufe:** Sobald der Server per Tailnet erreichbar ist (12.2), funktioniert das Dashboard auf dem Smartphone ohne weiteren Code. Mobile-spezifische Ergänzungen danach: Share-Target im PWA-Manifest, damit "Teilen → Vault" aus jeder App heraus einen URL- oder Datei-Job anlegt (das mobile Gegenstück zum Watch-Ordner); Kamera-Upload in der Dropzone (Foto eines Dokuments → Bild-Ingest); optional Push-Benachrichtigung bei fehlgeschlagenen Jobs (Web Push). Eine native App ist nicht geplant — die PWA deckt die Anforderungen ab.

**Teilabdeckung durch den Telegram-Bot (2026-07-20):** Der in Abschnitt 4.3 ergänzte Bot deckt den mobilen Ingest- und Status-Anwendungsfall bereits ohne Tailnet ab, inklusive Abschluss-Meldung als Ersatz für Web Push — auf jeder Plattform (iOS unterstützt das Web-Share-Target nicht). Die Ausbaustufe oben bleibt der privatere Pfad (Inhalte verlassen die eigenen Geräte nicht) und der einzige mit vollem Dashboard-Zugriff (Chat, Graph, Wartung); beide ergänzen sich. Für 12.2 gilt seitdem als bevorzugte Variante `tailscale serve` (TLS-Terminierung am MagicDNS-Namen, Proxy auf `127.0.0.1:8420`): der Service bleibt loopback-gebunden, der Guard aus Abschnitt 9 wird gar nicht erst berührt, HTTPS für PWA-Installation/Share-Target kommt gratis mit, und das Frontend braucht kein Token-Handling (Zugriffsschutz = Tailnet-Mitgliedschaft; der Token-Modus bleibt als Härtungsoption bestehen).

### 12.4 In-Dashboard Vault-Viewer (Seiten + Graph)

**Motivation (aus dem M3-Betrieb):** Der Vault ist die Source of Truth (Obsidian-flavored Markdown + Wikilinks + git — das „Backend-Format"); Obsidian-die-**App** ist nur *ein* Viewer und bewusst optional. Zwei Reibungspunkte zeigen in dieselbe Richtung: (a) das Windows-Obsidian öffnet den WSL-Vault über `\\wsl$` gar nicht (`EISDIR … watch`, Abschnitt 3/11), und (b) der Graph-View des WSLg-Linux-Obsidian ruckelt mangels GPU. Ein **read-only Vault-Viewer im Dashboard** umgeht beides und macht die Obsidian-App für den Alltag entbehrlich — der Vault bleibt unverändert das Speicherformat.

**Ausbaustufe:** Ein zusätzlicher Bereich (oder eine Erweiterung der Übersicht), der die Wiki-Seiten direkt rendert: Markdown mit aufgelösten `[[Wikilinks]]` als klickbare In-App-Navigation, Backlinks-Panel, und ein **Graph-View** aus dem Wikilink-Graphen (die Links sind vollständig parsebar; ein neuer read-only Endpunkt `GET /api/v1/graph` liefert Knoten/Kanten, `GET /api/v1/page/*` den gerenderten Seiteninhalt). Bleibt strikt lesend — Schreibzugriff auf den Vault gibt es weiterhin nur über Agent-Runs (Hard Rule 1). obsidian://-Deep-Links und der Copy-Pfad-Fallback bleiben als Brücke bestehen, solange Obsidian parallel genutzt wird.

**Status: UMGESETZT (2026-07-18, nach M5).** Realisiert als fünfter Tab „Vault" mit zwei
deep-linkbaren Routen (`/vault` = Graph, `/vault/page/<pfad>` = Seite), strikt lesend:

- **Server:** `GET /api/v1/graph` (Knoten je Wiki-Seite, typisiert nach Wiki-Verzeichnis;
  gerichtete Kanten als Index-Paare; Zähler für unaufgelöste Links) und
  `GET /api/v1/pages?path=…&full=1` (Volltext + Titel/Typ/mtime). Der Graph-Builder cacht
  Parses pro Datei über (mtime, size) und liefert bei unverändertem Vault dasselbe Objekt
  zurück — gemessen am realen Vault: 111 Seiten / 802 Kanten, 35 ms kalt, 2 ms gecacht, 19 KB JSON.
- **Frontend:** Canvas-2D-Rendering (kein DOM-Knoten pro Seite), d3-force-Simulation in einem
  Web Worker, die abkühlt und stoppt; Label-Level-of-Detail nach Zoom und Knotengrad,
  Viewport-Culling, Pan/Zoom/Touch, Nachbarschafts-Hervorhebung. Suche, Typ-Filter und ein
  lokaler Graph-Modus (BFS-Tiefe 1/2 um eine fokussierte Seite) halten die Ansicht auch bei
  großem Vault handhabbar. Seitenansicht mit Backlinks-/Ausgehend-Panel, Frontmatter als
  Eigenschaften-Panel und klickbaren `[[Wikilinks]]` (gleiche Auflösungsregel wie serverseitig).
- **Skalierung** ist bewusstes Entwurfskriterium: der Vault wächst kontinuierlich, und die
  ruckelnde Obsidian-Graph-View (Abschnitt 3/11) ist genau das, was hier nicht reproduziert
  werden soll. Der Vault-Tab ist als eigener Chunk code-gesplittet.

Der `obsidian://`-Deep-Link bleibt als Brücke bestehen, ist aber seit 2026-07-18 die
**Sekundäraktion**: alle Seiten-Links im Dashboard (Übersicht, Ingestion-Historie, Chat-Zitate,
Wartung) öffnen primär den In-App-Viewer — damit ist das Dashboard aus einem **Windows-Browser**
vollwertig nutzbar (Windows-Obsidian kann den WSL-Vault über `\\wsl$` nicht öffnen, Abschnitt 3/11).

**Bearbeiten/Löschen (Erweiterung 2026-07-18, User-Entscheidung):** Der Viewer ist nicht mehr rein
lesend. `PUT /api/v1/pages` (Bearbeiten, mit optimistischem Locking über `baseMtime` → 409 bei
zwischenzeitlicher Änderung) und `DELETE /api/v1/pages` (Löschen mit Zwei-Schritt-Bestätigung).
Hard Rule 1 bleibt dem Geist nach intakt und wurde präzisiert: **jede Dashboard-Mutation ist genau
ein Git-Commit** (`edit: <Seite>` / `delete: <Seite>`), ausgeführt hinter demselben Commit-Mutex
wie Ingest- und Wartungs-Commits und strikt pfadbegrenzt (kein `git add -A`-Fallback), sodass
halbfertige Seiten eines parallel laufenden Agent-Runs nie in einen User-Commit geraten. Neue
Seiten entstehen weiterhin nur über Ingestion/Agent-Runs — das Dashboard editiert und löscht
Bestehendes. Nach einem Löschen zeigt das Dashboard ein Banner mit der Zahl der dadurch
verwaisten Backlinks und führt den Nutzer zum Lint-Lauf (dem vault-eigenen Aufräummechanismus
für hängende Verweise).

**Live-Graph (Erweiterung 2026-07-19, User-Entscheidung):** Der Graph aktualisiert sich live,
während ein Ingest läuft — man sieht neue Seiten und Verbindungen entstehen, wie früher in der
Obsidian-Graph-View. Serverseitig beobachtet ein zweiter chokidar-Watcher `VAULT_ROOT/wiki`
(reine Notification, liest und schreibt keine Seiteninhalte; Hard Rule 1 unberührt) und
publiziert entprellt (1 s) ein payload-loses SSE-Event `vault`, worauf das Frontend den Graphen
refetcht. Damit das die flüssige Darstellung nicht gefährdet: Knotenpositionen sind pfad- statt
indexbasiert (die Knotenliste ist pfadsortiert — ein einziger Neuzugang verschiebt alle
nachfolgenden Indizes), der Layout-Worker ist langlebig und unterbrechbar (Generationen-Protokoll,
Timer- statt Blockierschleife) und wird bei kleinen Diffs mit niedrigem Alpha nachgeheizt statt
neu gestartet; erst ab >20 % neuen Knoten wird kalt neu gelayoutet. Neue Seiten erscheinen am
Schwerpunkt ihrer bereits platzierten Nachbarn und blinken kurz auf; die Kamera bewegt sich bei
Live-Updates nie (Auto-Fit nur beim allerersten Layout). Nebeneffekt: auch Filter- und
Fokuswechsel erhalten jetzt die Positionen, statt die Simulation neu zu würfeln.

**Meta-Kategorien, Stufe 1 (2026-07-19, User-Entscheidung):** Der Graph kennt jetzt die
thematische Achse zusätzlich zur strukturellen: Der Graph-Builder parst im selben Lesedurchgang
das Frontmatter (`tags:` als Block- oder Inline-Liste, `domain:`) und legt beides auf jeden
Knoten. Im Vault-Tab gibt es dazu eine zweite Filterzeile nach Domäne — Seiten ohne `domain:`
bilden bewusst einen sichtbaren „ohne Domäne"-Bucket (die Evidenz für den geplanten Backfill,
keine Blindstelle), einen Umschalter „nach Domäne färben" (deterministische Hash-Farben pro
Domänenname; die Filter-Chips tragen denselben Farbpunkt und sind damit die Legende), und die
Suche matcht Titel **und** Tags.

**Meta-Kategorien, Stufe 2 (2026-07-19, User-Entscheidung):** Die Domänen sind jetzt eine
geschlossene, bewachte Liste statt eines frei beschreibbaren Feldes.

- **Registry als Vault-Seite** (`wiki/meta/domains.md`): führt die erlaubten Domänen mit
  Beschreibung und Tag-Hinweisen. Sie liegt bewusst im Vault und nicht in der DB — git-versioniert
  mit dem Inhalt, den sie beschreibt, im Dashboard-Seiteneditor pflegbar und für Agent-Runs ohne
  Zusatzverdrahtung lesbar. Das Saatgut liegt im Repo (`scripts/vault-extensions/domains.md`,
  installiert von `scripts/install-domain-registry.sh`, nicht-destruktiv); ab Installation ist die
  Vault-Kopie die Source of Truth und der Service liest sie nur (Hard Rule 1). Initialer Zuschnitt:
  `biomedicine`, `finance`, `cooking`, `knowledge-management`, `ai-tooling`, `meta` — plus den
  Sentinel `unassigned`.
- **Agent-Vorgabe:** Jeder schreibende Run (Ingest, Backfill, Lint, Autoresearch) bekommt die
  Registry über die System-Prompt-Extension (`RunAgentOptions.systemPromptExtra`, der von Hard
  Rule 5 sanktionierte Erweiterungsweg) als geschlossene Liste: genau einen Schlüssel daraus
  setzen, sonst `unassigned` — **niemals einen neuen Schlüssel erfinden**. Neue Domänen entstehen
  ausschließlich dadurch, dass ein Mensch die Registry-Seite editiert. Die Liste wird pro Run frisch
  gelesen, eine Registry-Änderung wirkt also ohne Neustart. Ohne installierte Registry ist die
  Extension leer und alles verhält sich wie zuvor.
- **Backfill** als Wartungs-Aktion (`POST /api/v1/maintenance/domain-backfill`, Kind
  `domain-backfill`): ein Agent-Run, der Bestandsseiten nachsortiert — Werte, die vor der Registry
  entstanden sind (`investment-funds`, `mrna-delivery`), werden auf die gültige Domäne umgehängt.
  Ausdrücklich nur das Frontmatter-Feld; Seiteninhalte, andere Felder und die Registry selbst bleiben
  unangetastet, und es entstehen keine neuen Seiten. Ohne Registry antwortet die Route `409` statt
  den Agenten improvisieren zu lassen. Nebenbei billig: der Semantic-Tiling-Cache des Vaults hasht
  Seiten-**Bodies**, ein reiner Frontmatter-Backfill invalidiert ihn also nicht.
- **Sichtbarkeit:** `GET /api/v1/domains` meldet, ob eine Registry installiert ist und was sie
  enthält; die Wartungs-Karte zeigt die Domänen und die Zahl der Seiten ohne Domäne — genau die
  Zahl, an der man sieht, ob ein Backfill fällig ist.

**Meta-Kategorien, Stufe 3 (2026-07-19, User-Entscheidung):** Die Governance-Schleife, die neue
Domänen aus Evidenz **vorschlägt** — entschieden wird weiterhin vom Nutzer.

- **Kandidaten-Findung, deterministisch und kostenlos** (`pipeline/domain-candidates.ts`):
  tag-zentriert statt generischer Community-Detection, weil das Ergebnis eine Registry-Zeile
  werden muss und die aus `key + description + tags` besteht — ein Tag auf N `unassigned`-Seiten
  *ist* der Vorschlag, und „5 Seiten tragen `design`, keine Domäne deckt das ab" ist in einem
  Blick prüfbar. Schwelle ≥5 Seiten. Tags, die eine bestehende Domäne bereits beansprucht,
  scheiden aus (das ist eine Fehleinsortierung für den Backfill, kein fehlendes Fach); ebenso
  strukturelle Tags (`person`, `organization`, …), die sagen was eine Seite *ist* statt worum es
  geht. Tags mit stark überlappenden Seitenmengen werden zusammengefasst. Der Wikilink-Graph
  liefert ein **Kohäsionsmaß** (hängen die Seiten auch untereinander?), ist aber ausdrücklich
  nicht der Clustering-Motor. Gezählt wird nur explizites `unassigned`; Seiten ganz ohne
  `domain:`-Feld werden separat gemeldet, weil sie „nie klassifiziert" heißen und nicht „nichts
  passt" — sie würden die Analyse verwässern.
- **Agent-Bewertung, optional und abschaltbar** (`domain-review`): ein Toggle in der UI
  entscheidet, ob zusätzlich ein Agent-Lauf die Kandidaten beurteilt — `new-domain` (mit
  Namensvorschlag), `existing` (gehört in eine vorhandene Domäne) oder `not-a-domain`. Der Lauf
  ist **read-only**: er gibt eine Meinung ab und fasst keine Datei an, denn neue Schlüssel kommen
  per Definition von Menschen. Sein Ergebnis ist die Antwort selbst, geparst
  (`pipeline/domain-review.ts`) — bewusst ohne Report-Datei im Vault, weil ein Vorschlag flüchtig
  ist und sonst bei jedem „Nein" Müll zurückbliebe. Kandidaten werden serverseitig neu berechnet,
  damit ein veralteter Browser-Tab keinen Lauf auf verschwundene Themen auslösen kann.
- **Entscheiden:** `POST /api/v1/domains` legt eine Domäne an, indem es die Registry-Seite um
  einen Abschnitt ergänzt — als **ein** Git-Commit (`domains: add <key>`) hinter demselben
  Commit-Mutex und mit exaktem Pathspec wie ein Nutzer-Seiten-Edit. Read-modify-write liegt im
  Mutex, damit zwei parallele Anlagen sich nicht überschreiben. Ein verworfener Kandidat wird in
  SQLite gemerkt (`domain_dismissals`, Migration v5) — ohne dieses Gedächtnis schlüge die
  Schleife dasselbe Thema endlos vor. Verworfenes ist einzeln zurückholbar.
- **Selbstheilung:** Nach dem Anlegen verschwindet ein Kandidat schon deshalb, weil seine Tags
  nun einer Domäne gehören; der Dismissal ist nur die zusätzliche Sicherung für die Zeit bis zum
  nächsten Backfill.

### 12.5 Reihenfolge

Empfohlener Ausbaupfad nach v1-Stabilisierung: (1) Tailnet-Zugriff + Auth-Aktivierung (kleinster Schritt, sofortiger Mobile-Nutzen), (2) PWA-Share-Target, (3) Multi-User-Rollen, (4) Umzug auf Always-on-Host per Docker, (5) Git-Remote-Workflow für Zweitgerät-Edits. ~~(6) In-Dashboard Vault-Viewer~~ — **vorgezogen und am 2026-07-18 umgesetzt** (12.4); die Obsidian-App ist damit im Alltag optional.
