---
description: Naprogramuje/opraví plugin (Zdena-DEV), nechá změřit bránou (manifest vs. schéma, docker build, MCP smoke), nekompromisně zreviewuje (Zdena-CR) a až po APPROVE otestuje ukázkovou úlohou přes MCP pluginu (Zdena-QA) v deterministické smyčce přes Workflow engine, dokud CR i QA nejsou spokojení (max 20 kol).
argument-hint: <popis úkolu / odkaz na task>
---

## Tvůj úkol

Vyřeš zadání spuštěním **Workflow** `resolve` (`.claude/workflows/resolve.js`).
Ten deterministicky odjede orchestraci: levná **triáž** (potřebuje to architekta?) →
u těžkého tasku **Zdena-ARCH** naplánuje → smyčka
**Zdena-DEV** (napíše/opraví kód) → **GATE** (`.claude/scripts/plugin-gate.mjs`:
git diff, manifest proti schématu WorkMux, docker build změněných pluginů, MCP smoke
`initialize` + `tools/list`) → **Zdena-CR** (nekompromisní review) → až po **CR: APPROVE**
se pustí **Zdena-QA** (ukázková úloha přes MCP pluginu: vstup do `/work`, tooly,
kontrola výstupního souboru), dokud není **CR: APPROVE i QA: PASS** (max 20 kol).
Brány jedou levné → drahé sekvenčně. Rozhodování o verdiktech, feedback loop i pořadí
bran řeší skript — ty ho jen spustíš se správným zadáním a nakonec česky shrneš výsledek.

Sám kód **needituješ, netestuješ ani nereviewuješ** — to dělají agenti uvnitř
workflow. S uživatelem mluv česky, stručně.

**Jsi worker WorkMuxu v auto módu** (task je navázaný na tenhle chat, máš
`mcp__workmux__get_task` / `task_done` / `needs_attention`)? Pak jeď podle
**`.claude/commands/resolve-tasks.md`** — zadání skládáš z tasku a jeho komentářů,
uživatele se **nikdy neptáš** a výsledek mapuješ na commit/push a `task_done` /
`needs_attention` / `task_wait` podle tamní tabulky.

Zadání: $ARGUMENTS

### Setup

1. Když je `$ARGUMENTS` prázdné a z konverzace ani z navázaného tasku není jasné, co se má vyřešit — zeptej se (worker: `needs_attention`).
2. Zjisti výchozí stav pro pozdější diff (a jako `base` pro CR ve workflow):
   - Branch: !`git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "no-git"`
   - Stav: !`git status --short 2>/dev/null`
   - Provider: !`case "${ANTHROPIC_BASE_URL:-}" in *workmux-*-proxy*) echo proxy;; *) echo claude;; esac`
3. Závislosti brány: !`test -d .claude/scripts/node_modules && echo ok || (npm ci --prefix .claude/scripts --no-audit --no-fund >/dev/null 2>&1 && echo installed || echo "npm ci selhal")`
4. Pokud jsi na `master` a hrozí commit, **nepouštěj commit bez dotazu** —
   interaktivní `/resolve` jen připraví rozpracovaný working tree, commit nechává na
   uživateli (worker commituje na svou task větev podle pokynů tasku).

### Spuštění workflow

Zavolej **Workflow** tool:

```
Workflow({
  scriptPath: ".claude/workflows/resolve.js",
  args: { task: "<celé zadání jako text>", base: "<volitelně diff base, např. origin/master>", provider: "<proxy|claude ze Setupu>" }
})
```

