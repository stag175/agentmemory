<p align="center">
  <img src="../assets/banner.png" alt="agentmemory — Persistentes Gedächtnis für KI-Coding-Agenten" width="720" />
</p>

<p align="center">
  <strong>
    Ihr Coding-Agent merkt sich alles. Schluss mit dem ständigen Wiederholen.
    Built on <a href="https://github.com/iii-hq/iii">iii engine</a>
  </strong><br/>
  Persistentes Gedächtnis für Claude Code, Cursor, Gemini CLI, Codex CLI, Hermes, OpenClaw, pi, OpenCode und jeden MCP-Client.
</p>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.zh-TW.md">繁體中文</a> |
  <a href="README.ja-JP.md">日本語</a> |
  <a href="README.ko-KR.md">한국어</a> |
  <a href="README.es-ES.md">Español</a> |
  <a href="README.tr-TR.md">Türkçe</a> |
  <a href="README.ru-RU.md">Русский</a> |
  <a href="README.hi-IN.md">हिन्दी</a> |
  <a href="README.pt-BR.md">Português</a> |
  <a href="README.fr-FR.md">Français</a> |
  Deutsch
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/25123" target="_blank"><img src="https://trendshift.io/api/badge/repositories/25123" alt="rohitg00/agentmemory | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <a href="https://www.star-history.com/?repos=rohitg00%2Fagentmemory&type=date&legend=top-left">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=rohitg00/agentmemory&type=date&theme=dark&legend=top-left" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=rohitg00/agentmemory&type=date&legend=top-left" />
      <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=rohitg00/agentmemory&type=date&legend=top-left" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2"><img src="https://img.shields.io/badge/Viral%20GitHub%20Gist-1200%20stars%20%2F%20172%20forks-FF6B35?style=for-the-badge&logo=github&logoColor=white&labelColor=1a1a1a" alt="Design-Dokument: 1200 stars / 172 forks im Gist" /></a>
</p>

<p align="center">
  <em>Das Gist erweitert Karpathys LLM-Wiki-Muster um Confidence Scoring, Lifecycle, Knowledge Graphs und hybride Suche: agentmemory ist die Implementierung.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@agentmemory/agentmemory"><img src="https://img.shields.io/npm/v/@agentmemory/agentmemory?color=CB3837&label=npm&style=for-the-badge&logo=npm" alt="npm version" /></a>
  <a href="https://github.com/rohitg00/agentmemory/actions"><img src="https://img.shields.io/github/actions/workflow/status/rohitg00/agentmemory/ci.yml?label=tests&style=for-the-badge&logo=github" alt="CI" /></a>
  <a href="https://github.com/rohitg00/agentmemory/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rohitg00/agentmemory?color=blue&style=for-the-badge" alt="License" /></a>
  <a href="https://github.com/rohitg00/agentmemory/stargazers"><img src="https://img.shields.io/github/stars/rohitg00/agentmemory?style=for-the-badge&color=yellow&logo=github" alt="Stars" /></a>
</p>

<p align="center">
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-recall.svg"><img src="../assets/tags/stat-recall.svg" alt="95.2% retrieval R@5" height="38" /></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-tokens.svg"><img src="../assets/tags/stat-tokens.svg" alt="92% fewer tokens" height="38" /></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-tools.svg"><img src="../assets/tags/stat-tools.svg" alt="74 MCP tools" height="38" /></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-hooks.svg"><img src="../assets/tags/stat-hooks.svg" alt="12 auto hooks" height="38" /></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-deps.svg"><img src="../assets/tags/stat-deps.svg" alt="0 external DBs" height="38" /></picture>
  <picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/stat-tests.svg"><img src="../assets/tags/stat-tests.svg" alt="950+ tests passing" height="38" /></picture>
</p>

<p align="center">
  <img src="../assets/demo.gif" alt="agentmemory-Demo" width="720" />
</p>

<p align="center">
  <a href="#install">Installation</a> &bull;
  <a href="#quick-start">Schnellstart</a> &bull;
  <a href="#benchmarks">Benchmarks</a> &bull;
  <a href="#vs-competitors">Vergleich</a> &bull;
  <a href="#works-with-every-agent">Agenten</a> &bull;
  <a href="#how-it-works">Funktionsweise</a> &bull;
  <a href="#mcp-server">MCP</a> &bull;
  <a href="#real-time-viewer">Viewer</a> &bull;
  <a href="#iii-console">iii Console</a> &bull;
  <a href="#powered-by-iii">Powered by iii</a> &bull;
  <a href="#configuration">Konfiguration</a> &bull;
  <a href="#api">API</a>
</p>

---

## Install

```bash
npm install -g @agentmemory/agentmemory          # once — bare `agentmemory` on PATH
# If you hit EACCES on macOS/Linux system Node installs, retry with:
# sudo npm install -g @agentmemory/agentmemory
agentmemory                                      # start the memory server on :3111
agentmemory demo                                 # seed sample sessions + prove recall
agentmemory connect claude-code                  # wire your agent (also: codex, cursor, gemini-cli, ...)
```

Oder per `npx` (keine Installation):

```bash
npx @agentmemory/agentmemory
```

Achtung — npx cached pro Version. Wenn ein nacktes `npx @agentmemory/agentmemory` eine ältere Version liefert, erzwingen Sie die neueste mit `npx -y @agentmemory/agentmemory@latest` oder leeren Sie den Cache einmalig mit `rm -rf ~/.npm/_npx` (macOS/Linux; unter Windows löschen Sie `%LOCALAPPDATA%\npm-cache\_npx`). Der erste npx-Lauf ab v0.9.16+ fordert eine globale Installation inline an, sodass der nackte Befehl `agentmemory` anschließend überall funktioniert.

