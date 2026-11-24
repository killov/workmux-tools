export const meta = {
  name: 'resolve-loop',
  description: 'Engine za /resolve (workmux-tools): triáž (u těžkého tasku Zdena-ARCH naplánuje), pak deterministická smyčka DEV → GATE (manifest + docker build + MCP smoke) → CR → (až po APPROVE) QA přes MCP pluginu, dokud CR: APPROVE && QA: PASS (max 20 kol)',
  phases: [
    { title: 'Plán', detail: 'deterministická triáž (lehký/těžký režim, nula tokenů) → u těžkého Zdena-ARCH přečte kód a vrátí implementační plán' },
    { title: 'Smyčka', detail: 'Zdena-DEV napíše kód → GATE (manifest vs. schéma, docker build, MCP smoke) → Zdena-CR review → až po APPROVE Zdena-QA (ukázková úloha přes MCP pluginu)' },
  ],
}

// --- vstup ---------------------------------------------------------------
// args: { task: string, base?: string, provider?: 'claude'|'proxy' }  nebo rovnou string se zadáním.
const TASK = (typeof args === 'string' ? args : args?.task)?.trim()
const BASE = typeof args === 'object' && args ? (args.base || '') : ''
// Patra modelů pro levné fáze. Mapa je PER PROVIDER, protože `resolve.js` jede
// na claude i na proxy session (codex/grok/openrouter) a jejich patra nejsou
// zaměnitelná — `sonnet`/`haiku` se u proxy překládají přes
// ANTHROPIC_DEFAULT_{SONNET,HAIKU}_MODEL na úplně jiné modely.
//
// Na CLAUDE session: hlavní model na DEV/CR/QA/ARCH, GATE na `haiku` — GATE jen
// pouští skripty brány a čte jejich `GATE_JSON`, žádný úsudek.
// Na PROXY session jede ARCH na prostředním patře: ARCH bez pinu dědil hlavní
// model a byl nejdražší položka běhu, přitom ta kola byla čtení repa, ne práce
// (proměřeno ve workmuxtool 4. 9. 2026: 33 kol / 3,55 M → 8 kol / 0,80 M).
//
// `args.provider` dodává `/resolve` (viz .claude/commands/resolve.md). Když
// chybí, platí claude mapa.
const PROXY_SESSION = args?.provider === 'proxy'
const MODELS = {
  // undefined = bez pinu, tzn. dědí hlavní model session.
  arch: PROXY_SESSION ? 'sonnet' : undefined,
  gate: 'haiku',
}
log(`patra modelů: ${PROXY_SESSION ? 'proxy' : 'claude'} — ARCH=${MODELS.arch ?? 'hlavní model'}, GATE=${MODELS.gate}`)

const MAX_ROUNDS = 20
// Kolikrát smí QA selhat (FAIL při schváleném CR), než to vzdáme automaticky a
// pošleme task k ručnímu otestování — místo mlácení do 20 kol na něčem, co se
// živě neověří.
const MAX_QA_FAILS = 3
// FAIL kvůli PROSTŘEDÍ (build kontejneru spadl na infrastruktuře, registry/síť,
// limit kontejnerů session) není bug v kódu — točit kvůli němu celé kolo
// DEV → GATE → CR je plýtvání. QA se zopakuje rovnou (kód se nezměnil), max tolikrát:
const MAX_QA_ENV_RETRIES = 2
// Od tohoto kola dostane CR pokyn blokovat UŽ JEN skutečné blokery (korektnost,
// bezpečnost, ztráta dat). Stylové a konvenční věci od té chvíle patří do
// `followUps` — jinak se dlouhé běhy utopí v kosmetice (ve workmuxtool 13/20
// běhů skončilo přesně v kole, kdy strict nastoupil).
const STRICT_CR_FROM_ROUND = 2
// Kolikrát po sobě smí CR ukázat na úplně jinou sadu souborů než minule, než to
// vyhodnotíme jako rozlézání scopu (whack-a-mole) a smyčku zastavíme.
const MAX_CREEP_ROUNDS = 3
// Cesty bez povrchu v běžícím pluginu: dokumentace a konfigurace agentů. Když se
// kolo dotklo JEN jich, stavět kontejner a pouštět ukázkovou úlohu je čistá režie.
// `workmux-tool.json` sem NEPATŘÍ — `instructions`/`description` čte bot za běhu.
// Totéž pravidlo (soubory mimo *.md) používá `plugin-gate.mjs changed` pro
// `runtimePlugins`, tedy pro to, kde GATE staví image.
const NO_RUNTIME_SURFACE = [
  /(^|\/)docs?\//i,
  /\.mdx?$/i,
  /(^|\/)\.claude\//,
  /^\.gitignore$/,
  /^LICENSE$/,
]
const hasNoRuntimeSurface = (f) => NO_RUNTIME_SURFACE.some((re) => re.test(f))
// Kolik tokenů si necháváme na dojetí (poslední GATE + úklid), když uživatel
// zadal rozpočet přes "+Nk". Pod tuhle hranici další kolo nepouštíme.
const BUDGET_RESERVE = 80_000