- `args.task` = kompletní zadání (popis + akceptace „Hotovo, když" + relevantní kontext z konverzace / komentářů tasku).
- `args.base` je volitelný; nech prázdné, když CR má reviewovat `git diff` proti aktuálnímu indexu. Když na větvi už jsou commity tasku, dej `origin/master`.
- `args.provider` = hodnota řádku „Provider" ze Setupu. `claude` = ARCH na hlavním modelu, `proxy` = ARCH na prostředním patře. GATE jede vždy na nejlevnějším patře (`haiku`), triáž je deterministická.
- Workflow běží na pozadí; až doběhne, dostaneš jeho návratový objekt jako výsledek tasku.

### Watchdog

Běh umí skončit v terminálním stavu bez verdiktu (`killed`, `result: null`) a
notifikace o dokončení se k tobě nemusí dostat — pak bys jen stál. Proto **hned po
launchi**:

1. zapiš stav do `.claude/state/resolve-run.json` (`runId` je v synchronní odpovědi
   `Workflow`; tvar má `/resolve-watchdog`, sekce „Stavový soubor"; worker do `taskId`
   dá id WorkMux tasku, interaktivní běh ho vynechá),
2. založ budík `CronCreate({ cron: "8,23,38,53 * * * *", recurring: true, prompt: "/resolve-watchdog" })`
   a ID jobu si pamatuj (nejdřív `CronList`, ať nevisí druhý),
3. po výsledku (nebo na „zastav") stav smaž (`rm -f .claude/state/resolve-run.json`)
   a budík zruš (`CronDelete`).

### Návratový objekt workflow

```
{ done, converged, rounds, exhausted, needsClarification, questions, needsManualQa,
  envDead, envDeadReason, qaSkipped, budgetStopped, scopeCreep, qa, qaFailKind, cr,
  changedFiles, plan, lastQaReport, lastQaScenario, lastCrComments, followUps }
```

- `done: true` → smyčka zkonvergovala (`qa: "PASS"`, `cr: "APPROVE"`).
- **`qaSkipped: true`** (chodí spolu s `done: true` a `qa: "SKIPPED"`) → CR dal APPROVE
  a QA se **vědomě nepouštěla**, protože se kolo dotklo jen souborů bez povrchu
  v běžícím pluginu (`*.md`, `docs/`, `.claude/`). GATE přitom zvalidoval manifesty
  a README tabulku. V shrnutí to zmiň jednou větou.
- **`needsManualQa: true`** → kód prošel **CR: APPROVE**, ale QA ho živě nepotvrdila:
  3× FAIL, prostředí session nešlo rozjet, nebo `qaFailKind: "credentials"` (úloha
  potřebuje secret/OAuth, který session nemá). Potřebuje **ruční otestování** — přilož
  `lastQaReport` (co QA zkoušela, co má člověk ověřit) + `changedFiles`.
- **`envDead: true`** (vždy s `needsManualQa`) → QA prošla recovery postup a prostředí
  session pořád nežije. Řekni, že potřebuje zásah člověka (+ `envDeadReason`).
- **`needsClarification: true`** → Zdena-ARCH narazil na zásadní nejasnost v zadání a
  smyčka se **záměrně nespustila**. Rozsah navázaného tasku (blocks / blocked by) mezi
  otázky nepatří. Interaktivně polož otázky z `questions` přes **AskUserQuestion** a po
  odpovědi **spusť Workflow znovu** s doplněným zadáním.
- `exhausted: true` → vyčerpáno 20 kol bez konvergence → vypiš zbývající blokery
  (`lastQaReport` + `lastCrComments`) k ručnímu rozhodnutí.
- **`scopeCreep: true`** → CR třikrát po sobě ukázal na úplně jinou sadu souborů —
  task potřebuje ohraničit („hotovo = kdy?"), přilož `lastCrComments`.
- **`budgetStopped: true`** → došel token rozpočet zadaný uživatelem („+500k"); napiš,
  kde to stojí (`cr` / `qa` / `lastCrComments`).
- `done: false` bez ostatních příznaků → smyčka se přerušila (DEV opakovaně selhal /
  `error`) → řekni proč a co dál.
- **`followUps`** → platné nálezy CR **mimo** diff. Nabídni je jako námět na samostatný
  task — nezahazuj je a nezačínej je řešit v tomhle běhu.

### Pravidla (garantuje je workflow, nepřekresluj je)

- **Triáž je deterministická** (heuristika ve skriptu). `light` = krátké zadání s
  konkrétní kotvou (1–3 soubory) mimo seamy (kontrakt kontejneru, auth, nový plugin) →
  ARCH se přeskočí. V pochybnostech jede `heavy`.
- **GATE měří z repa, ne z DEVova self-reportu**: `plugin-gate.mjs changed` (git),
  `validate` (schéma `https://app.workmux.com/schemas/workmux-tool.v1.json`, po WOR-757
  i `workmux-plugin.json`, + konvence: Dockerfile `HEALTHCHECK`/`WORKDIR /work`/ne-root,
  README tabulka, sha256 u downloadů), pro pluginy se změnou mimo dokumentaci `docker`
  (build → run → `/healthz` → MCP `initialize` + `tools/list` + 404 na neznámou session
  → SIGTERM). Bez dockeru staví kontejner přes `run_session_container` a pouští `smoke`.
- **`QA: PASS` bez doběhnuté ukázkové úlohy neexistuje.** Zdena-QA staví kontejner
  z aktuálního stromu (`plugin-qa.mjs prepare` + `run_session_container`), nahraje vstup
  do `/work`, zavolá tooly a zkontroluje výstupní soubor. FAIL kvůli prostředí
  (`failKind: env`) neroztáčí nové kolo DEV → GATE → CR — skript zopakuje jen QA
  (max 2×), pak `needsManualQa`.
- Brány jsou sekvenční s prioritou levné → drahé: **GATE** → **CR** → **QA**. CR má
  přednost před QA. Konvergence = **CR: APPROVE i QA: PASS** ve stejném kole.
- **CR blokuje jen nálezy ve změněných řádcích** (`blockers`). Co najde mimo diff,
  jde do `followUps`.

### Výstup uživateli (po skončení)

Česky, stručně: počet kol (`rounds`), finální verdikty (`qa` / `cr`), seznam
změněných souborů (`changedFiles`). Při `exhausted` přidej zbývající blokery.
Žádné marketing fráze, žádné emoji.
