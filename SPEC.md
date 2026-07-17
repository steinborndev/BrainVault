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
├── Watch-Ordner (z. B. D:\inbox)  ───► in WSL sichtbar als /mnt/d/inbox
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

**Hinweis Obsidian + WSL:** Der Vault liegt im WSL-Dateisystem (Performance, Locking-Semantik). Obsidian unter Windows öffnet ihn über den `\\wsl$`-Pfad. Alternative, falls der `\\wsl$`-Zugriff in der Praxis zu träge ist: Vault unter `/mnt/d/vault` (Windows-Dateisystem) — dann muss die Locking-Robustheit von `wiki-lock.sh` auf drvfs verifiziert werden (siehe Risiken, Abschnitt 11).

### 3.1 Komponenten

**Backend-Service (ein Prozess):** Fastify- oder Express-Server in TypeScript. Liefert das Frontend aus, stellt die REST-API und einen SSE-Endpunkt bereit, hostet Watcher, Queue-Worker und Agent-Runner. Start als systemd-user-Service in WSL (`systemctl --user enable vault-service`), damit der Dienst mit WSL hochkommt.

**Watcher:** `chokidar` beobachtet den konfigurierten Watch-Ordner rekursiv. Neue/geänderte Dateien werden erst nach Stabilitäts-Check übernommen (`awaitWriteFinish`, 2 s unveränderte Größe), um halbkopierte Dateien zu vermeiden. Nach Übernahme wird die Datei in `.raw/` des Vaults **verschoben** (Watch-Ordner = Inbox, wird geleert; verhindert Doppelverarbeitung nach Neustart).

**Ingestion-Queue:** SQLite-Tabelle `jobs` als Single Source of Truth für alle Verarbeitungsvorgänge. Jobs durchlaufen die Zustände `queued → preprocessing → ingesting → done | failed | deferred`. Ein Worker-Pool arbeitet die Queue ab; **Standard-Parallelität für Agent-Runs: 2** (konfigurierbar). Das per-File-Locking von claude-obsidian (`scripts/wiki-lock.sh`) schützt zusätzlich auf Vault-Ebene, falls parallel Claude Code manuell im Vault arbeitet.

**Preprocessing-Worker:** Normalisiert eingehendes Material in ein für die Ingestion geeignetes Format (Details Abschnitt 5), legt Original + Normalisat in `.raw/<job-id>/` ab und schreibt eine `manifest.json` (Quelle, Typ, Hashes, Zeitstempel).

**Agent-Runner:** Führt pro Job einen headless Run über das Claude Agent SDK aus (`@anthropic-ai/claude-agent-sdk`, TypeScript). Konfiguration:

- `cwd` = Vault-Root, `settingSources: ['project']`, damit `CLAUDE.md` des Vaults und die claude-obsidian-Skills geladen werden.
- Prompt pro Job: `ingest .raw/<job-id>/<datei>` (bzw. Batch: `ingest all of these` mit Dateiliste), ergänzt um eine feste System-Prompt-Erweiterung, die Vollautomatik erzwingt: keine Rückfragen stellen, bei Ambiguität dokumentierte Default-Entscheidung treffen und im Log vermerken. Zusätzliche Sprachregel: Alle Wiki-Inhalte (Seitennamen, Konzeptbezeichnungen, Zusammenfassungen, Index-Einträge) werden auf Englisch verfasst, unabhängig von der Quellsprache; wörtliche Zitate bleiben in Originalsprache mit Sprachvermerk. Vor dem Anlegen neuer Konzept-Seiten wird gegen bestehende englische Bezeichnungen geprüft (verhindert de/en-Duplikate wie "Zinseszins" neben "Compound Interest").
- `permissionMode`: automatisches Akzeptieren von Edits innerhalb des Vault-Pfads; Bash-Whitelist auf die claude-obsidian-Skripte (`scripts/*.sh`) beschränkt. Kein Netzwerkzugriff im Ingest-Run (Web-Egress nur im Autoresearch-Flow, dort explizit erlaubt).
- Streaming-Messages des SDK werden als Job-Log in SQLite persistiert und via SSE live ans Dashboard gereicht.
- Timeout pro Job (Default 15 min), max. 2 automatische Retries bei transienten Fehlern (API-Fehler, Timeout); danach `failed` mit Fehlerdetails.
- Nach jedem erfolgreichen Job: Hot-Cache-Refresh anstoßen (entspricht `update hot cache`), Git-Auto-Commit (falls Obsidian-Git nicht ohnehin committet — nur einer von beiden, konfigurierbar, Default: Service committet mit Message `ingest: <quelle>`).

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

- Konfigurierbarer Pfad (Default `/mnt/d/inbox`, im Dashboard änderbar; mehrere Ordner in v1.1 denkbar).
- Verhalten wie 4.1, zusätzlich: Dateien, die innerhalb von 60 s gemeinsam eintreffen, werden zu einem Batch gebündelt (typischer Fall: Nutzer kopiert einen Schwung Dateien).
- Sonderfall `.md`-Dateien aus dem Obsidian Web Clipper: werden als Web-Quelle behandelt (Frontmatter-URL wird ausgewertet).
- Nicht unterstützte Typen (v1: Audio/Video, Archive, ausführbare Dateien): Verschieben nach `.raw/deferred/`, Job-Status `deferred`, sichtbare Markierung im Dashboard. Archive (`.zip`) werden **nicht** automatisch entpackt (Sicherheitsentscheidung v1).