if (!TASK) {
  return { done: false, error: 'Prázdné zadání — Workflow resolve dostal `args.task` prázdné.' }
}

// --- schémata (nahrazují parsování textových markerů) --------------------
const ARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    plan: { type: 'string', description: 'Implementační plán v odrážkách: co se mění, ve které složce pluginu, co znovupoužít (vzor solidcraft/gws), postup, jakou ukázkovou úlohu má QA pustit přes MCP, rizika, co je mimo scope.' },
    files: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'Cesta k souboru (repo-relativní).' },
          why: { type: 'string', description: 'Krátce co se v něm mění a proč.' },
        },
        required: ['path'],
      },
      description: 'Soubory, kde se pravděpodobně bude měnit — DEV má odkud začít. Ber to jako „začni tady", NE tvrdý whitelist.',
    },
    openQuestions: { type: 'array', items: { type: 'string' }, description: 'JEN zásadní nejasnosti v ZADÁNÍ, kde bys musel HÁDAT zamýšlené chování a špatný odhad = zahozený DEV/QA/CR cyklus (ne technikálie — ty řeš konvencemi repa). Když je pole neprázdné, smyčka se NEspustí a task jde k upřesnění. Jinak prázdné.' },
  },
  required: ['plan'],
}
const DEV_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Krátké česky shrnutí co a proč ses změnil (2–4 věty).' },
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Cesty souborů, které ses vědomě změnil (orientační — pravdu stejně změří GATE z gitu).' },
    dismissed: { type: 'array', items: { type: 'string' }, description: 'CR/QA body, na které ses vědomě rozhodl nereagovat, s důvodem (jinak prázdné).' },
  },
  required: ['summary', 'changedFiles'],
}
// GATE: samostatný levný agent — jediný zdroj pravdy o změněných souborech a zeleni
// manifestu/buildu/smoke testu. DEV si to nereportuje sám, tohle to změří z repa.
const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    changedFiles: { type: 'array', items: { type: 'string' }, description: 'Pole `changedFiles` z GATE_JSON příkazu `changed` (git status --porcelain vč. untracked).' },
    plugins: { type: 'array', items: { type: 'string' }, description: 'Pole `plugins` z `changed` — složky pluginů, kterých se změna dotkla.' },
    manifestOk: { type: 'boolean', description: '`changed` i `validate` skončily s `"ok": true`.' },
    buildOk: { type: 'boolean', description: 'Image všech `runtimePlugins` se postavil (docker build / run_session_container bez chyby). Když je `runtimePlugins` prázdné, `true`.' },
    smokeOk: { type: 'boolean', description: 'MCP smoke (`smoke` / `docker`) skončil s `"ok": true` u všech `runtimePlugins`. Když je `runtimePlugins` prázdné, `true`.' },
    details: { type: 'string', description: 'Když je cokoli červené: konkrétní FAIL/error řádky z výstupu skriptu (nebo ocas build logu). Jinak prázdné.' },
  },
  required: ['changedFiles', 'manifestOk', 'buildOk', 'smokeOk'],
}
const QA_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    failKind: { type: 'string', enum: ['bug', 'env', 'credentials'], description: 'Jen u FAIL: `bug` = úloha doběhla a plugin se chová špatně (tool spadl, výstup chybí/neodpovídá zadání). `env` = k ověření ses nedostal(a) kvůli prostředí session (build/run kontejneru selhal na infrastruktuře, síť, limit kontejnerů). `credentials` = ukázková úloha potřebuje secret/OAuth účet, který v session není — chování bez něj jsi ověřil(a), zbytek musí otestovat člověk.' },
    report: { type: 'string', description: 'Jakou ukázkovou úlohu jsi pustil(a): vstupní soubory, volané tooly s argumenty, výstupní soubory a co jsi na nich zkontroloval(a); u FAIL konkrétně který krok a proč (co jsi čekal(a) vs. co přišlo).' },
    scenario: { type: 'string', description: 'Cesta ke `steps.json` scénáři (ve `.workmux/qa/<plugin>/`) a vstupním souborům, ať ho příští kolo pustí znovu.' },
    envRecovery: { type: 'string', enum: ['recovered', 'failed', 'not_needed'], description: 'Recovery prostředí (Zdena-QA, „Když prostředí nenaběhne"): `recovered` = něco leželo a nahodil(a) jsi to, `failed` = recovery postup jsi prošel(a) celý a prostředí pořád nežije, `not_needed` = prostředí běželo.' },
    envRecoveryNote: { type: 'string', description: 'Co přesně jsi při recovery zkoušel(a) a s jakým výsledkem (list_session_containers, remove/run_session_container, session_container_logs).' },
  },
  // envRecovery záměrně ne v `required` — tolerance k agentům, co ho ještě neznají.
  required: ['verdict', 'report'],
}
// CR vrací DVA seznamy, ne jeden. `blockers` drží verdikt, `followUps` ne —
// jinak review u „projdi celou oblast" tasků nikdy nedojde ke konci.
const CR_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'] },
    blockers: { type: 'array', items: { type: 'string' }, description: 'JEN nálezy ve změněných řádcích diffu, formát `soubor:řádek — komentář` (bez tečky, bez chvály). Tyhle drží REQUEST_CHANGES. U APPROVE prázdné.' },
    followUps: { type: 'array', items: { type: 'string' }, description: 'Nálezy MIMO změněné řádky (jiný plugin, stejný hřích jinde, starší dluh). Stejný formát. NEBLOKUJÍ verdikt — propadnou do reportu jako námět na samostatný task.' },
  },
  required: ['verdict'],
}