Vollständige Optionen unter [Schnellstart](#quick-start). Agenten­spezifische Verdrahtung unter [Funktioniert mit jedem Agenten](#works-with-every-agent).

---

<h2 id="works-with-every-agent"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-agents.svg"><img src="../assets/tags/section-agents.svg" alt="Funktioniert mit jedem Agenten" height="32" /></picture></h2>

agentmemory funktioniert mit jedem Agenten, der Hooks, MCP oder REST API unterstützt. Alle Agenten teilen sich denselben Memory-Server.

<table>
<tr>
<td align="center" width="12.5%">
<a href="https://claude.com/product/claude-code"><img src="https://matthiasroder.com/content/images/2026/01/Claude.png?size=120" alt="Claude Code" width="48" height="48" /></a><br/>
<strong>Claude Code</strong><br/>
<sub>natives Plugin + 12 Hooks + MCP</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/openai/codex"><img src="https://github.com/openai.png?size=120" alt="Codex CLI" width="48" height="48" /></a><br/>
<strong>Codex CLI</strong><br/>
<sub>natives Plugin + 6 Hooks + MCP</sub>
</td>
<td align="center" width="12.5%">
<a href="../integrations/openclaw/"><img src="https://github.com/openclaw.png?size=120" alt="OpenClaw" width="48" height="48" /></a><br/>
<strong>OpenClaw</strong><br/>
<sub>natives Plugin + MCP</sub>
</td>
<td align="center" width="12.5%">
<a href="../integrations/hermes/"><img src="https://github.com/NousResearch.png?size=120" alt="Hermes" width="48" height="48" /></a><br/>
<strong>Hermes</strong><br/>
<sub>natives Plugin + MCP</sub>
</td>
<td align="center" width="12.5%">
<a href="../integrations/pi/"><img src="../assets/agents/pi.svg" alt="pi" width="48" height="48" /></a><br/>
<strong>pi</strong><br/>
<sub>natives Plugin + MCP</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/tinyhumansai/openhuman"><img src="https://raw.githubusercontent.com/tinyhumansai/openhuman/main/app/src-tauri/icons/128x128.png" alt="OpenHuman" width="48" height="48" /></a><br/>
<strong>OpenHuman</strong><br/>
<sub>natives Memory-trait-Backend</sub>
</td>
<td align="center" width="12.5%">
<a href="https://cursor.com"><img src="https://www.freelogovectors.net/wp-content/uploads/2025/06/cursor-logo-freelogovectors.net_.png" alt="Cursor" width="48" height="48" /></a><br/>
<strong>Cursor</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/google-gemini/gemini-cli"><img src="https://github.com/google-gemini.png?size=120" alt="Gemini CLI" width="48" height="48" /></a><br/>
<strong>Gemini CLI</strong><br/>
<sub>MCP-Server</sub>
</td>
</tr>
<tr>
<td align="center" width="12.5%">
<a href="https://github.com/opencode-ai/opencode"><img src="https://github.com/opencode-ai.png?size=120" alt="OpenCode" width="48" height="48" /></a><br/>
<strong>OpenCode</strong><br/>
<sub>22 Hooks + MCP + Plugin</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/cline/cline"><img src="https://github.com/cline.png?size=120" alt="Cline" width="48" height="48" /></a><br/>
<strong>Cline</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/block/goose"><img src="https://github.com/block.png?size=120" alt="Goose" width="48" height="48" /></a><br/>
<strong>Goose</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/Kilo-Org/kilocode"><img src="https://github.com/Kilo-Org.png?size=120" alt="Kilo Code" width="48" height="48" /></a><br/>
<strong>Kilo Code</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/Aider-AI/aider"><img src="https://github.com/Aider-AI.png?size=120" alt="Aider" width="48" height="48" /></a><br/>
<strong>Aider</strong><br/>
<sub>REST API</sub>
</td>
<td align="center" width="12.5%">
<a href="https://claude.ai/download"><img src="https://github.com/anthropics.png?size=120" alt="Claude Desktop" width="48" height="48" /></a><br/>
<strong>Claude Desktop</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://windsurf.com"><img src="https://exafunction.github.io/public/brand/windsurf-black-symbol.svg?size=120" alt="Windsurf" width="48" height="48" /></a><br/>
<strong>Windsurf</strong><br/>
<sub>MCP-Server</sub>
</td>
<td align="center" width="12.5%">
<a href="https://github.com/RooCodeInc/Roo-Code"><img src="https://github.com/RooCodeInc.png?size=120" alt="Roo Code" width="48" height="48" /></a><br/>
<strong>Roo Code</strong><br/>
<sub>MCP-Server</sub>
</td>
</tr>
</table>

<p align="center">
  <sub>Funktioniert mit <strong>jedem</strong> Agenten, der MCP oder HTTP spricht. Ein Server, gemeinsame Erinnerungen für alle.</sub>
</p>

---

Sie erklären in jeder Session dieselbe Architektur. Sie entdecken dieselben Bugs erneut. Sie bringen dem Agenten dieselben Präferenzen wieder bei. Eingebautes Gedächtnis (CLAUDE.md, .cursorrules) ist bei 200 Zeilen am Ende und veraltet. agentmemory behebt das. Es erfasst stillschweigend, was Ihr Agent tut, komprimiert das Ganze in durchsuchbares Gedächtnis und injiziert beim Start der nächsten Session den passenden Kontext. Ein Befehl. Funktioniert über Agenten hinweg.

**Was sich ändert:** Session 1 richten Sie JWT-Authentifizierung ein. Session 2 fragen Sie nach Rate Limiting. Der Agent weiß bereits, dass Ihre Auth jose-Middleware in `src/middleware/auth.ts` verwendet, dass Ihre Tests Token-Validierung abdecken und dass Sie sich aus Gründen der Edge-Kompatibilität für jose statt jsonwebtoken entschieden haben. Kein Wiederholen. Kein Copy-Paste. Der Agent *weiß es einfach*.

```bash
npx @agentmemory/agentmemory
```

> **Neu in v0.9.0** — Landing-Site unter [agent-memory.dev](https://agent-memory.dev), Filesystem-Connector (`@agentmemory/fs-watcher`), das standalone MCP proxyt nun zum laufenden Server, sodass Hooks und Viewer übereinstimmen, Audit-Policy auf jedem Delete-Pfad kodifiziert, der Health-Check meldet `memory_critical` nicht mehr bei kleinen Node-Prozessen. Vollständige Hinweise in [CHANGELOG.md](../CHANGELOG.md#090--2026-04-18).

---

<h2 id="benchmarks"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-benchmarks.svg"><img src="../assets/tags/section-benchmarks.svg" alt="Benchmarks" height="32" /></picture></h2>

<table>
<tr>
<td width="50%">

### Retrieval-Genauigkeit

**coding-agent-life-v1** (interner Korpus, Sandbox-reproduzierbar)

| Adapter | P@5 | R@5 | Top-5-Trefferquote | p50-Latenz |
|---|---|---|---|---|
| **agentmemory hybrid** | **0.578** | **0.967** | **15 / 15** | 14 ms |
| grep-Baseline | 0.267 | 0.967 | 15 / 15 | 0 ms |

100 % Top-5-Trefferquote. **2,2×** bessere Präzision als die grep-Baseline bei identischer Eingabe. Volle Aufschlüsselung pro Typ: [`docs/benchmarks/2026-05-20-coding-agent-life-v1.md`](../docs/benchmarks/2026-05-20-coding-agent-life-v1.md).

**LongMemEval-S** (ICLR 2025, 500 Fragen)

| System | R@5 | R@10 | MRR |
|---|---|---|---|
| **agentmemory** | **95.2%** | **98.6%** | **88.2%** |
| BM25-only Fallback | 86.2% | 94.6% | 71.5% |

</td>
<td width="50%">

### Token-Einsparungen

| Ansatz | Tokens/Jahr | Kosten/Jahr |
|---|---|---|
| Vollständigen Kontext einfügen | 19,5M+ | Unmöglich (überschreitet das Fenster) |
| LLM-zusammengefasst | ~650K | ~500 $ |
| **agentmemory** | **~170K** | **~10 $** |
| agentmemory + lokale Embeddings | ~170K | **0 $** |

</td>
</tr>
</table>

> Embedding-Modell: `all-MiniLM-L6-v2` (lokal, kostenlos, kein API-Schlüssel). Vollständige Berichte: [`benchmark/LONGMEMEVAL.md`](../benchmark/LONGMEMEVAL.md), [`benchmark/QUALITY.md`](../benchmark/QUALITY.md), [`benchmark/SCALE.md`](../benchmark/SCALE.md). Konkurrenzvergleich: [`benchmark/COMPARISON.md`](../benchmark/COMPARISON.md) — agentmemory vs mem0, Letta, Khoj, claude-mem, Hippo.

**Lokal reproduzieren:** [`eval/README.md`](../eval/README.md) — Adapter-pluggable Harness für LongMemEval `_s` (öffentlich, 500 Fragen) + `coding-agent-life-v1` (interner 15-Session-Korpus). Adapter für grep / vector / agentmemory werden direkt verglichen, NDJSON-Ausgabe, veröffentlichte Scorecards landen in [`docs/benchmarks/`](../docs/benchmarks/).

**Funktioniert kombiniert mit [codegraph](https://github.com/colbymchenry/codegraph), [Understand Anything](https://github.com/Lum1104/Understand-Anything) und [Graphify](https://github.com/safishamsi/graphify).** Code-Graph-Indizierung, mehragentige Build-Pipelines und breitere Knowledge Graphs über Docs / PDFs / Bilder / Videos. agentmemory merkt sich die Arbeit; diese drei Projekte beleuchten den Rest der Kontextschicht. Rezepte + Frage-Routing-Tabelle: [`docs/recipes/pairings.md`](../docs/recipes/pairings.md).

---

<h2 id="vs-competitors"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-competitors.svg"><img src="../assets/tags/section-competitors.svg" alt="Vergleich mit der Konkurrenz" height="32" /></picture></h2>

<table>
<tr>
<th width="20%"></th>
<th width="20%">agentmemory</th>
<th width="20%">mem0 (53K ⭐)</th>
<th width="20%">Letta / MemGPT (22K ⭐)</th>
<th width="20%">Eingebaut (CLAUDE.md)</th>
</tr>
<tr>
<td><strong>Typ</strong></td>
<td>Memory-Engine + MCP-Server</td>
<td>Memory-Layer-API</td>
<td>Komplette Agenten-Runtime</td>
<td>Statische Datei</td>
</tr>
<tr>
<td><strong>Retrieval R@5</strong></td>
<td><strong>95.2%</strong></td>
<td>68.5% (LoCoMo)</td>
<td>83.2% (LoCoMo)</td>
<td>N/V (grep)</td>
</tr>
<tr>
<td><strong>Auto-Erfassung</strong></td>
<td>12 Hooks (null manueller Aufwand)</td>
<td>Manuelle <code>add()</code>-Aufrufe</td>
<td>Agent bearbeitet sich selbst</td>
<td>Manuelle Bearbeitung</td>
</tr>
<tr>
<td><strong>Suche</strong></td>
<td>BM25 + Vector + Graph (RRF-Fusion)</td>
<td>Vector + Graph</td>
<td>Vector (Archival)</td>
<td>Lädt alles in den Kontext</td>
</tr>
<tr>
<td><strong>Multi-Agent</strong></td>
<td>MCP + REST + Leases + Signals</td>
<td>API (keine Koordination)</td>
<td>Nur innerhalb der Letta-Runtime</td>
<td>Dateien pro Agent</td>
</tr>
<tr>
<td><strong>Framework-Lock-in</strong></td>
<td>Keiner (jeder MCP-Client)</td>
<td>Keiner</td>
<td>Hoch (Letta erforderlich)</td>
<td>Format pro Agent</td>
</tr>
<tr>
<td><strong>Externe Abhängigkeiten</strong></td>
<td>Keine (SQLite + iii-engine)</td>
<td>Qdrant / pgvector</td>
<td>Postgres + Vector-DB</td>
<td>Keine</td>
</tr>
<tr>
<td><strong>Memory-Lifecycle</strong></td>
<td>4-stufige Konsolidierung + Decay + Auto-Forget</td>
<td>Passive Extraktion</td>
<td>Vom Agenten verwaltet</td>
<td>Manuelles Pruning</td>
</tr>
<tr>
<td><strong>Token-Effizienz</strong></td>
<td>~1.900 Tokens/Session (10 $/Jahr)</td>
<td>Je nach Integration unterschiedlich</td>
<td>Core Memory im Kontext</td>
<td>22K+ Tokens bei 240 Beobachtungen</td>
</tr>
<tr>
<td><strong>Echtzeit-Viewer</strong></td>
<td>Ja (Port 3113)</td>
<td>Cloud-Dashboard</td>
<td>Cloud-Dashboard</td>
<td>Nein</td>
</tr>
<tr>
<td><strong>Self-hosted</strong></td>
<td>Ja (Standard)</td>
<td>Optional</td>
<td>Optional</td>
<td>Ja</td>
</tr>
</table>

---

<h2 id="quick-start"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-quickstart.svg"><img src="../assets/tags/section-quickstart.svg" alt="Schnellstart" height="32" /></picture></h2>

Kompatibilität: Diese Version zielt auf stabiles `iii-sdk` `^0.11.0` und iii-engine v0.11.x ab.

### In 30 Sekunden ausprobieren

```bash
# Terminal 1: start the server
npx @agentmemory/agentmemory

# Terminal 2: seed sample data and see recall in action
npx @agentmemory/agentmemory demo
```

`demo` befüllt 3 realistische Sessions (JWT-Auth, N+1-Query-Fix, Rate Limiting) und führt semantische Suchen darauf aus. Sie sehen, wie „N+1 query fix" gefunden wird, wenn Sie nach „database performance optimization" suchen — Keyword-Matching kann das nicht.

Öffnen Sie `http://localhost:3113`, um das Memory in Echtzeit aufgebaut zu sehen.

### Empfohlen: global installieren

`npx` cached pro Version. Wenn Sie letzte Woche `npx @agentmemory/agentmemory@0.9.14` ausgeführt haben, kann ein nacktes `npx @agentmemory/agentmemory` das veraltete 0.9.14 aus `~/.npm/_npx/` ausliefern und nicht die neueste Version. Einmal installieren, und der nackte Befehl `agentmemory` funktioniert überall:

```bash
npm install -g @agentmemory/agentmemory
# If you hit EACCES on macOS/Linux system Node installs, retry with:
# sudo npm install -g @agentmemory/agentmemory
agentmemory                    # start the server (same as the npx form)
agentmemory stop               # tear it down
agentmemory remove             # uninstall everything we created
agentmemory connect claude-code   # wire one agent
agentmemory doctor             # interactive diagnostics + fix prompts
```

Ab v0.9.16 fordert der erste npx-Lauf inline zu einer globalen Installation auf — einmal mit `Y` antworten, fertig. Wenn Sie das überspringen, greifen Sie für einen frischen Fetch auf eine dieser Möglichkeiten zurück:

```bash
npx -y @agentmemory/agentmemory@latest                 # forces latest from npm (cross-platform)
rm -rf ~/.npm/_npx && npx @agentmemory/agentmemory     # macOS/Linux only (POSIX shell)
```

Unter Windows / PowerShell lautet das Äquivalent zum Leeren des Caches `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx"` — die plattformübergreifende Option ist `npx -y ...@latest` oben.

### Session-Replay

Jede Session, die agentmemory aufzeichnet, ist abspielbar. Öffnen Sie den Viewer, wählen Sie den Reiter **Replay** und scrubben Sie durch die Timeline: Prompts, Tool-Aufrufe, Tool-Ergebnisse und Antworten werden als diskrete Events mit Play/Pause, Geschwindigkeitssteuerung (0,5×–4×) und Tastenkürzeln (Leertaste zum Umschalten, Pfeile zum Schrittweisen) gerendert.

Haben Sie ältere Claude-Code-JSONL-Transkripte, die Sie übernehmen wollen?

```bash
# Import everything under the default ~/.claude/projects
npx @agentmemory/agentmemory import-jsonl

# Or import a single file
npx @agentmemory/agentmemory import-jsonl ~/.claude/projects/-my-project/abc123.jsonl
```

Importierte Sessions tauchen im Replay-Picker neben den nativen auf. Intern routet jeder Eintrag durch die iii-Funktionen `mem::replay::load`, `mem::replay::sessions` und `mem::replay::import-jsonl` — keine Seitenkanal-Server.

### Upgrade / Wartung

Verwenden Sie den Wartungsbefehl, wenn Sie Ihr lokales Runtime bewusst aktualisieren wollen:

```bash
npx @agentmemory/agentmemory upgrade
```

Achtung: Dieser Befehl verändert den aktuellen Workspace/Runtime. Er kann JavaScript-Abhängigkeiten aktualisieren und das gepinnte Docker-Image `iiidev/iii:0.11.2` ziehen. Er installiert niemals eine ungepinnte oder neuere iii-Engine.

Implementierungsdetails in `src/cli.ts` (siehe `runUpgrade` rund um den Bereich `src/cli.ts:544-595`).

### Claude Code (ein Block, einfügen)

```text
Install agentmemory: run `npx @agentmemory/agentmemory` in a separate terminal to start the memory server. Then run `/plugin marketplace add rohitg00/agentmemory` and `/plugin install agentmemory` — the plugin registers all 12 hooks, 15 skills, AND auto-wires the `@agentmemory/mcp` stdio server via its `.mcp.json`, so you get 74 MCP tools (memory_smart_search, memory_save, memory_sessions, memory_governance_delete, etc.) without any extra config step. Verify with `curl http://localhost:3111/agentmemory/health`. The real-time viewer is at http://localhost:3113.
```

#### Claude Code ohne Plugin-Installation (MCP-Standalone-Pfad)

Wenn Sie den MCP-Server von agentmemory direkt über `~/.claude.json` verdrahten anstatt über `/plugin install`, löst Claude Code `${CLAUDE_PLUGIN_ROOT}` niemals auf, und Sie müssen Hook-Skripte in `~/.claude/settings.json` auf absolute Pfade zeigen lassen. Diese Pfade enthalten typischerweise die agentmemory-Version (z. B. `~/.codex/plugins/cache/agentmemory/agentmemory/0.9.21/scripts/…`), sodass das nächste Upgrade jeden Hook stillschweigend bricht.

Workaround:

```bash
agentmemory connect claude-code --with-hooks
```

Das mischt dieselben Hook-Befehle in `~/.claude/settings.json` ein, mit absoluten Pfaden, die in das mitgelieferte `plugin/`-Verzeichnis des aktuell installierten `@agentmemory/agentmemory`-Pakets auflösen. Führen Sie den Befehl nach einem agentmemory-Upgrade erneut aus, um die Pfade zu aktualisieren. Eigene Einträge in derselben Datei bleiben erhalten; nur frühere agentmemory-Einträge werden ersetzt. Den `/plugin install`-Pfad zu nutzen, bleibt der empfohlene Ansatz.
Für entfernte oder geschützte Deployments starten Sie Claude Code mit gesetztem `AGENTMEMORY_URL` und `AGENTMEMORY_SECRET`. Das Plugin reicht beide Werte an seinen mitgelieferten MCP-Server weiter; ist `AGENTMEMORY_URL` leer, verwendet das MCP-Shim `http://localhost:3111`.

### Codex CLI (Codex-Plugin-Plattform)

```bash
# 1. start the memory server in a separate terminal
npx @agentmemory/agentmemory

# 2. register the agentmemory marketplace and install the plugin
codex plugin marketplace add rohitg00/agentmemory
codex plugin add agentmemory@agentmemory
```

Das Codex-Plugin wird aus demselben `plugin/`-Verzeichnis ausgeliefert wie das Claude-Code-Plugin. Es registriert:

- `@agentmemory/mcp` als MCP-Server (proxyt alle 74 Tools, wenn `AGENTMEMORY_URL` auf einen laufenden agentmemory-Server zeigt; fällt lokal auf 19 Tools zurück, wenn kein Server erreichbar ist)
- 6 Lifecycle-Hooks: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`
- 4 Skills: `/recall`, `/remember`, `/session-history`, `/forget`

Codex' Hook-Engine injiziert `CLAUDE_PLUGIN_ROOT` in Hook-Subprozesse (siehe [`codex-rs/hooks/src/engine/discovery.rs`](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/engine/discovery.rs)), sodass dieselben Hook-Skripte ohne Duplikation auf beiden Hosts laufen. Die Events Subagent / SessionEnd / Notification / TaskCompleted / PostToolUseFailure gibt es nur in Claude Code und werden für Codex nicht registriert.

#### Codex Desktop: Plugin-Hooks derzeit lautlos (Workaround vorhanden)

`CodexHooks` und `PluginHooks` sind beide stabil und standardmäßig aktiviert in [`codex-rs/features/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs), aber aktuelle Codex-Desktop-Builds dispatchen die plugin-lokale `hooks.json` nicht ([openai/codex#16430](https://github.com/openai/codex/issues/16430)). MCP-Tools funktionieren weiterhin; nur die Lifecycle-Beobachtungen fehlen.

Solange der Fix upstream nicht gelandet ist, spiegeln Sie dieselben Hook-Befehle in die globale `~/.codex/hooks.json`:

```bash
agentmemory connect codex --with-hooks
```

Das fügt einen idempotenten Block zu `~/.codex/hooks.json` hinzu, der absolute Pfade zu den mitgelieferten Skripten referenziert (keine `${CLAUDE_PLUGIN_ROOT}`-Expansion auf Benutzer-Scope nötig). Führen Sie denselben Befehl nach einem agentmemory-Upgrade erneut aus, um die Pfade zu aktualisieren. Eigene Einträge in derselben Datei bleiben erhalten; nur frühere agentmemory-Einträge werden ersetzt.

<details>
<summary><b>OpenClaw (diesen Prompt einfügen)</b></summary>

```text
Install agentmemory for OpenClaw. Run `npx @agentmemory/agentmemory` in a separate terminal to start the memory server on localhost:3111. Then add this to my OpenClaw MCP config so agentmemory is available with all 74 memory tools:

{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3111"
      }
    }
  }
}

Restart OpenClaw. Verify with `curl http://localhost:3111/agentmemory/health`. Open http://localhost:3113 for the real-time viewer. For deeper memory-slot integration, copy `integrations/openclaw` to `~/.openclaw/extensions/agentmemory` and enable `plugins.slots.memory = "agentmemory"` in `~/.openclaw/openclaw.json`.
```

Vollständiger Leitfaden: [`integrations/openclaw/`](../integrations/openclaw/)

</details>

<details>
<summary><b>Hermes Agent (diesen Prompt einfügen)</b></summary>

```text
Install agentmemory for Hermes. Run `npx @agentmemory/agentmemory` in a separate terminal to start the memory server on localhost:3111. Then add this to ~/.hermes/config.yaml so Hermes can use agentmemory as an MCP server with all 74 memory tools:

mcp_servers:
  agentmemory:
    command: npx
    args: ["-y", "@agentmemory/mcp"]

memory:
  provider: agentmemory

Verify with `curl http://localhost:3111/agentmemory/health`. Open http://localhost:3113 for the real-time viewer. For deeper 6-hook memory provider integration (pre-LLM context injection, turn capture, MEMORY.md mirroring, system prompt block), copy integrations/hermes from the agentmemory repo to ~/.hermes/plugins/agentmemory.
```

Vollständiger Leitfaden: [`integrations/hermes/`](../integrations/hermes/)

</details>

### Andere Agenten

Starten Sie den Memory-Server: `npx @agentmemory/agentmemory`

Der agentmemory-Eintrag ist der **gleiche MCP-Server-Block** für jeden Host, der das `mcpServers`-Format verwendet (Cursor, Claude Desktop, Cline, Roo Code, Windsurf, Gemini CLI, OpenClaw):

```json
"agentmemory": {
  "command": "npx",
  "args": ["-y", "@agentmemory/mcp"],
  "env": {
    "AGENTMEMORY_URL": "${AGENTMEMORY_URL}",
    "AGENTMEMORY_SECRET": "${AGENTMEMORY_SECRET}"
  }
}
```

**Fügen Sie diesen Eintrag in das bestehende `mcpServers`-Objekt** in der Konfigurationsdatei des Hosts ein — ersetzen Sie nicht die Datei. Wenn die Datei bereits andere Server enthält, fügen Sie `agentmemory` als zusätzlichen Schlüssel innerhalb von `mcpServers` daneben ein. Fehlt `mcpServers` ganz, fügen Sie den Block innerhalb von `{ "mcpServers": { ... } }` ein. Die `${VAR}`-Platzhalter übernehmen `AGENTMEMORY_URL` / `AGENTMEMORY_SECRET` aus der Shell beim Start des MCP-Servers — nicht gesetzte Variablen werden als leere Strings übergeben, und das Shim fällt auf `http://localhost:3111` zurück. Ein einziger verdrahteter Eintrag deckt sowohl lokale als auch entfernte (k8s / reverse-proxied) Deployments ab.

| Agent | Konfigurationsdatei | Hinweise |
|---|---|---|
| **Cursor** | `~/.cursor/mcp.json` | In `mcpServers` einfügen. Ein-Klick-Deeplink auch auf der Website. |
| **Claude Desktop** | `claude_desktop_config.json` (Application Support) | In `mcpServers` einfügen. Claude Desktop nach dem Editieren neu starten. |
| **Cline / Roo Code / Kilo Code** | Cline-MCP-Einstellungen (Settings UI → MCP Servers → Edit) | Gleicher `mcpServers`-Block. |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | Gleicher `mcpServers`-Block. |
| **Gemini CLI** | `~/.gemini/settings.json` | `gemini mcp add agentmemory npx -y @agentmemory/mcp --scope user` (automatisches Mergen). |
| **OpenClaw** | OpenClaw-MCP-Konfig | Gleicher `mcpServers`-Block oder das tiefer integrierte [Memory-Plugin](../integrations/openclaw/). |
| **Codex CLI (nur MCP)** | `.codex/config.toml` | TOML-Form: `codex mcp add agentmemory -- npx -y @agentmemory/mcp` oder `[mcp_servers.agentmemory]` manuell hinzufügen. |
| **Codex CLI (volles Plugin)** | Codex-Plugin-Marketplace | `codex plugin marketplace add rohitg00/agentmemory`, dann `codex plugin add agentmemory@agentmemory`. Registriert MCP + 6 Lifecycle-Hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop) + 15 Skills. Auf Codex Desktop zusätzlich `agentmemory connect codex --with-hooks` ausführen, bis [openai/codex#16430](https://github.com/openai/codex/issues/16430) landet — Plugin-Hooks sind dort derzeit lautlos. |
| **OpenCode (nur MCP)** | `opencode.json` | Anderes Format — `mcp`-Schlüssel auf oberster Ebene, Command als Array: `{"mcp": {"agentmemory": {"type": "local", "command": ["npx", "-y", "@agentmemory/mcp"], "enabled": true}}}`. |
| **OpenCode (volles Plugin)** | `plugin/opencode/` | 22 Auto-Capture-Hooks für Session-Lifecycle, Messages, Tools, Fehler. Zwei Slash-Befehle (`/recall`, `/remember`). Kopieren Sie `plugin/opencode/` in Ihren OpenCode-Workspace und fügen Sie den Plugin-Eintrag zu `opencode.json` hinzu. Siehe [`plugin/opencode/README.md`](../plugin/opencode/README.md) für die vollständige Hook-Tabelle + Gap-Analyse. |
| **pi** | `~/.pi/agent/extensions/agentmemory` | [`integrations/pi`](../integrations/pi/) kopieren und pi neu starten. |
| **Hermes Agent** | `~/.hermes/config.yaml` | Verwenden Sie das tiefer integrierte [Memory-Provider-Plugin](../integrations/hermes/) mit `memory.provider: agentmemory`. |
| **Qwen Code** | `~/.qwen/settings.json` | `agentmemory connect qwen` schreibt den standardmäßigen `mcpServers`-Block. Die Hook-Payload ist feldkompatibel mit Claude Code, sodass die bestehenden 12 Hook-Skripte ohne Änderung funktionieren — verdrahten Sie sie über den Abschnitt `hooks` in derselben `settings.json`. |
| **Antigravity** (ersetzt Gemini CLI) | `mcp_config.json` (im User-Verzeichnis von Antigravity) | `agentmemory connect antigravity` schreibt den standardmäßigen `mcpServers`-Block. macOS: `~/Library/Application Support/Antigravity/User/`. Linux: `~/.config/Antigravity/User/`. Nach dem Sunset von Gemini CLI am 2026-06-18 zu nutzen. |
| **Kiro** | `~/.kiro/settings/mcp.json` | `agentmemory connect kiro` schreibt die Konfig auf Benutzerebene. Workspace-Overrides liegen in `.kiro/settings/mcp.json` neben Ihrem Code. |
| **Goose** | Goose-MCP-Einstellungen-UI | Gleicher `mcpServers`-Block. |
| **Aider** | n/v | Sprechen Sie direkt mit der REST API: `curl -X POST http://localhost:3111/agentmemory/smart-search -d '{"query": "auth"}'`. |
| **Jeder Agent (32+)** | n/v | `npx skillkit install agentmemory` erkennt den Host automatisch und merged. |

**MCP-Clients in Sandboxen** (Flatpak / Snap / restriktive Container), die den `localhost` des Hosts nicht erreichen können: Setzen Sie zusätzlich `"AGENTMEMORY_FORCE_PROXY": "1"` im `env`-Block und lassen Sie `AGENTMEMORY_URL` auf eine Route zeigen, die die Sandbox tatsächlich erreichen kann (z. B. Ihre LAN-IP).

### Programmatischer Zugriff (Python / Rust / Node)

agentmemory registriert seine Kernoperationen als iii-Funktionen (`mem::remember`, `mem::observe`, `mem::context`, `mem::smart-search`, `mem::forget`). Jede Sprache mit einem iii-SDK kann sie direkt über `ws://localhost:49134` aufrufen — kein separater REST-Client pro Sprache nötig.

```bash
pip install iii-sdk         # Python
cargo add iii-sdk           # Rust
npm  install iii-sdk        # Node
```

```python
from iii import register_worker

iii = register_worker("ws://localhost:49134")
iii.connect()

iii.trigger({
    "function_id": "mem::smart-search",
    "payload": {"project": "demo", "query": "how do tokens refresh"},
})
```

Vollständiges Beispiel: [`examples/python/`](../examples/python/) (Quickstart + Beobachtungs-/Recall-Fluss). REST auf `:3111` bleibt verfügbar für Hosts ohne iii-Runtime.

### Aus den Quellen

```bash
git clone https://github.com/rohitg00/agentmemory.git && cd agentmemory
npm install && npm run build && npm start
```

Das startet agentmemory mit einer lokalen `iii-engine`, falls `iii` bereits installiert ist, oder fällt auf Docker Compose zurück, falls Docker vorhanden ist. REST, Streams und der Viewer binden sich standardmäßig an `127.0.0.1`.

`iii-engine` manuell installieren. **agentmemory pinnt `iii-engine` derzeit auf `v0.11.2`** — `v0.11.6` führt ein neues Modell ein, alles per `iii worker add` zu sandboxen, für das agentmemory noch nicht refaktoriert wurde. Der Pin wird aufgehoben, sobald die Refaktorierung erfolgt ist. Überschreiben Sie mit `AGENTMEMORY_III_VERSION=<version>`, wenn Sie manuell auf das Sandbox-Modell migriert sind.

- **macOS arm64:** `mkdir -p ~/.local/bin && curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v0.11.2/iii-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.local/bin && chmod +x ~/.local/bin/iii`
- **macOS x64:** `aarch64-apple-darwin` durch `x86_64-apple-darwin` ersetzen
- **Linux x64:** durch `x86_64-unknown-linux-gnu` ersetzen
- **Linux arm64:** durch `aarch64-unknown-linux-gnu` ersetzen
- **Windows:** `iii-x86_64-pc-windows-msvc.zip` von [iii-hq/iii releases v0.11.2](https://github.com/iii-hq/iii/releases/tag/iii%2Fv0.11.2) herunterladen, `iii.exe` extrahieren, zum PATH hinzufügen

Oder Docker verwenden (die mitgelieferte `docker-compose.yml` zieht `iiidev/iii:0.11.2`). Vollständige Doku: [iii.dev/docs](https://iii.dev/docs).

### Windows

agentmemory läuft auf Windows 10/11, aber das Node.js-Paket allein genügt nicht — Sie brauchen außerdem das `iii-engine`-Runtime (ein separates natives Binary) als Hintergrundprozess. Der offizielle Upstream-Installer ist ein `sh`-Skript, und es gibt heute weder einen PowerShell-Installer noch ein scoop/winget-Paket, daher haben Windows-Nutzer zwei Wege:

**Option A — Vorgebautes Windows-Binary (empfohlen):**

```powershell
# 1. Open https://github.com/iii-hq/iii/releases/tag/iii%2Fv0.11.2 in your browser
#    (we pin to v0.11.2 until agentmemory refactors for the new sandbox
#     model that engine v0.11.6+ requires)
# 2. Download iii-x86_64-pc-windows-msvc.zip
#    (or iii-aarch64-pc-windows-msvc.zip if you're on an ARM machine)
# 3. Extract iii.exe somewhere on PATH, or place it at:
#    %USERPROFILE%\.local\bin\iii.exe
#    (agentmemory checks that location automatically)
# 4. Verify:
iii --version
# Should print: 0.11.2

# 5. Then run agentmemory as usual:
npx -y @agentmemory/agentmemory
```

**Option B — Docker Desktop:**

```powershell
# 1. Install Docker Desktop for Windows
# 2. Start Docker Desktop and make sure the engine is running
# 3. Run agentmemory — it will auto-start the bundled compose file:
npx -y @agentmemory/agentmemory
```

**Option C — Nur Standalone-MCP (ohne Engine):** Wenn Sie nur die MCP-Tools für Ihren Agenten brauchen und weder REST API, Viewer noch Cron-Jobs, überspringen Sie die Engine ganz:

```powershell
npx -y @agentmemory/agentmemory mcp
# or via the shim package:
npx -y @agentmemory/mcp
```

**Diagnose unter Windows:** Wenn `npx @agentmemory/agentmemory` fehlschlägt, mit `--verbose` neu starten, um das tatsächliche Engine-stderr zu sehen. Häufige Fehlerbilder:

| Symptom | Lösung |
|---|---|
| `iii-engine process started`, dann `did not become ready within 15s` | Engine ist beim Start abgestürzt — mit `--verbose` neu starten, stderr prüfen |
| `Could not start iii-engine` | Weder `iii.exe` noch Docker installiert. Siehe Option A oder B oben |
| Port-Konflikt | `netstat -ano \| findstr :3111`, um zu sehen, was gebunden ist, dann beenden oder `--port <N>` verwenden |
| Docker-Fallback wird übersprungen, obwohl Docker installiert ist | Stellen Sie sicher, dass Docker Desktop tatsächlich läuft (Taskleisten-Icon) |

> Hinweis: Die iii-**Engine** ist ein vorgebautes Binary, kein Cargo-Crate — versuche nicht, sie per `cargo install` zu installieren. (Die iii-**SDKs** sind auf crates.io, npm und PyPI veröffentlicht, aber agentmemory benötigt sie nicht.) Unterstützte Engine-Installationsmethoden, alle auf v0.11.2 gepinnt: das vorgebaute v0.11.2-Binary oben, das Upstream-`sh`-Installationsskript **mit dem Versions-Pin** `curl -fsSL https://install.iii.dev/iii/main/install.sh | VERSION=0.11.2 sh` (macOS/Linux) und das Docker-Image `iiidev/iii:0.11.2`. Ein bloßes `install.sh | sh` installiert die **neueste** Engine, die agentmemory nicht unterstützt — übergib immer `VERSION=0.11.2`. Am einfachsten von allen: Führe einfach `npx @agentmemory/agentmemory` aus, das die gepinnte Engine für dich nach `~/.agentmemory/bin` holt.

---

<h2 id="deploy">Deployment</h2>

Ein-Klick-Vorlagen für gemanagte Hosts. Jede liefert ein autonomes
Dockerfile aus, das `@agentmemory/agentmemory` aus npm bezieht und das
iii-engine-Binary aus dem offiziellen `iiidev/iii`-Image vom Docker Hub
kopiert — keine vorgebaute agentmemory-Image-Erforderlichkeit. Persistenter
Speicher wird unter `/data` gemountet; der Entrypoint beim ersten Boot
überschreibt die per npm gelieferte iii-Konfig (die `127.0.0.1` bindet)
mit einer deploy-tauglichen Variante, die `0.0.0.0` bindet und absolute
`/data`-Pfade verwendet, generiert das HMAC-Secret und senkt die
Privilegien von `root` auf `node` via `gosu`, bevor er die agentmemory-CLI
exec't.

<p>
  <a href="https://fly.io/launch?repo=https://github.com/rohitg00/agentmemory&path=deploy/fly"><img src="https://img.shields.io/badge/Deploy%20to-fly.io-8b5cf6?style=for-the-badge&logo=fly.io&logoColor=white" alt="Deploy to fly.io" /></a>
  <a href="https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2Frohitg00%2Fagentmemory&rootDirectory=deploy%2Frailway"><img src="https://img.shields.io/badge/Deploy%20to-Railway-0B0D0E?style=for-the-badge&logo=railway&logoColor=white" alt="Deploy to Railway" /></a>
</p>

Der Ein-Klick-Deploy-Button von Render erfordert eine `render.yaml` im Repository-Root, das wir bewusst sauber halten. Verwenden Sie den Render-Blueprint-Fluss, dokumentiert in [`deploy/render/`](./deploy/render/README.md), um manuell auf das im Repo liegende Blueprint zu zeigen.

Vollständige Setup-Details (HMAC-Capture, Viewer-SSH-Tunnel, Rotation, Backup, Kostenuntergrenzen) finden Sie in [`deploy/`](./deploy/README.md):

- [`deploy/fly`](./deploy/fly/README.md) — Einzelmaschine mit
  `auto_stop_machines = "stop"`; am günstigsten im Leerlauf.
- [`deploy/railway`](./deploy/railway/README.md) — Hobby-Plan mit Pauschalpreis,
  Volume im Dashboard.
- [`deploy/render`](./deploy/render/README.md) — Blueprint-Fluss,
  automatische Disk-Snapshots auf bezahlten Plänen.
- [`deploy/coolify`](./deploy/coolify/README.md) — self-hosted auf Ihrem
  eigenen VPS via [Coolify](https://coolify.io/self-hosted); derselbe
  Docker-Compose-Stack, Sie besitzen Host und Daten.

Nur Port `3111` wird veröffentlicht. Der Viewer auf `3113` bleibt im
Container an Loopback gebunden — jedes Template-README dokumentiert
das SSH-Tunnel-Muster, um ihn zu erreichen.

---

<h2 id="why-agentmemory"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-why.svg"><img src="../assets/tags/section-why.svg" alt="Warum agentmemory" height="32" /></picture></h2>

Jeder Coding-Agent vergisst alles, wenn die Session endet. Sie verschwenden die ersten 5 Minuten jeder Session damit, Ihren Stack erneut zu erklären. agentmemory läuft im Hintergrund und beseitigt das vollständig.

```text
Session 1: "Add auth to the API"
  Agent writes code, runs tests, fixes bugs
  agentmemory silently captures every tool use
  Session ends -> observations compressed into structured memory

Session 2: "Now add rate limiting"
  Agent already knows:
    - Auth uses JWT middleware in src/middleware/auth.ts
    - Tests in test/auth.test.ts cover token validation
    - You chose jose over jsonwebtoken for Edge compatibility
  Zero re-explaining. Starts working immediately.
```

### vs. eingebautes Agent-Memory

Jeder KI-Coding-Agent kommt mit eingebautem Memory — Claude Code hat `MEMORY.md`, Cursor hat Notepads, Cline hat Memory Bank. Das funktioniert wie Klebezettel. agentmemory ist die durchsuchbare Datenbank hinter den Klebezetteln.

| | Eingebaut (CLAUDE.md) | agentmemory |
|---|---|---|
| Skalierung | 200-Zeilen-Limit | Unbegrenzt |
| Suche | Lädt alles in den Kontext | BM25 + Vector + Graph (nur Top-K) |
| Token-Kosten | 22K+ bei 240 Beobachtungen | ~1.900 Tokens (92 % weniger) |
| Agentenübergreifend | Dateien pro Agent | MCP + REST (jeder Agent) |
| Koordination | Keine | Leases, Signale, Actions, Routinen |
| Observability | Dateien manuell lesen | Echtzeit-Viewer auf :3113 |

---

<h2 id="how-it-works"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-how.svg"><img src="../assets/tags/section-how.svg" alt="Funktionsweise" height="32" /></picture></h2>

### Memory-Pipeline

```text
PostToolUse hook fires
  -> SHA-256 dedup (5min window)
  -> Privacy filter (strip secrets, API keys)
  -> Store raw observation
  -> LLM compress -> structured facts + concepts + narrative
  -> Vector embedding (6 providers + local)
  -> Index in BM25 + vector

Stop / SessionEnd hook fires
  -> Summarize session
  -> Knowledge graph extraction (if GRAPH_EXTRACTION_ENABLED=true)
  -> Slot reflection (if SLOT_REFLECT_ENABLED=true)

SessionStart hook fires
  -> Load project profile (top concepts, files, patterns)
  -> Hybrid search (BM25 + vector + graph)
  -> Token budget (default: 2000 tokens)
  -> Inject into conversation
```

### 4-stufige Memory-Konsolidierung

Inspiriert davon, wie menschliche Gehirne Erinnerungen verarbeiten — nicht unähnlich der Schlafkonsolidierung.

| Stufe | Was | Analogie |
|------|------|---------|
| **Working** | Rohbeobachtungen aus Tool-Nutzung | Kurzzeitgedächtnis |
| **Episodic** | Komprimierte Session-Zusammenfassungen | „Was passiert ist" |
| **Semantic** | Extrahierte Fakten und Muster | „Was ich weiß" |
| **Procedural** | Workflows und Entscheidungsmuster | „Wie es geht" |

Erinnerungen klingen mit der Zeit ab (Ebbinghaus-Kurve). Häufig abgerufene Erinnerungen werden verstärkt. Veraltete Erinnerungen werden automatisch evakuiert. Widersprüche werden erkannt und aufgelöst.

### Was erfasst wird

| Hook | Erfasst |
|------|----------|
| `SessionStart` | Projektpfad, Session-ID |
| `UserPromptSubmit` | Benutzer-Prompts (Privacy-gefiltert) |
| `PreToolUse` | Datei-Zugriffsmuster + angereicherter Kontext |
| `PostToolUse` | Tool-Name, Eingabe, Ausgabe |
| `PostToolUseFailure` | Fehlerkontext |
| `PreCompact` | Re-injiziert Memory vor der Kompaktierung |
| `SubagentStart/Stop` | Sub-Agent-Lifecycle |
| `Stop` | Zusammenfassung am Session-Ende |
| `SessionEnd` | Session-Abschluss-Marker |

### Kernfähigkeiten

| Fähigkeit | Beschreibung |
|---|---|
| **Automatische Erfassung** | Jede Tool-Nutzung via Hooks aufgezeichnet — null manueller Aufwand |
| **Semantische Suche** | BM25 + Vector + Knowledge Graph mit RRF-Fusion |
| **Memory-Evolution** | Versionierung, Supersession, Beziehungsgraphen |
| **Auto-Vergessen** | TTL-Ablauf, Widerspruchserkennung, Wichtigkeits-Eviction |
| **Privacy first** | API-Keys, Secrets, `<private>`-Tags vor Speicherung entfernt |
| **Selbstheilung** | Circuit Breaker, Provider-Fallback-Kette, Health-Monitoring |
| **Claude-Bridge** | Bidirektionale Synchronisierung mit MEMORY.md |
| **Knowledge Graph** | Entitäten-Extraktion + BFS-Traversal |
| **Team-Memory** | Namensraum-getrennt geteilt + privat über Teammitglieder hinweg |
| **Zitations-Provenienz** | Jedes Memory bis zu Ursprungsbeobachtungen zurückverfolgen |
| **Git-Snapshots** | Memory-Stand versionieren, zurückrollen und diffen |

---

<h2 id="search"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-search.svg"><img src="../assets/tags/section-search.svg" alt="Suche" height="32" /></picture></h2>

Triple-Stream-Retrieval, das drei Signale kombiniert:

| Stream | Was es tut | Wann |
|---|---|---|
| **BM25** | Gestemmter Keyword-Abgleich mit Synonymerweiterung | Immer aktiv |
| **Vector** | Cosinus-Ähnlichkeit über dichte Embeddings | Embedding-Provider konfiguriert |
| **Graph** | Knowledge-Graph-Traversal via Entitäten-Abgleich | Entitäten in der Anfrage erkannt |

Verschmolzen mit Reciprocal Rank Fusion (RRF, k=60) und session-diversifiziert (max. 3 Ergebnisse pro Session).

BM25 tokenisiert Griechisch, Kyrillisch, Hebräisch, Arabisch und akzentuiertes Latein standardmäßig. Für Erinnerungen in Chinesisch / Japanisch / Koreanisch installieren Sie die optionalen Segmentierer (`npm install @node-rs/jieba tiny-segmenter`), um CJK-Folgen in Worttokens aufzuteilen; ohne sie fällt agentmemory weich auf eine Tokenisierung als gesamte Folge zurück und gibt einmalig einen Hinweis auf stderr aus.

### Embedding-Provider

agentmemory erkennt Ihren Provider automatisch. Für die besten Ergebnisse installieren Sie lokale Embeddings (kostenlos):

```bash
npm install @xenova/transformers
```

| Provider | Modell | Kosten | Hinweise |
|---|---|---|---|
| **Lokal (empfohlen)** | `all-MiniLM-L6-v2` | Kostenlos | Offline, +8 pp Recall gegenüber BM25 allein |
| Gemini | `gemini-embedding-001` | Free Tier | 100+ Sprachen, 768/1536/3072 Dims (MRL), 2048-Token-Eingabe. Ersetzt `text-embedding-004` ([deprecated, Abschaltung 14. Jan. 2026](https://ai.google.dev/gemini-api/docs/deprecations)) |
| OpenAI | `text-embedding-3-small` | 0,02 $/1M | Höchste Qualität |
| Voyage AI | `voyage-code-3` | Kostenpflichtig | Auf Code optimiert |
| Cohere | `embed-english-v3.0` | Testzugang | Allzweck |
| OpenRouter | Beliebiges Modell | Variabel | Multi-Modell-Proxy |

---

<h2 id="mcp-server"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-mcp.svg"><img src="../assets/tags/section-mcp.svg" alt="MCP-Server" height="32" /></picture></h2>

74 Tools, 6 Resources, 3 Prompts und 15 Skills — das umfassendste MCP-Memory-Toolkit für jeden Agenten.

> **MCP-Shim vs. voller Server:** Das veröffentlichte `@agentmemory/mcp`-Paket ist ein dünnes Shim. Es legt die volle 74-Tool-Oberfläche **nur dann** offen, wenn es per `AGENTMEMORY_URL` einen laufenden agentmemory-Server erreichen kann (Proxy-Modus). Ohne erreichbaren Server fällt das Shim auf einen lokalen 19-Tool-Satz zurück (die ursprünglichen Tools `memory_save`, `memory_recall`, `memory_smart_search`, `memory_sessions`, `memory_export`, `memory_audit`, `memory_governance_delete` plus `memory_create`, `memory_inspect`, `memory_history`, `memory_update`, `memory_expire`, `memory_archive`, `memory_restore`, `memory_delete`, `memory_search_explain`, `memory_ledger`, `memory_review_queue`, `memory_rules_resolve`). Die Umgebungsvariable `AGENTMEMORY_TOOLS=core|all` ist ein *serverseitiger* Schalter — sie im `env`-Block des Shims zu setzen hat keinen Effekt. Wenn Sie in Cursor / OpenCode / Gemini CLI nur 19 Tools sehen, starten Sie `npx @agentmemory/agentmemory` (oder den Docker-Stack) und setzen Sie `AGENTMEMORY_URL=http://localhost:3111`.

### 74 Tools

<details>
<summary>Core-Tools (immer verfügbar)</summary>

| Tool | Beschreibung |
|------|-------------|
| `memory_recall` | Vergangene Beobachtungen durchsuchen |
| `memory_compress_file` | Markdown-Dateien unter Erhalt der Struktur komprimieren |
| `memory_save` | Erkenntnis, Entscheidung oder Muster speichern |
| `memory_patterns` | Wiederkehrende Muster erkennen |
| `memory_smart_search` | Hybride semantische + Keyword-Suche |
| `memory_file_history` | Vergangene Beobachtungen zu bestimmten Dateien |
| `memory_sessions` | Letzte Sessions auflisten |
| `memory_timeline` | Chronologische Beobachtungen |
| `memory_profile` | Projektprofil (Konzepte, Dateien, Muster) |
| `memory_export` | Alle Memory-Daten exportieren |
| `memory_relations` | Beziehungsgraph abfragen |

</details>

<details>
<summary>Erweiterte Tools (insgesamt 74 — AGENTMEMORY_TOOLS=all setzen)</summary>

| Tool | Beschreibung |
|------|-------------|
| `memory_patterns` | Wiederkehrende Muster erkennen |
| `memory_timeline` | Chronologische Beobachtungen |
| `memory_relations` | Beziehungsgraph abfragen |
| `memory_graph_query` | Knowledge-Graph-Traversal |
| `memory_consolidate` | 4-stufige Konsolidierung ausführen |
| `memory_claude_bridge_sync` | Mit MEMORY.md synchronisieren |
| `memory_team_share` | Mit Teammitgliedern teilen |
| `memory_team_feed` | Kürzlich geteilte Einträge |
| `memory_audit` | Audit-Trail der Operationen |
| `memory_governance_delete` | Mit Audit-Trail löschen |
| `memory_snapshot_create` | Git-versionierter Snapshot |
| `memory_action_create` | Arbeitspakete mit Abhängigkeiten anlegen |
| `memory_action_update` | Action-Status aktualisieren |
| `memory_frontier` | Entblockte Actions nach Priorität sortiert |
| `memory_next` | Einzelne wichtigste nächste Action |
| `memory_lease` | Exklusive Action-Leases (Multi-Agent) |
| `memory_routine_run` | Workflow-Routinen instanziieren |
| `memory_signal_send` | Inter-Agent-Messaging |
| `memory_signal_read` | Nachrichten mit Empfangsquittungen lesen |
| `memory_checkpoint` | Externe Bedingungs-Gates |
| `memory_mesh_sync` | P2P-Sync zwischen Instanzen |
| `memory_sentinel_create` | Ereignisgesteuerte Watcher |
| `memory_sentinel_trigger` | Sentinels extern auslösen |
| `memory_sketch_create` | Ephemere Action-Graphen |
| `memory_sketch_promote` | In permanent überführen |
| `memory_crystallize` | Action-Ketten kompaktieren |
| `memory_diagnose` | Health-Checks |
| `memory_heal` | Festsitzenden Zustand auto-fixen |
| `memory_facet_tag` | Dimension:Wert-Tags |
| `memory_facet_query` | Nach Facetten-Tags abfragen |
| `memory_verify` | Provenienz nachverfolgen |

</details>

### 6 Resources · 3 Prompts · 15 Skills

| Typ | Name | Beschreibung |
|------|------|-------------|
| Resource | `agentmemory://status` | Health, Session-Anzahl, Memory-Anzahl |
| Resource | `agentmemory://project/{name}/profile` | Projektspezifische Intelligenz |
| Resource | `agentmemory://memories/latest` | Die 10 neuesten aktiven Erinnerungen |
| Resource | `agentmemory://graph/stats` | Knowledge-Graph-Statistiken |
| Prompt | `recall_context` | Suche + Rückgabe von Kontext-Nachrichten |
| Prompt | `session_handoff` | Handoff-Daten zwischen Agenten |
| Prompt | `detect_patterns` | Wiederkehrende Muster analysieren |
| Skill | `/recall` | Memory durchsuchen |
| Skill | `/remember` | Im Langzeit-Memory speichern |
| Skill | `/session-history` | Zusammenfassungen letzter Sessions |
| Skill | `/forget` | Beobachtungen / Sessions löschen |

### Standalone MCP

Ohne den vollen Server laufen lassen — für jeden MCP-Client. Eines der folgenden geht:

```bash
npx -y @agentmemory/agentmemory mcp   # canonical (always available)
npx -y @agentmemory/mcp                # shim package alias
```

Oder zur MCP-Konfig Ihres Agenten hinzufügen:

Die meisten Agenten (Cursor, Claude Desktop, Cline, Roo Code, Windsurf, Gemini CLI):
```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "npx",
      "args": ["-y", "@agentmemory/mcp"],
      "env": {
        "AGENTMEMORY_URL": "http://localhost:3111"
      }
    }
  }
}
```

Fügen Sie den `agentmemory`-Eintrag in das vorhandene `mcpServers`-Objekt Ihres Hosts ein, statt die Datei zu ersetzen. Für Sandbox-Clients, die den `localhost` des Hosts nicht erreichen können, fügen Sie `"AGENTMEMORY_FORCE_PROXY": "1"` zum env-Block hinzu und lassen `AGENTMEMORY_URL` auf eine Route zeigen, die die Sandbox erreicht.

OpenCode (`opencode.json`):
```json
{
  "mcp": {
    "agentmemory": {
      "type": "local",
      "command": ["npx", "-y", "@agentmemory/mcp"],
      "enabled": true
    }
  },
  "plugin": ["./plugins/agentmemory-capture.ts"]
}
```

Plugin-Datei aus dem Repo kopieren:
```bash
mkdir -p ~/.config/opencode/plugins
cp plugin/opencode/agentmemory-capture.ts ~/.config/opencode/plugins/
cp plugin/opencode/commands/*.md ~/.config/opencode/commands/
```

---

<h2 id="real-time-viewer"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-viewer.svg"><img src="../assets/tags/section-viewer.svg" alt="Echtzeit-Viewer" height="32" /></picture></h2>

Startet automatisch auf Port `3113`. Live-Beobachtungs-Stream, Session-Explorer, Memory-Browser, Knowledge-Graph-Visualisierung und Health-Dashboard.

```bash
open http://localhost:3113
```

Der Viewer-Server bindet sich standardmäßig an `127.0.0.1`. Der per REST ausgelieferte `/agentmemory/viewer`-Endpunkt folgt den üblichen `AGENTMEMORY_SECRET`-Bearer-Token-Regeln. CSP-Header verwenden eine Skript-Nonce pro Response und deaktivieren Inline-Handler-Attribute (`script-src-attr 'none'`).

---

<h2 id="iii-console"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-viewer.svg"><img src="../assets/tags/section-viewer.svg" alt="iii Console" height="32" /></picture></h2>

Der Viewer auf `:3113` zeigt, was Ihr Agent **gespeichert hat**. Die [iii console](https://iii.dev/docs/console) zeigt, was Ihr Agent **getan hat** — jede Memory-Operation als OpenTelemetry-Trace, jeden KV-Eintrag editierbar, jede Funktion aufrufbar, jeden Stream abgreifbar. Zwei Fenster auf dasselbe Memory: eines produktnah, eines engine-nah.

Sehen Sie, wie ein `memory_smart_search` feuert, und beobachten Sie BM25-Scan → Embedding-Lookup → RRF-Fusion → Reranker als Wasserfall. Editieren Sie einen festsitzenden Konsolidierungs-Timer im KV-Browser. Spielen Sie einen `PostToolUse`-Hook mit angepasster Payload erneut ab. Pinnen Sie den WebSocket-Stream an und sehen Sie Beobachtungen live eintrudeln.

agentmemory liefert das umsonst, weil jede Funktion, jeder Trigger, jeder State-Scope und jeder Stream eine iii-Primitive ist — nichts Eigenes, nichts zu instrumentieren.

<p align="center">
  <img src="../assets/iii-console/workers.png" alt="iii console Workers-Seite — verbundene Worker, einschließlich agentmemory-Instanzen mit Live-Funktionszahlen und Runtime-Metadaten" width="720" />
  <br/>
  <em>Workers-Seite: jeder verbundene Worker — einschließlich agentmemory selbst — mit PID, Funktionsanzahl, Runtime und last-seen.</em>
</p>

**Bereits installiert.** Die Console wird mit `iii` ausgeliefert — kein separater Installer.

**Neben agentmemory starten:**

```bash
# agentmemory viewer holds port 3113, so run the console on 3114.
# Engine REST (3111), WebSocket (3112), and bridge (49134) defaults match agentmemory.
iii console --port 3114
```

Dann `http://localhost:3114` öffnen. `--enable-flow` ergänzen für die experimentelle Architektur-Graph-Seite.

Engine-Endpunkte nur überschreiben, wenn Sie sie verschoben haben:

```bash
iii console --port 3114 \
  --engine-port 3111 \
  --ws-port 3112 \
  --bridge-port 49134
```

**Was Sie aus der Console heraus tun können:**

| Seite | Verwenden Sie sie für |
|------|-----------|
| **Workers** | Jeden verbundenen Worker und seine Live-Metriken sehen — einschließlich des agentmemory-Workers selbst. |
| **Functions** | Jede Funktion von agentmemory direkt mit einer JSON-Payload aufrufen — handlich zum Testen von `memory.recall`, `memory.consolidate`, `graph.query` ohne Client zu verdrahten. |
| **Triggers** | HTTP-, Cron-, Event- und State-Trigger erneut abspielen — den Konsolidierungs-Cron manuell auslösen, eine HTTP-Route wiederholen, einen State-Change emittieren. |
| **States** | KV-Browser mit vollem CRUD — Sessions, Memory-Slots, Lifecycle-Timer, Embedding-Index — Werte direkt bearbeiten. |
| **Streams** | Live-WebSocket-Monitor für Memory-Schreibvorgänge, Hook-Events und Beobachtungsupdates, wie sie durch iii-Streams fließen. |
| **Queues** | Durable Queue-Topics + Dead-Letter-Verwaltung. Fehlgeschlagene Embedding-/Kompressions-Jobs wiederholen oder verwerfen. |
| **Traces** | OpenTelemetry-Wasserfall- / Flame- / Service-Breakdown-Ansichten. Nach `trace_id` filtern, um exakt zu sehen, welche Funktionen, DB-Calls und Embedding-Anfragen eine einzelne `memory.search` ausgelöst hat. |
| **Logs** | Strukturierte OTEL-Logs, gefiltert und korreliert mit Trace-/Span-IDs. |
| **Config** | Runtime-Konfiguration — sehen Sie genau, mit welchen Workern, Providern und Ports Ihre Engine läuft. |
| **Flow** | (Optional, `--enable-flow`) Interaktiver Architekturgraph jedes Workers, Triggers und Streams. |

<p align="center">
  <img src="../assets/iii-console/traces-waterfall.png" alt="iii console Trace-Wasserfall-Ansicht mit Span-Dauer" width="720" />
  <br/>
  <em>Traces: Wasserfall / Flame / Service-Breakdown für jede Memory-Operation.</em>
</p>

**Traces sind bereits aktiv:**

`iii-config.yaml` wird mit aktiviertem `iii-observability`-Worker ausgeliefert (`exporter: memory`, `sampling_ratio: 1.0`, Metriken + Logs). Keine zusätzliche Konfig nötig — in dem Moment, in dem agentmemory startet, emittiert jede Memory-Operation einen Trace-Span und ein strukturiertes Log, das die Console lesen kann.

Wenn Sie stattdessen zu Jaeger/Honeycomb/Grafana Tempo exportieren wollen, ändern Sie `exporter: memory` zu `exporter: otlp` und setzen den Collector-Endpunkt gemäß der iii-Observability-Doku.

> **Achtung:** Auf der Console selbst wird keine Auth erzwungen — lassen Sie sie an `127.0.0.1` gebunden (Standard) und stellen Sie sie niemals öffentlich bereit.

---

<h2 id="powered-by-iii"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-architecture.svg"><img src="../assets/tags/section-architecture.svg" alt="Powered by iii" height="32" /></picture></h2>

agentmemory ist **bereits eine laufende [iii](https://iii.dev)-Instanz**. Funktionen, Trigger, KV-State, Streams, OTEL-Traces — alles sind iii-Primitiven. Sie haben weder Postgres noch Redis, Express, pm2 oder Prometheus installiert, weil iii sie ersetzt.

Das bedeutet, ein weiterer Befehl erweitert agentmemory um eine komplett neue Fähigkeit.

### agentmemory mit einem Befehl erweitern

```bash
iii worker add iii-pubsub          # fan memory writes out to every connected instance
iii worker add iii-cron            # scheduled consolidation, decay sweeps, snapshot rotation
iii worker add iii-queue           # durable retries for embedding + compression jobs
iii worker add iii-observability   # OTEL traces on every memory op (default on)
iii worker add iii-sandbox         # run recalled code inside an isolated microVM
iii worker add iii-database        # swap in a SQL-backed state adapter
iii worker add mcp                 # generic MCP host alongside the agentmemory MCP
```

Jedes `iii worker add` registriert neue Funktionen und Trigger im selben Engine, auf dem agentmemory bereits läuft. Viewer und Console übernehmen sie sofort — kein Reload, keine neue Integration, kein neuer Container.

| `iii worker add` | Was Sie zusätzlich zu agentmemory erhalten |
|---|---|
| [`iii-pubsub`](https://workers.iii.dev/workers/iii-pubsub) | Multi-Instanz-Memory: jedes `remember` fächert auf, jedes `search` liest die Vereinigung |
| [`iii-cron`](https://workers.iii.dev/workers/iii-cron) | Geplanter Lifecycle — nächtliche Konsolidierung, wöchentliche Snapshots, Decay nach fester Uhr |
| [`iii-queue`](https://workers.iii.dev/workers/iii-queue) | Durable Retries: fehlgeschlagene Embedding-/Kompressions-Jobs überleben den Neustart, keine verlorenen Beobachtungen |
| [`iii-observability`](https://workers.iii.dev/workers/iii-observability) | OTEL-Traces, Metriken, Logs auf jeder Funktion — in `iii-config.yaml` ab dem ersten Tag verdrahtet |
| [`iii-sandbox`](https://workers.iii.dev/workers/iii-sandbox) | Code, der aus `memory_recall` kommt, läuft in einer wegwerf-VM, nicht in Ihrer Shell |
| [`iii-database`](https://workers.iii.dev/workers/iii-database) | SQL-gestützter State-Adapter, wenn Sie die In-Memory-KV-Voreinstellungen überwachsen |
| [`mcp`](https://workers.iii.dev/workers/mcp) | Zusätzliche MCP-Server neben dem von agentmemory aufstellen, die sich denselben Engine teilen |

Volle Registry: [workers.iii.dev](https://workers.iii.dev). Jeder Worker dort komponiert sich über dieselben Primitiven wie agentmemory — und das agentmemory, das Sie bereits haben, ist einer davon.

### Was iii ersetzt

| Traditioneller Stack | agentmemory verwendet |
|---|---|
| Express.js / Fastify | iii HTTP Triggers |
| SQLite / Postgres + pgvector | iii KV State + In-Memory-Vector-Index |
| SSE / Socket.io | iii Streams (WebSocket) |
| pm2 / systemd | iii-Engine-Worker-Supervision |
| Prometheus / Grafana | iii OTEL + Health-Monitor |
| Eigene Plugin-Systeme | `iii worker add <name>` |

**118 Quelldateien · ~21.800 LOC · 950+ Tests · 123 Funktionen · 34 KV-Scopes** — alles auf drei Primitiven. Kein `agentmemory plugin install`. Das Plugin-System ist iii selbst.

---

<h2 id="configuration"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-config.svg"><img src="../assets/tags/section-config.svg" alt="Konfiguration" height="32" /></picture></h2>

### LLM-Provider

agentmemory erkennt aus Ihrer Umgebung automatisch. Standardmäßig werden keine LLM-Aufrufe ausgeführt, solange Sie nicht einen Provider konfigurieren oder dem Claude-Abonnement-Fallback ausdrücklich zustimmen.

| Provider | Konfig | Hinweise |
|----------|--------|-------|
| **No-op (Standard)** | Keine Konfig nötig | LLM-gestütztes Compress/Summarize ist DEAKTIVIERT. Synthetische BM25-Kompression + Recall funktionieren weiter. Siehe `AGENTMEMORY_ALLOW_AGENT_SDK` unten, falls Sie früher auf den Claude-Abonnement-Fallback gesetzt haben. |
| Anthropic API | `ANTHROPIC_API_KEY` | Abrechnung pro Token |
| MiniMax | `MINIMAX_API_KEY` | Anthropic-kompatibel |
| Gemini | `GEMINI_API_KEY` | Aktiviert zusätzlich Embeddings |
| OpenRouter | `OPENROUTER_API_KEY` | Beliebiges Modell |
| Claude-Abonnement-Fallback | `AGENTMEMORY_ALLOW_AGENT_SDK=true` | Nur als Opt-in. Startet `@anthropic-ai/claude-agent-sdk`-Sessions — verursachte früher unbegrenzte Stop-Hook-Rekursion, daher nicht mehr Standard. |

### Kostenbewusste Modellwahl

Hintergrund-Kompression läuft bei jeder Beobachtung, daher beeinflusst die Modellwahl die monatlichen Kosten spürbar. Erfasste Lastdaten: 635 Requests / 888K Tokens / 35 Stunden aktive Nutzung, gegen drei OpenRouter-Modelle zu den Preisen vom 2026-05-23.

| Stufe | Modell | Eingabe / 1M | Ausgabe / 1M | Kosten für die erfassten 35 h | Hinweise |
|------|-------|------------|-------------|---------------------------|-------|
| Empfohlen | `deepseek/deepseek-v4-pro` | 0,435 $ | 0,87 $ | ~0,46 $ | Solide Kompressions-/Summarize-Qualität zu ~10× geringeren Kosten als Sonnet. |
| Empfohlen | `deepseek/deepseek-chat` | 0,27 $ | 1,10 $ | ~0,40 $ | Älter, aber für reine Kompressions-Workloads weiterhin in Ordnung. |
| Empfohlen | `qwen/qwen3-coder` | 0,45 $ | 1,80 $ | ~0,55 $ | Starkes Code-Reasoning, wenn Ihre Sessions stark codelastig sind. |
| Premium | `anthropic/claude-sonnet-4.6` | 3,00 $ | 15,00 $ | ~5,02 $ | Hohe Qualität, aber teuer für dauerhafte Hintergrundarbeit. |
| Premium | `openai/gpt-4o` | 2,50 $ | 10,00 $ | ~4,20 $ | Ähnliche Stufe wie Sonnet. |
| Vermeiden | `anthropic/claude-opus-4.6` | 15,00 $ | 75,00 $ | ~25+ $ | Reasoning-Klasse-Modell; massive Überausgabe für Kompression. |

agentmemory gibt eine Runtime-Warnung aus, wenn `OPENROUTER_MODEL` auf ein Premium-Tier-Muster passt. Setzen Sie `AGENTMEMORY_SUPPRESS_COST_WARNING=1`, um sie zum Schweigen zu bringen, sobald Sie eine bewusste Wahl getroffen haben.

Qualitäts-Kosten-Abwägung für Memory-Arbeit: Kompression ist eine Summarize-Aufgabe mit eher lockerer Qualitätsanforderung (der Agent liest die Zusammenfassung erneut, nicht der Benutzer). DeepSeek-V4-Pro / Qwen3-Coder landen bei dieser Aufgabe innerhalb von Rundungsfehlern an Sonnet, bei ~10× weniger Kosten. Heben Sie Premium-Modelle für Anfragen auf, die Sie direkt lesen.

Quellen: [OpenRouter-Preise für Sonnet 4.6](https://openrouter.ai/anthropic/claude-sonnet-4.6/pricing), [DeepSeek V4 Pro](https://openrouter.ai/deepseek/deepseek-v4-pro), [DeepSeek-Preis-Hinweise](https://api-docs.deepseek.com/quick_start/pricing/).

### Multi-Agent-Memory (`AGENT_ID` + `AGENTMEMORY_AGENT_SCOPE`)

In Multi-Agent-Setups, in denen sich mehrere Rollen einen agentmemory-Server teilen (architect / developer / reviewer / researcher / support-agent), markiert `AGENT_ID` jede Schreibaktion mit der Rolle, die sie ausgelöst hat. `AGENTMEMORY_AGENT_SCOPE` steuert, ob der Recall nach diesem Tag filtert.

```env
TEAM_ID=company
USER_ID=engineering-team
AGENT_ID=architect
AGENTMEMORY_AGENT_SCOPE=isolated  # optional; default "shared"
```

Zwei Modi:

| Modus | Schreibvorgänge markieren | Recall filtern | Wann verwenden |
|------|------------|---------------|-------------|
| `shared` (Standard) | ja | nein | Agentenübergreifender Kontext mit Audit-Trail. Architect sieht, was Developer notiert hat, aber jede Zeile vermerkt, wer es gesagt hat. |
| `isolated` | ja | ja | Strikte Trennung. Architect sieht niemals Beobachtungen / Erinnerungen / Sessions von Developer. |

Was getaggt wird, wenn `AGENT_ID` gesetzt ist: `Session.agentId`, `RawObservation.agentId`, `CompressedObservation.agentId`, `Memory.agentId`. Die Rolle fließt von `api::session::start` → `mem::observe` → `mem::compress` → KV.

Was im Isolated-Modus gefiltert wird: `mem::smart-search`, `/agentmemory/memories`, `/agentmemory/observations`, `/agentmemory/sessions`. Jeder Endpunkt akzeptiert `?agentId=<role>` als Per-Request-Override und `?agentId=*`, um sich komplett aus dem env-Scope auszuklinken. `/memories` akzeptiert zudem `?includeOrphans=true`, um Pre-AGENT_ID-Erinnerungen, deren `agentId` undefiniert ist, sichtbar zu machen.

Per-Call-Override auf SDK-/REST-Ebene: jeder mutierende Endpunkt (`/session/start`, `/remember`) akzeptiert ein `agentId`-Feld im Request-Body, das die env-Variable überschreibt. Nützlich für Runtimes, die viele Rollen durch einen einzelnen Serverprozess routen.

Wenn `AGENT_ID` nicht gesetzt ist, bleibt Memory unscoped (Legacy-Verhalten, keine Tags, keine Filter).

### Ports

agentmemory + iii-engine binden standardmäßig vier Ports. Wenn ein Neustart mit `port in use` fehlschlägt, sagt Ihnen diese Tabelle, nach welchem Prozess Sie suchen müssen.

| Port | Prozess | Zweck | Env-Override |
|------|---------|---------|--------------|
| `3111` | agentmemory | REST API + MCP HTTP + `/agentmemory/health` + `/agentmemory/livez` | `III_REST_PORT` |
| `3112` | iii-engine | Interner Streams-Worker (von agentmemory + Viewer verwendet) | `III_STREAMS_PORT` |
| `3113` | agentmemory | Echtzeit-Viewer (`http://localhost:3113`) | `AGENTMEMORY_VIEWER_PORT` |
| `49134` | iii-engine | WebSocket — Worker registrieren sich hier, OTel-Telemetrie fließt darüber | `III_ENGINE_URL` (volle URL, Standard `ws://localhost:49134`) |

Aufräumen veralteter Prozesse, wenn Ports nach einem abgestürzten Lauf gebunden bleiben:

```bash
# macOS / Linux — find whatever is on each port and kill it
lsof -i :3111,3112,3113,49134
pkill -f agentmemory || true
pkill -f 'iii ' || true

# Windows
netstat -ano | findstr ":3111 :3112 :3113 :49134"
taskkill /F /PID <pid>
```

`agentmemory stop` räumt sowohl den Worker als auch das Engine-Pidfile bei einem geordneten Shutdown sauber auf. Das manuelle Cleanup oben ist nur für den Post-Crash-Fall nötig, in dem kein Pidfile zurückbleibt.

### Konfigurationsdatei

Legen Sie die agentmemory-Runtime-Konfiguration in `~/.agentmemory/.env` ab, statt Variablen in jeder Shell zu exportieren. Wenn der Viewer einen Setup-Hinweis wie `export ANTHROPIC_API_KEY=...` zeigt, kopieren Sie ihn als `ANTHROPIC_API_KEY=...` ohne `export`-Präfix in diese Datei und starten Sie agentmemory neu.

Prozess-Umgebungsvariablen funktionieren weiterhin und haben Vorrang vor Werten in der Datei.

Unter Windows liegt dieselbe Datei unter `%USERPROFILE%\.agentmemory\.env`:

```powershell
New-Item -ItemType Directory -Force $HOME\.agentmemory
notepad $HOME\.agentmemory\.env
```

Um mit einem Claude Code Pro/Max-Abonnement statt eines API-Schlüssels zu testen, stimmen Sie explizit zu:

```env
AGENTMEMORY_ALLOW_AGENT_SDK=true
AGENTMEMORY_AUTO_COMPRESS=true
```

Aktivieren Sie Graph- oder Konsolidierungs-Features in derselben Datei, falls gewünscht:

```env
GRAPH_EXTRACTION_ENABLED=true
CONSOLIDATION_ENABLED=true
```

### Umgebungsvariablen

`~/.agentmemory/.env` anlegen:

```env
# LLM provider (pick one — default is the no-op provider: no LLM calls)
# ANTHROPIC_API_KEY=sk-ant-...
# ANTHROPIC_BASE_URL=...              # Optional: Anthropic-compatible proxy / Azure
# GEMINI_API_KEY=...
# OPENROUTER_API_KEY=...
# MINIMAX_API_KEY=...
# OPENAI_API_KEY=***                       # NOTE: this same key auto-activates BOTH the
#                                          # OpenAI LLM provider (here) AND the OpenAI
#                                          # embedding provider (further below). Set
#                                          # OPENAI_API_KEY_FOR_LLM=false to scope it
#                                          # to embeddings only.
# OPENAI_BASE_URL=https://api.openai.com   # Optional: override for Azure / vLLM / LM Studio / proxies
#                                          # Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
#                                          # Auto-detected from `.openai.azure.com` hostname; uses
#                                          # api-key header + api-version query param.
# OPENAI_API_VERSION=2024-08-01-preview    # Optional: Azure api-version query param
# OPENAI_MODEL=gpt-4o-mini                 # Optional: default model
# OPENAI_TIMEOUT_MS=60000                  # Optional: OpenAI-scoped alias for the outbound fetch
#                                          # timeout. Takes precedence over AGENTMEMORY_LLM_TIMEOUT_MS
#                                          # for back-compat with v0.9.17. New configs should
#                                          # prefer the global AGENTMEMORY_LLM_TIMEOUT_MS below.
# OPENAI_REASONING_EFFORT=none             # Optional: "low" | "medium" | "high" | "none"
#                                          # Honored only by OpenAI's reasoning models (o1, o3,
#                                          # gpt-*-reasoning) and providers that mirror that
#                                          # schema (Ollama Cloud thinking models). Standard
#                                          # chat models reject this field with 400. Set to
#                                          # "none" for thinking models that return reasoning
#                                          # but no content.
# OPENAI_API_KEY_FOR_LLM=false             # Optional: set to false to skip OpenAI auto-detection
#                                          # for LLM (useful if you only want OpenAI for embeddings)
# Opt-in Claude-subscription fallback (spawns @anthropic-ai/claude-agent-sdk);
# leave OFF unless you understand the Stop-hook recursion risk:
# AGENTMEMORY_ALLOW_AGENT_SDK=true

# Embedding provider (auto-detected, or override)
# EMBEDDING_PROVIDER=local
# VOYAGE_API_KEY=...
# OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL=https://api.openai.com   # Override for Azure / vLLM / LM Studio / proxies
# OPENAI_EMBEDDING_MODEL=text-embedding-3-small
# OPENAI_EMBEDDING_DIMENSIONS=1536        # Required when the model is not in the known-models table

# Outbound LLM / embedding timeout
# AGENTMEMORY_LLM_TIMEOUT_MS=60000       # Default: 60 000 ms (60 s). Applies to every
                                          # raw-fetch provider (Gemini, OpenRouter, MiniMax,
                                          # OpenAI LLM, OpenAI/Cohere/Voyage/OpenRouter
                                          # embedding). For the OpenAI LLM path, the
                                          # OpenAI-scoped OPENAI_TIMEOUT_MS alias (above)
                                          # takes precedence when set, for back-compat
                                          # with v0.9.17.
                                          # Increase for slow networks or large batch calls;
                                          # decrease to fail-fast on rate-limit holds.

# Search tuning
# BM25_WEIGHT=0.4
# VECTOR_WEIGHT=0.6
# TOKEN_BUDGET=2000

# Auth
# AGENTMEMORY_SECRET=your-secret

# Ports (defaults: 3111 API, 3113 viewer)
# III_REST_PORT=3111

# Features
# AGENTMEMORY_AUTO_COMPRESS=false  # OFF by default. When on,
                                   # every PostToolUse hook calls your
                                   # LLM provider to compress the
                                   # observation — expect significant
                                   # token spend on active sessions.
# AGENTMEMORY_SLOTS=false          # OFF by default. Editable pinned
                                   # memory slots — persona,
                                   # user_preferences, tool_guidelines,
                                   # project_context, guidance,
                                   # pending_items, session_patterns,
                                   # self_notes. Size-limited; agent
                                   # edits via memory_slot_* tools.
                                   # Pinned slots addressable for
                                   # SessionStart injection.
# AGENTMEMORY_REFLECT=false        # OFF by default. Requires SLOTS=on.
                                   # Stop hook fires mem::slot-reflect:
                                   # scans recent observations, auto-
                                   # appends TODOs to pending_items,
                                   # counts patterns in
                                   # session_patterns, records touched
                                   # files in project_context. Fire-
                                   # and-forget; does not block.
# AGENTMEMORY_INJECT_CONTEXT=false # OFF by default. When on:
                                   # - SessionStart may inject ~1-2K
                                   #   chars of project context into
                                   #   the first turn of each session
                                   #   (this is what actually reaches
                                   #   the model — Claude Code treats
                                   #   SessionStart stdout as context)
                                   # - PreToolUse fires /agentmemory/enrich
                                   #   on every file-touching tool call
                                   #   (resource cleanup, not a token
                                   #   fix — PreToolUse stdout is debug
                                   #   log only per Claude Code docs)
                                   # Observations are still captured via
                                   # PostToolUse regardless of this flag.
# GRAPH_EXTRACTION_ENABLED=false
# CONSOLIDATION_ENABLED=true
# LESSON_DECAY_ENABLED=true
# OBSIDIAN_AUTO_EXPORT=false
# AGENTMEMORY_EXPORT_ROOT=~/.agentmemory
# CLAUDE_MEMORY_BRIDGE=false
# SNAPSHOT_ENABLED=false

# Team
# TEAM_ID=
# USER_ID=
# TEAM_MODE=private

# Tool visibility: "core" (8 tools) or "all" (74 tools)
# AGENTMEMORY_TOOLS=core
```

---

<h2 id="api"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-api.svg"><img src="../assets/tags/section-api.svg" alt="API" height="32" /></picture></h2>

167 Endpunkte auf Port `3111`. Die REST API bindet sich standardmäßig an `127.0.0.1`. Geschützte Endpunkte verlangen `Authorization: Bearer <secret>`, wenn `AGENTMEMORY_SECRET` gesetzt ist, und Mesh-Sync-Endpunkte erfordern `AGENTMEMORY_SECRET` auf beiden Peers.

<details>
<summary>Wichtige Endpunkte</summary>

| Methode | Pfad | Beschreibung |
|--------|------|-------------|
| `GET` | `/agentmemory/health` | Health-Check (immer öffentlich) |
| `POST` | `/agentmemory/session/start` | Session starten + Kontext holen |
| `POST` | `/agentmemory/session/end` | Session beenden |
| `POST` | `/agentmemory/observe` | Beobachtung erfassen |
| `POST` | `/agentmemory/smart-search` | Hybride Suche |
| `POST` | `/agentmemory/context` | Kontext erzeugen |
| `POST` | `/agentmemory/remember` | In Langzeit-Memory speichern |
| `POST` | `/agentmemory/forget` | Beobachtungen löschen |
| `POST` | `/agentmemory/enrich` | Dateikontext + Erinnerungen + Bugs |
| `GET` | `/agentmemory/profile` | Projektprofil |
| `GET` | `/agentmemory/export` | Alle Daten exportieren |
| `POST` | `/agentmemory/import` | Aus JSON importieren |
| `POST` | `/agentmemory/graph/query` | Knowledge-Graph-Anfrage |
| `POST` | `/agentmemory/team/share` | Mit Team teilen |
| `GET` | `/agentmemory/audit` | Audit-Trail |

Volle Endpunktliste: [`src/triggers/api.ts`](../src/triggers/api.ts)

</details>

---

<h2 id="development"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-development.svg"><img src="../assets/tags/section-development.svg" alt="Entwicklung" height="32" /></picture></h2>

```bash
npm run dev               # Hot reload
npm run build             # Production build
npm test                  # 950+ tests
npm run test:integration  # API tests (requires running services)
```

**Voraussetzungen:** Node.js >= 20, [iii-engine](https://iii.dev/docs) oder Docker

<h2 id="license"><picture><source media="(prefers-color-scheme: dark)" srcset="../assets/tags/light/section-license.svg"><img src="../assets/tags/section-license.svg" alt="Lizenz" height="32" /></picture></h2>

[Apache-2.0](../LICENSE)