---

## 5. Materialtypen und Preprocessing

| Typ | Erkennung | Normalisierung | Werkzeug |
|---|---|---|---|
| PDF | Extension + Magic Bytes | Text-Extraktion; bei Text-Ausbeute < 100 Zeichen/Seite: Seiten rastern + OCR | `pdftotext` (poppler), Fallback `ocrmypdf`/tesseract (deu+eng) |
| Office (docx, pptx, xlsx) | Extension | Konvertierung nach Markdown/Plaintext | `pandoc` (docx), `python-pptx`/`openpyxl`-basierte Extraktoren aus WSL |
| Webseite/URL | URL-Job | Abruf + Boilerplate-Entfernung nach den Egress-Hygiene-Regeln des Repos (kein `file://`, kein RFC1918, Größenlimit) | `defuddle-cli` (vom Repo als Extraktor vorgesehen), Fallback readability |
| Bild (png, jpg, webp) | Extension + Magic Bytes | Kein lokales OCR nötig: Bild wird dem Agent-Run direkt als Anhang mitgegeben (Claude liest Bildinhalt/Screenshot-Text selbst); zusätzlich EXIF-Metadaten in `manifest.json` | Agent SDK (Bild-Input), `exiftool` |
| Markdown/Text/Code | Extension | Durchreichen | — |
| Audio/Video | Extension | v1: `deferred` (siehe 4.2) | später: faster-whisper oder Cloud-API, Schnittstelle: Preprocessing-Plugin |

Das Preprocessing ist als Plugin-Kette implementiert (`detect → normalize → manifest`), damit die Transkription später als weiteres Plugin einrastet, ohne Pipeline-Umbau.

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
- **Einstellungen:** Watch-Ordner-Pfad, Parallelität, Datei-Limits, Git-Commit-Verhalten, API-Key-Status (Key selbst wird nie angezeigt).

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
```

---

## 7. Tech-Stack

| Schicht | Wahl | Anmerkung |
|---|---|---|
| Laufzeit | Node.js ≥ 20 LTS in WSL2 (Ubuntu 24.04) | |
| Backend | TypeScript, Fastify, better-sqlite3, chokidar, zod | ein Prozess, systemd-user-Service |
| Agent | `@anthropic-ai/claude-agent-sdk` (TypeScript) | headless Runs, `settingSources: ['project']`, bundelt das Claude-Code-Binary; separate Claude-Code-Installation für manuelle Nutzung im Vault weiterhin möglich |
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

**Policy-Vorbehalt:** Anthropics Regelung zur Agent-SDK-Nutzung mit Abos ist in Bewegung (Feb 2026: OAuth-Verbot fürs SDK; Juni 2026: angekündigtes separates SDK-Monatsguthaben, dessen Einführung am 15. Juni pausiert wurde — aktuell zählt SDK-Nutzung laut offizieller Support-Seite weiter gegen die Abo-Limits). Die Spec behandelt die Auth deshalb als austauschbares Modul; sollte Anthropic die Abo-Nutzung fürs SDK einschränken oder das Guthabenmodell aktivieren, ist nur die Umgebungskonfiguration und ggf. die Limit-Anzeige anzupassen. Vor Implementierungsstart von M0 ist der dann aktuelle Stand unter support.claude.com zu verifizieren.

---

## 8. Datenmodell (SQLite)

```sql
jobs(
  id TEXT PRIMARY KEY,            -- ulid
  user_id TEXT DEFAULT 'local',   -- Multi-User-Vorbereitung (Abschnitt 12.1)
  batch_id TEXT,                  -- gemeinsame Batches
  source TEXT NOT NULL,           -- 'drop' | 'watch' | 'url'
  type TEXT NOT NULL,             -- 'pdf' | 'office' | 'web' | 'image' | 'text' | 'av' | 'other'
  original_name TEXT, url TEXT,
  sha256 TEXT UNIQUE,             -- Dedupe
  status TEXT NOT NULL,           -- queued|preprocessing|ingesting|done|failed|deferred|duplicate|cancelled
  raw_path TEXT,                  -- .raw/<job-id>/
  created_pages TEXT,             -- JSON-Liste erzeugter/aktualisierter Wiki-Seiten
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
- Credentials (OAuth-Token bzw. API-Key) nur in der Service-Umgebung, nie im Frontend, nie in Logs, nie im Repo.
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

1. **Obsidian-Performance über `\\wsl$`:** Bei großen Vaults kann der 9p-Dateizugriff träge sein. Mitigation: früh testen (M0); Fallback Vault auf `/mnt/d/` mit Locking-Verifikation, oder Obsidian in WSLg.
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

### 12.4 Reihenfolge

Empfohlener Ausbaupfad nach v1-Stabilisierung: (1) Tailnet-Zugriff + Auth-Aktivierung (kleinster Schritt, sofortiger Mobile-Nutzen), (2) PWA-Share-Target, (3) Multi-User-Rollen, (4) Umzug auf Always-on-Host per Docker, (5) Git-Remote-Workflow für Zweitgerät-Edits.