// --- triáž: potřebuje tenhle task vůbec architekta? ----------------------
// Deterministická, žádný agent (agentní triáž ve workmuxtool rozhodla 17/20 běhů
// „heavy" a jen stála tokeny). `light` = krátké zadání s konkrétní kotvou
// (1–3 soubory) mimo sdílené seamy. V pochybnostech jede `heavy` — falešné
// `light` stojí zahozené kolo, falešné `heavy` jen jeden ARCH pass.
// Seamy workmux-tools: kontrakt kontejneru a manifestu (co čte WorkMux), přihlašování
// (secrets/OAuth), nový plugin a sdílený základ víc pluginů.
const SEAM_RE = /(nový plugin|new plugin|nov[ýé] tool|společný základ|shared base|workmux-plugin\.json|schéma|schema|\boauth\b|secrets?\b|streamable|Mcp-Session-Id|base image|multi-?arch|\bCraft\b)/i
const TASK_FILE_RE = /[\w./-]+\.(?:mjs|cjs|js|ts|json|md|sh|py|ya?ml)(?::\d+)?|[\w./-]*Dockerfile[\w.-]*/g
const taskAnchorFiles = new Set((TASK.match(TASK_FILE_RE) || []).map((a) => a.split(':')[0]))
const lightMode = TASK.length < 2000 && taskAnchorFiles.size >= 1 && taskAnchorFiles.size <= 3 && !SEAM_RE.test(TASK)
log(lightMode
  ? `triáž (deterministická): lehký režim, ARCH se přeskakuje — krátké zadání s kotvou (${[...taskAnchorFiles].join(', ')}), mimo seamy`
  : `triáž (deterministická): těžký režim, jede ARCH — ${TASK.length >= 2000 ? 'dlouhé zadání' : SEAM_RE.test(TASK) ? 'sahá na sdílený seam (kontrakt, auth, nový plugin)' : taskAnchorFiles.size > 3 ? `${taskAnchorFiles.size} souborů v zadání` : 'žádná konkrétní kotva v zadání'}`)

// --- plánování (jednou) --------------------------------------------------
// Zadání často UŽ nese hotovou analýzu (kotvy `soubor:řádek`, rozbor). Nechat ARCH
// derivovat totéž od nuly je odpad — v tom případě jede ověřovací režim na low effort.
const FILE_LINE_ANCHOR_RE = /[\w./-]+\.(?:mjs|cjs|js|ts|json|md|sh|py|ya?ml):\d+|[\w./-]*Dockerfile:\d+/g
const ANALYSIS_HEADING_RE = /^#{1,4} +(příčina|proč|návrh|kde hledat|řešení|symptom|root cause|implementace|plán|postup|co udělat|jak na to|api|tooly|navazuje|už existuje|analýza|zjištění|repro)/im
const lineAnchorCount = (TASK.match(FILE_LINE_ANCHOR_RE) || []).length
const taskHasAnalysis = TASK.length > 1200 && lineAnchorCount >= 1 && (ANALYSIS_HEADING_RE.test(TASK) || lineAnchorCount >= 3)
if (taskHasAnalysis && !lightMode) log('zadání nese vlastní analýzu (kotvy soubor:řádek + rozbor) — ARCH jede ověřovací režim na low effort')

