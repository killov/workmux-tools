---
description: Autonomní režim /resolve pro workera WorkMuxu (board Pluginy) — vezme task navázaný na tenhle chat, složí zadání z popisu a komentářů (u reworku je důvod v komentáři), pustí resolve workflow (Zdena-ARCH → DEV → GATE → CR → až po APPROVE QA) a výsledek namapuje na commit + push a task_done / needs_attention / task_wait. Uživatele se nikdy neptá.
argument-hint: [volitelně doplňující pokyn]
---

## Tvůj úkol

Jsi **worker WorkMuxu v auto módu**: task je navázaný na tenhle chat a frontu tasků
i přesun mezi sloupci řídí WorkMux (ze session sloupec měnit nejde — posouváš ho jen
přes `task_done` / `needs_attention` / `task_wait`). Task vyřešíš **stejným postupem
jako `/resolve`** — spuštěním **Workflow** `.claude/workflows/resolve.js` — a podle
návratového objektu ho dojedeš: commit, push, komentář, správný přechod.

Sám kód **needituješ, netestuješ ani nereviewuješ** — a smyčku ani neorchestruješ ručně.
Tvoje práce je task (zadání, komentáře, přechod) a git (commit, push).
Mluvíš **česky, stručně**.

Doplňující pokyn: $ARGUMENTS

## 1. Zadání

1. `mcp__workmux__get_task` — titulek, popis (celé zadání), přílohy, podtasky (patří do
   zadání), navázané tasky. **Rozsah navázaných tasků (blocks / blocked by) patří jim** —
   nedělej ho, neptej se na něj a nedávej ho do `args.task`.
2. `mcp__workmux__list_task_comments` — **komentáře jsou součást zadání**. Když se task
   vrátil k přepracování, je důvod v komentáři: ber ho jako závaznou podmínku (co bylo
   špatně / co doověřit). Přílohy stáhni `read_task_attachment` (do `.workmux/inputs/`)
   a cesty k nim dej do zadání — QA je může použít jako vstup ukázkové úlohy.
3. Větev: pracuješ na větvi, kterou ti kickoff zpráva tasku určila (už je checkoutnutá).
   Na `master` nikdy nekomituj.
4. **Anti-smyčka:** když v komentářích už visí tvůj bloker z dřívějška (stejný task padl
   na stejné věci) a od té doby nepřibyla odpověď člověka, workflow znovu nepouštěj —
   rovnou `needs_attention` s odkazem na ten bloker.

## 2. Spuštění

```
Workflow({
  scriptPath: ".claude/workflows/resolve.js",
  args: { task: "<titulek + popis + podtasky + relevantní komentáře vč. důvodu reworku + cesty k přílohám>",
          base: "origin/master",
          provider: "<proxy|claude — viz Setup v resolve.md>" }
})
```

Hned po launchi zapiš stavový soubor a založ watchdog (sekce Watchdog v
`.claude/commands/resolve.md`; do stavu dej `taskId`). Do doby, než přijde výsledek,
nezačínej nic jiného ve working tree. Když workflow spadne bez výsledku, dotoč ho
`Workflow({ scriptPath, resumeFromRunId })` (rozhoduje `/resolve-watchdog`).

## 3. Mapování výsledku

| Výsledek | Co uděláš |
| --- | --- |
| `done: true` (i s `qaSkipped`) | commit + push, komentář (shrnutí, `ZMĚNĚNÉ SOUBORY`, kola, ukázková úloha QA nebo „QA neběžela — jen dokumentace"), `task_done` |
| `needsClarification: true` | komentář s otázkami z `questions` (ideálně varianty A/B), `needs_attention` „čeká na upřesnění zadání" — nic necommituj, smyčka neběžela |
| `needsManualQa: true` | commit + push (kód je CR-approved), komentář: **co má člověk ručně ověřit** + proč to QA nezvládla (`lastQaReport` doslova, u `qaFailKind: credentials` jaký účet/secret je potřeba) + soubory, `needs_attention` „k ručnímu otestování" |
| `envDead: true` | jako `needsManualQa` + do komentáře `PROSTŘEDÍ: <envDeadReason>`; v `needs_attention` napiš, že prostředí session nejde nahodit |
| `exhausted` / `scopeCreep` / `budgetStopped` / `done: false` bez příznaků | rozdělanou práci commitni + pushni (prošla GATE), komentář s konkrétními blokery (`lastCrComments` + `lastQaReport` doslova; u `scopeCreep` doporuč ohraničit zadání), `needs_attention` |
| zbytek práce patří jinému tasku | `create_task` + `task_link_create` (blokuje tenhle), pak `task_wait` s důvodem |

- **`followUps`** (může přijít i s `done: true`): vypiš je do komentáře jako náměty na
  samostatné tasky. Neřeš je v tomhle běhu; větší skupinu klidně založ jako task
  (`list_task_boards` → `create_task`).
- **Commit**: message česky bez diakritiky nebo anglicky, imperativně, stručně, s
  identifikátorem tasku (`... - WOR-123`), zakončená řádkem `Co-Authored-By` podle
  pokynů session. Pak `git push -u origin <větev>`. DEV občas commitne sám — když
  `git commit` hlásí „nothing to commit", ověř `git log` a jen pushni.
- `task_done` / `task_wait` volej **až po pushi**. Při infrastrukturní chybě `task_done`
  počkej minutu a zkus znovu — to není důvod k `needs_attention`.

## Pravidla

- **Nikdy se uživatele neptej** (`AskUserQuestion` ne). Nejasnost → komentář + `needs_attention`.
- **Nečekej na „steer"** u velkých věcí — dodej, CR ať zreviewuje, QA ať ověří, co jde;
  co nejde ověřit automaticky, jde k ručnímu otestování.
- **Nikdy `QA: PASS` bez doběhnuté ukázkové úlohy** (stejné pravidlo jako `/resolve`).
- **Na `master` nekomituj**, nemerguj a neotvírej PR — merge dělá WorkMux po `task_done`.
- Přílohy a soubory uživatele v `.workmux/inputs/` nemaž a necommituj; výstupy pro
  člověka (rendery, exporty) dej do `.workmux/outputs/` a pojmenuj je v komentáři.
- **Watchdog na konci zruš** (`CronDelete`) a stavový soubor smaž.
