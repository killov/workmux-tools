---
description: Watchdog nad /resolve a /resolve-tasks — ze souborů zjistí, jestli běh Workflow žije, umřel bez verdiktu, nebo doběhl a jen se k tobě nedostal výsledek, a podle toho ho dojede, restartuje, nebo mlčí.
---

## Tvůj úkol

Jsi **budík** nad rozdělaným během `/resolve` / `/resolve-tasks`. **Nehádej z pocitu,
jestli se něco hýbe** — rozhodnutí přečti ze souborů, tedy nejdřív Bashem:

```bash
node .claude/scripts/resolve-watchdog.cjs
```

Skript vypíše jednu větu a JSON s verdiktem (`verdict`, `action`, `runId`, `taskId`,
`scope`, `restarts`, `result`, `lastAgent`, `limit`). **Řiď se jím**; `wf_*.json` vzniká
až v terminálním stavu a živost se měří z mtime v `subagents/workflows/<runId>/`, což
z konverzace nepoznáš.

## Co udělat podle `verdict`

- **`IDLE`** / **`FOREIGN`** / **`RUNNING`** → **NIC**. Odpověz jednou větou (`message`
  ze skriptu) a pokračuj v tom, co jsi dělal. U `RUNNING` nezakládej druhý Workflow —
  živý běh umí mlčet i 30 min (docker build, dlouhý tool call).
- **`LIMIT`** → řekni, že session narazila na 5h limit (i `limit.resets`), jinak jako
  `IDLE`/`RUNNING`. Další okno **nepredikuj** — příští fírnutí přijde za ~15 min samo.
- **`VERDICT_READY`** → běh doběhl, jen se ti výsledek nedostal do tahu. Vezmi `result`
  z JSONu a **dojeď ho**: worker podle tabulky v `.claude/commands/resolve-tasks.md`
  (sekce „Mapování výsledku"), interaktivní běh podle „Návratový objekt" v
  `.claude/commands/resolve.md`. Pak `rm -f .claude/state/resolve-run.json`.
- **`action: "resume"`** (`TERMINAL_NO_VERDICT` / `DEAD_RESUME`) → **dotoč běh, nezačínej
  od nuly** (dokončení agenti se berou z cache):

  ```
  Workflow({ scriptPath: ".claude/workflows/resolve.js", resumeFromRunId: "<runId z JSONu>" })
  ```

  Hned po launchi **přepiš stav** novým `runId` a zvýšeným `restarts` (viz níž).
- **`action: "cleanup"`** (restarty vyčerpané) → když JSON má `taskId` (worker), napiš
  k tasku komentář (`comment_task`) s `runId`, `runStatus`, `runError` a `lastAgent`
  (v kterém kole to umřelo), rozdělanou práci commitni + pushni a zavolej
  `needs_attention`. Bez `taskId` to jen nahlas uživateli. Pak
  `rm -f .claude/state/resolve-run.json` a `CronDelete`.

## Stavový soubor

`.claude/state/resolve-run.json` (negitovaný, jeden na checkout) je jediné strojově
čitelné vlastnictví běhu. Zapisuje ho orchestrátor **hned po launchi Workflow** — `runId`
je v synchronní odpovědi toolu:

```bash
mkdir -p .claude/state && cat > .claude/state/resolve-run.json <<EOF
{"status":"active","runId":"<runId z odpovědi Workflow>","sessionId":"$CLAUDE_CODE_SESSION_ID",
 "taskId":"<id WorkMux tasku, u interaktivního /resolve vynech>","scope":"<krátce co se řeší>",
 "startedAt":$(date +%s)000,"restarts":0}
EOF
```

- Po **každém** přechodu stavu soubor aktualizuj: resume → nové `runId` + `restarts+1`;
  hotovo/úklid → `rm -f`; uživatel řekne „zastav" → `status: "stopped"` (v tomtéž tahu)
  **a `CronDelete`**. Zabitý běh, který zabil člověk, se automaticky rozjet NESMÍ.
- `restarts` má strop 2 na `runId` (`MAX_RESTARTS` ve skriptu) — pak se místo resume uklízí.