const arch = lightMode ? null : await agent(
  taskHasAnalysis
    ? [
        `Zadání:\n${TASK}`,
        `Tohle zadání UŽ obsahuje rozbor včetně konkrétních \`soubor:řádek\` kotev. NEDERIVUJ ho znovu od nuly.`,
        `Tvoje práce je OVĚŘIT a DOPLNIT: (1) zkontroluj vzorkem, že citované kotvy v kódu reálně sedí, (2) doplň, co rozbor nezmiňuje — co znovupoužít (vzor solidcraft/gws), jakou ukázkovou úlohu má QA pustit přes MCP, co je mimo scope, (3) když analýza NESEDÍ s kódem, řekni to natvrdo a naplánuj to správně.`,
        `Nekóduj.`,
      ].join('\n\n')
    : `Zadání:\n${TASK}\n\nPřečti relevantní kód repa (CLAUDE.md, README.md, dotčené složky pluginů) a naplánuj, jak se to udělá (nekóduj). Aktivně hledej existující vzory k znovupoužití.`,
  {
    agentType: 'Zdena-ARCH', phase: 'Plán', schema: ARCH_SCHEMA, label: 'ARCH: plán',
    ...(MODELS.arch ? { model: MODELS.arch } : {}),
    ...(taskHasAnalysis ? { effort: 'low' } : {}),
  },
)
const plan = arch?.plan || (lightMode
  ? '(lehký režim — triáž vyhodnotila task jako ohraničený, samostatný plán se nedělal; naplánuj si to sám při psaní a drž konvence repa z CLAUDE.md)'
  : '(architekt nevrátil plán — DEV se řídí přímo zadáním a konvencemi repa z CLAUDE.md)')
const filesHint = arch?.files?.length
  ? arch.files.map((f) => `- ${f.path}${f.why ? ` — ${f.why}` : ''}`).join('\n')
  : (lightMode ? '(lehký režim — dotčená místa si najdi sám podle zadání)' : '(ARCH nevytipoval soubory — najdi si dotčená místa sám)')
if (arch?.files?.length) log(`ARCH vytipoval ${arch.files.length} souborů`)

// Zásadní nejasnost v zadání → nehádej, zeptej se. Interaktivní /resolve se zeptá
// uživatele, worker (/resolve-tasks) dá otázky do komentáře a zavolá člověka.
if (arch?.openQuestions?.length) {
  log(`ARCH: blokující nejasnosti (${arch.openQuestions.length}) — smyčka se nepouští, task potřebuje upřesnění`)
  return {
    done: false,
    needsClarification: true,
    questions: arch.openQuestions,
    plan,
    rounds: 0,
  }
}

// --- smyčka (kolo = 1 .. MAX_ROUNDS) -------------------------------------
// Sekvenční z principu: kolo N závisí na feedbacku z N-1.
// Pořadí bran uvnitř kola je levné → drahé: GATE (manifest + build + smoke) → CR
// (čte diff) → až po CR:APPROVE QA (ukázková úloha přes MCP, nejdražší).
phase('Smyčka')
let feedback = ''
let dev = null, gate = null, qa = null, cr = null
let changedFiles = []
let done = false
let round = 0
let deadDevRounds = 0
let qaFails = 0
let needsManualQa = false
// Prostředí je mrtvé i po recovery z QA — orchestrátor má zavolat člověka, ne točit kola.
let envDead = false
let qaSkipped = false
let budgetStopped = false
let scopeCreep = false
let creepRounds = 0
let prevBlockerFiles = new Set()
// Blockery z minulého CR kola — ověřovací CR kolo je dostane do promptu, aby
// necouralo celý diff od nuly. Přežívá GATE-červená kola, nuluje se na APPROVE.
let prevCrBlockers = []
const followUps = []

/** Soubory, na které CR ukázal — `soubor:řádek — komentář` → `soubor`. */
// Odrážku a backtick kolem cesty setřást MUSÍME, jinak by průnik vyšel vždycky
// neprázdný a creep detektor by nikdy nevystřelil.
const filesOf = (comments) =>
  new Set(
    (comments || [])
      .map((c) => String(c).trim().replace(/^[-*•]\s*/, '').replace(/^`/, '').split(/[:\s]/)[0])
      .filter((f) => f && /[./]/.test(f)),
  )

const GATE_SCRIPT = 'node .claude/scripts/plugin-gate.mjs'

for (round = 1; round <= MAX_ROUNDS; round++) {
  // Rozpočtová brzda: když uživatel zadal token target, ať smyčka umře řízeně.
  if (round > 1 && budget.total && budget.remaining() < BUDGET_RESERVE) {
    log(`rozpočet došel (zbývá ~${Math.round(budget.remaining() / 1000)}k) — končím po ${round - 1} kolech`)
    budgetStopped = true
    break
  }
  dev = await agent(
    [
      `Zadání:\n${TASK}`,
      `PLÁN OD ARCH:\n${plan}`,
      `SOUBORY DLE ARCH (začni tady — NE tvrdý whitelist):\n${filesHint}`,
      `FEEDBACK Z MINULÉHO KOLA:\n${feedback || '(první kolo — žádný feedback)'}`,
      // Každé kolo je nový DEV s prázdnou hlavou — `git diff` je komprimovaná paměť té práce.
      round > 1
        ? [
            `TVOJE PRÁCE Z MINULÝCH KOL UŽ JE VE WORKING TREE — ale ty jsi nový kontext a nic si z ní nepamatuješ.`,
            `Začni \`git diff${BASE ? ` ${BASE}` : ''}\` (+ \`git status --porcelain\` na nové soubory). Dotčené soubory NEČTI celé znovu od nuly — dočítej jen to, co diff sám nevysvětlí.`,
            dev?.summary ? `Cos o minulém kole napsal(a): ${dev.summary}` : null,
          ].filter(Boolean).join(' ')
        : null,
      `Naimplementuj / oprav kód podle plánu a feedbacku. Feedback od CR a QA je závazný — projdi ho bod po bodu. Working tree je společný deliverable, needituj mimo scope.`,
      `BRÁNA JDE PO TOBĚ: samostatný gate agent hned po tobě zvaliduje manifesty, postaví image změněných pluginů a pustí MCP smoke test. Ty si před vrácením výsledku pusť levnou část sám: \`${GATE_SCRIPT} validate <složka>\` a \`node --check\` na změněné .mjs/.js. Docker build nech na bráně (trvá minuty); když něco chytí, přijde ti to jako feedback do dalšího kola.`,
    ].filter(Boolean).join('\n\n'),
    { agentType: 'Zdena-DEV', phase: 'Smyčka', schema: DEV_SCHEMA, label: `kolo ${round}: DEV` },
  )

  if (!dev) {
    deadDevRounds++
    log(`kolo ${round}: DEV nevrátil výsledek (${deadDevRounds}×)`)
    if (deadDevRounds >= 2) { log('DEV opakovaně selhal — přerušuji smyčku.'); break }
    continue
  }
  deadDevRounds = 0
  if (dev.dismissed?.length) log(`kolo ${round}: DEV nereagoval na: ${dev.dismissed.join(' | ')}`)

  // BRÁNA 1 — GATE agent: pravda o změněných souborech + zeleň manifestu, buildu
  // a MCP smoke testu z repa (ne DEVův self-report). Levný, jednoúčelový.
  gate = await agent(
    [
      `Nejsi vývojář — kód NEEDITUJ. Jsi měřicí brána. Spusť přesně tyhle kroky v kořeni repa a vrať PRAVDIVÝ výsledek. Každý příkaz skriptu končí řádkem \`GATE_JSON {...}\` — rozhoduj podle něj, ne podle dojmu.`,
      `0) Když chybí \`.claude/scripts/node_modules\`, spusť \`npm ci --prefix .claude/scripts --no-audit --no-fund\`.`,
      `1) \`${GATE_SCRIPT} changed${BASE ? ` --base ${BASE}` : ''}\` → \`changedFiles\` a \`plugins\` opiš z GATE_JSON; poznamenej si \`runtimePlugins\`.`,
      `2) \`${GATE_SCRIPT} validate <všechny složky z plugins>\` (když je \`plugins\` prázdné, bez argumentů = všechny pluginy) → \`manifestOk\` = (changed.ok && validate.ok).`,
      `3) Pro KAŽDOU složku z \`runtimePlugins\`: \`${GATE_SCRIPT} docker <složka>\`.`,
      `   - exit 0/1 → \`buildOk\`/\`smokeOk\` podle GATE_JSON (\`step: "build"\` = build červený).`,
      `   - exit 3 (docker tu není) → postav kontejner přes MCP workmux přesně podle vypsaného návodu: \`run_session_container({ name: "gate-<složka>", build: { context: "<složka>" }, ports: [<mcp.port>], ttlMinutes: 30 })\` (nástroj načteš přes ToolSearch "select:mcp__workmux__run_session_container,mcp__workmux__remove_session_container,mcp__workmux__session_container_logs"). Chyba buildu = \`buildOk: false\` + ocas logu do \`details\`. Pak \`${GATE_SCRIPT} smoke http://gate-<složka>:<mcp.port><mcp.path> --slug <slug>\` (prvních ~10 s po startu může /healthz ještě nebýt nahoře — při FAIL na healthz/initialize počkej 10 s a pusť smoke jednou znovu) a NAKONEC VŽDY \`remove_session_container({ name: "gate-<složka>" })\` (session má limit 3 dočasných kontejnerů).`,
      `   - Když \`run_session_container\` odmítne kvůli limitu kontejnerů, \`list_session_containers\` → odstraň staré \`gate-*\` a zkus znovu.`,
      `   Když je \`runtimePlugins\` prázdné (změna jen v dokumentaci / .claude), krok 3 vynech a \`buildOk\` i \`smokeOk\` = true.`,
      `Když je cokoli červené, do \`details\` dej konkrétní FAIL/error řádky (soubor, krok, chyba). Nic nefixuj, nic dalšího nečti, jen změř a nahlas.`,
    ].join('\n'),
    { agentType: 'general-purpose', phase: 'Smyčka', schema: GATE_SCHEMA, label: `kolo ${round}: GATE`, model: MODELS.gate, effort: 'low' },
  )
  changedFiles = gate?.changedFiles?.length ? gate.changedFiles : (dev.changedFiles ?? [])
  const changedList = changedFiles.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '(GATE ani DEV neuvedl změněné soubory)'
  const plugins = gate?.plugins ?? []

  if (!gate || !gate.manifestOk || !gate.buildOk || !gate.smokeOk) {
    log(`kolo ${round}: GATE červená (manifest=${gate?.manifestOk ?? 'ERR'}, build=${gate?.buildOk ?? 'ERR'}, smoke=${gate?.smokeOk ?? 'ERR'}) — CR/QA se nepouští`)
    feedback = `BRÁNA ČERVENÁ (oprav, než půjde dál — CR ani QA se kvůli tomu nespustilo):\n${gate?.details || `(GATE neuvedl detail — spusť \`${GATE_SCRIPT} validate\` a \`${GATE_SCRIPT} docker <složka>\` a oprav)`}`
    continue
  }

  // BRÁNA 2 — CR (levnější než QA, má přednost): čte diff, dokud není čistý, QA vůbec neběží.
  cr = await agent(
    [
      // CR MUSÍ znát zadání: bez něj neví, co je deliverable.
      `Zadání, které diff plní (nálezy měř vůči němu — co zadání výslovně chce, není blocker):\n${TASK}`,
      `Zreviewuj JEN diff aktuálního working tree${BASE ? ` (git diff ${BASE})` : ' (git diff)'} + nové untracked soubory, ne celý repo.`,
      `Změněné soubory (z gitu):\n${changedList}`,
      `BRÁNA UŽ PROBĚHLA A JE ZELENÁ — manifesty sedí na schéma WorkMux a konvence repa, image ${plugins.length ? `pluginů ${plugins.join(', ')} ` : ''}se postavil a MCP smoke (healthz, initialize, tools/list, 404 na neznámou session${changedFiles.some((f) => !hasNoRuntimeSurface(f)) ? '' : ' — tady se nestavělo, změna je jen v dokumentaci'}) prošel. NESPOUŠTĚJ build ani smoke znovu. Tvoje přidaná hodnota je to, co brána nechytí: kontrakt kontejneru do hloubky (cesty mimo /work, base64 místo souborů, SIGTERM, secrets v logu/výstupu), pinned verze + sha256, README tabulka, kvalita \`instructions\` pro bota.`,
      `ROZSAH VERDIKTU: \`blockers\` = jen nálezy ve ZMĚNĚNÝCH řádcích diffu, ty drží REQUEST_CHANGES. Cokoli mimo diff (jiný plugin, starší dluh) patří do \`followUps\`.`,
      prevCrBlockers.length
        ? [
            `OVĚŘOVACÍ KOLO — minulé CR kolo vrátilo tyhle blockery:\n${prevCrBlockers.map((b) => `- ${b}`).join('\n')}`,
            `DEV k opravě píše: ${dev.summary}`,
            `Primárně ověř, že KAŽDÝ z nich je vyřešený, a projdi řádky, které se od minula změnily. Neotvírej nová témata na řádcích, cos minule nechal projít; nový blocker jen za skutečný problém, který oprava zanesla.`,
          ].join('\n\n')
        : null,
      round >= STRICT_CR_FROM_ROUND
        ? `KOLO ${round} — už jen SKUTEČNÉ blokery: korektnost, bezpečnost (secrets, cesty mimo /work), ztráta dat, porušený kontrakt kontejneru. Pojmenování a styl teď patří do \`followUps\`.`
        : null,
      `Když v diffu blocker není, APPROVE (i kdyby \`followUps\` bylo plné).`,
    ].filter(Boolean).join('\n\n'),
    { agentType: 'Zdena-CR', phase: 'Smyčka', schema: CR_SCHEMA, label: `kolo ${round}: CR` },
  )
  if (cr?.followUps?.length) {
    followUps.push(...cr.followUps.filter((f) => !followUps.includes(f)))
    log(`kolo ${round}: CR odložil ${cr.followUps.length} nálezů mimo diff do follow-ups`)
  }
  const crApprove = cr?.verdict === 'APPROVE'
  if (!crApprove) {
    const blockers = cr?.blockers?.length ? cr.blockers : []
    log(`kolo ${round}: CR=${cr?.verdict ?? 'ERR'} (${blockers.length} blockerů) — QA se nepouští`)

    // Whack-a-mole detektor: CR kolo co kolo ukazuje na úplně jinou sadu souborů.
    const nowFiles = filesOf(blockers)
    if (nowFiles.size && prevBlockerFiles.size && ![...nowFiles].some((f) => prevBlockerFiles.has(f))) {
      creepRounds++
      log(`kolo ${round}: CR míří na jinou sadu souborů než minule (${creepRounds}/${MAX_CREEP_ROUNDS})`)
    } else {
      creepRounds = 0
    }
    prevBlockerFiles = nowFiles
    if (creepRounds >= MAX_CREEP_ROUNDS) {
      log('CR se stěhuje po repu místo konvergence — zastavuji, task potřebuje uzavřenou definici hotového')
      scopeCreep = true
      break
    }

    const crBody = blockers.length ? blockers.join('\n') : (cr ? '(CR nevrátil komentáře)' : '(CR agent selhal)')
    // CR agent úplně selhal → minulé blockery NEpřepisujeme, příští CR je má ověřit znovu.
    if (blockers.length) prevCrBlockers = blockers
    feedback = `CR: REQUEST_CHANGES\n${crBody}`
    continue
  }
  prevBlockerFiles = new Set()
  prevCrBlockers = []
  creepRounds = 0

  // Kolo se dotklo JEN věcí bez povrchu v běžícím pluginu (dokumentace, .claude).
  // Verdikt NEHLÁSÍME jako PASS: je to SKIPPED s důvodem.
  if (changedFiles.length && changedFiles.every(hasNoRuntimeSurface)) {
    log(`kolo ${round}: CR=APPROVE, QA se nepouští — nic ze změn nemá povrch v běžícím pluginu (${changedFiles.join(', ')})`)
    qa = {
      verdict: 'SKIPPED',
      report: `QA se záměrně nepouštěla: všech ${changedFiles.length} změněných souborů je mimo runtime povrch pluginu (dokumentace / konfigurace agentů), přes MCP se to pozorovat nedá.`,
    }
    qaSkipped = true
    done = true
    break
  }

  // BRÁNA 3 — QA (nejdražší, staví kontejner a jede ukázkovou úlohu): až když CR schválil.
  // Vnitřní retry na `failKind: 'env'`: pád prostředí není bug v kódu — opakuje se jen QA.
  for (let qaTry = 0; ; qaTry++) {
    qa = await agent(
      [
        `Zadání:\n${TASK}`,
        `V tomto kole se změnilo (z gitu):\n${changedList}`,
        `Dotčené pluginy: ${plugins.join(', ') || '(GATE neuvedl — odvoď ze změněných souborů)'}`,
        `Ověř zadání UKÁZKOVOU ÚLOHOU přes MCP pluginu tak, jak by ji dělal bot ve WorkMuxu: \`node .claude/scripts/plugin-qa.mjs prepare <složka>\` → \`run_session_container\` podle vypsaného návodu (tooly načteš přes ToolSearch "select:mcp__workmux__run_session_container,mcp__workmux__remove_session_container,mcp__workmux__list_session_containers,mcp__workmux__session_container_logs") → \`plugin-qa.mjs put\` vstupních souborů do /work → \`plugin-qa.mjs steps\` (scénář v JEDNÉ MCP session) / \`call\` → \`plugin-qa.mjs get\` výstupních souborů a jejich KONTROLA (existují, mají správný formát a obsah podle zadání). Úlohu ber z akceptace tasku („Hotovo, když"); když tam není, zvol nejtypičtější použití dotčených toolů. Bez doběhnuté úlohy je verdikt FAIL, ne „přeskočeno".`,
        `Scénář (steps.json + vstupy) ulož do \`.workmux/qa/<složka>/scenario/\` a uveď v \`scenario\`. Image se staví z aktuálního stromu: když kontejner \`qa-<složka>\` z minulého kola existuje, napřed ho \`remove_session_container\` (jinak testuješ starý kód). Po verdiktu ho nech běžet jen při FAIL (příští kolo ho stejně přestaví), při PASS ho odstraň.`,
        `EKONOMIE (neoslabuj tím věrnost — fake PASS neexistuje): testuj ÚMĚRNĚ změně — u změny \`instructions\`/README stačí ověřit, že návod z instructions reálně funguje na jednom příkladu; nezkoumej všechny tooly pluginu.`,
        qa?.scenario ? `Z minulého kola existuje scénář: ${qa.scenario} — pusť ho napřed, ručně dovolej už jen to, co nepokrývá nebo co se od minula změnilo.` : null,
        qaTry > 0
          ? `MINULÝ POKUS PADL NA PROSTŘEDÍ, ne na chování pluginu — kód se od té doby NEZMĚNIL:\n${qa?.report || '(bez reportu)'}\nTvoje práce v tomhle pokusu je prostředí dorazit a úlohu reálně pustit. Když to nejde ani teď, vrať zase FAIL s failKind=env a konkrétním důvodem.`
          : null,
      ].filter(Boolean).join('\n\n'),
      { agentType: 'Zdena-QA', phase: 'Smyčka', schema: QA_SCHEMA, label: qaTry > 0 ? `kolo ${round}: QA (env retry ${qaTry})` : `kolo ${round}: QA` },
    )
    const envFail = qa?.verdict === 'FAIL' && qa?.failKind === 'env'
    // QA prošla recovery postup a prostředí pořád leží → další pokus by zkoušel totéž.
    if (envFail && qa.envRecovery === 'failed') {
      envDead = true
      break
    }
    if (!envFail || qaTry >= MAX_QA_ENV_RETRIES) break
    log(`kolo ${round}: QA=FAIL kvůli prostředí — opakuju jen QA, bez nového DEV kola (retry ${qaTry + 1}/${MAX_QA_ENV_RETRIES})`)
  }
  const qaPass = qa?.verdict === 'PASS'
  log(`kolo ${round}: CR=APPROVE, QA=${qa?.verdict ?? 'ERR'}${qa?.verdict === 'FAIL' && qa?.failKind ? ` (${qa.failKind})` : ''}`)

  if (qaPass) { done = true; break }
  if (envDead) {
    log(`prostředí je mrtvé i po recovery (${qa.envRecoveryNote || 'bez poznámky'}) — task jde k ručnímu otestování, potřeba zásah člověka`)
    needsManualQa = true
    break
  }
  // Prostředí nešlo rozjet ani na env retry, nebo úloha potřebuje přihlášení, které
  // session nemá → další DEV kolo na nezměněném stromu nepomůže. K ručnímu otestování.
  if (qa?.failKind === 'env' || qa?.failKind === 'credentials') {
    log(qa.failKind === 'credentials'
      ? 'ukázková úloha potřebuje credentials, které session nemá — task jde k ručnímu otestování'
      : `prostředí se nepodařilo rozjet ani na ${MAX_QA_ENV_RETRIES} env retry — task jde k ručnímu otestování`)
    needsManualQa = true
    break
  }
  qaFails++
  if (qaFails >= MAX_QA_FAILS) {
    log(`QA selhala ${qaFails}× — task jde k ručnímu otestování (automaticky se dál nezkouší)`)
    needsManualQa = true
    break
  }
  feedback = `QA: FAIL (pokus ${qaFails}/${MAX_QA_FAILS})\n${qa?.report || '(QA nevrátila report — prostředí/agent selhal, zprovozni úlohu)'}`
}

// --- výsledek ------------------------------------------------------------
// Rozpočtová brzda se láme na ZAČÁTKU kola, ještě než se cokoli udělá — to kolo
// se tedy nepočítá.
const roundsUsed = Math.min(budgetStopped ? round - 1 : round, MAX_ROUNDS)
return {
  done,
  converged: done,
  rounds: roundsUsed,
  exhausted: !done && !needsManualQa && !budgetStopped && !scopeCreep && round > MAX_ROUNDS,
  needsManualQa,
  envDead,
  envDeadReason: envDead ? (qa?.envRecoveryNote || qa?.report || null) : null,
  qaSkipped,
  budgetStopped,
  scopeCreep,
  qa: qa?.verdict ?? null,
  qaFailKind: qa?.verdict === 'FAIL' ? (qa?.failKind ?? null) : null,
  cr: cr?.verdict ?? null,
  changedFiles,
  plan,
  lastQaReport: qa?.report ?? null,
  lastQaScenario: qa?.scenario ?? null,
  lastCrComments: cr?.blockers ?? [],
  // Platné nálezy MIMO diff — nepatří do téhle smyčky, ale ať se neztratí.
  followUps,
}
