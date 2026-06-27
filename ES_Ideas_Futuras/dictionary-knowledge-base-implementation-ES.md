# The Immersive Reader — Base de Conocimiento de Diccionario (Plan de Implementación)

> Estado: **Propuesto (plan de implementación).** Última actualización 2026-06-26.
>
> Este es el *cómo* de [dictionary-knowledge-base-design-ES.md](dictionary-knowledge-base-design-ES.md)
> (el *qué/por qué*). Mapea cada parte de ese diseño sobre módulos concretos, firmas de
> funciones, cambios de almacenamiento y un orden de hitos que mantiene la app entregable
> en cada paso. Nada aquí cambia el estado de una palabra; la base de conocimiento (KB)
> es puramente *información sobre* palabras (ver el invariante del diseño).

## 0. Revisión 2026-06-26 — Implementación como servicio LAN (reemplaza §2, §4, §6 de abajo)

Según la **revisión §0 del diseño**, la KB ya no es un store IndexedDB en el navegador
manejado por un Web Worker. Es un **pequeño servicio Node en la LAN** respaldado por
**SQLite**, sembrado principalmente desde un **dump de Kaikki/Wiktextract** con Ollama
solo rellenando huecos, conexiones y traducciones. Las secciones debajo de esta
(IndexedDB v4 en §2, el Web Worker `generateWorker.js` en §4, la exportación `.tirdict`
desde IndexedDB en §6) quedan **reemplazadas** por esta sección; §1 (idioma del libro),
el reuso de `normalize()` de §3, §5 (procedencia/bloqueo — ahora columnas SQL) y el
*concepto* del camino de lectura de §7 siguen vigentes.

### 0.1 Layout del repo (nuevo `server/` de nivel superior)

```text
server/                      Servicio Node (corre en rakzo@zymbol, 192.168.100.6)
  index.js                   App Express: rutas + ciclo de vida
  db.js                      conexión better-sqlite3 + migraciones (esquema abajo)
  routes/define.js           GET /define  (read-through: SQLite → generar → guardar)
  routes/admin.js            POST /generate, /refine, /translate, GET /status
  ingest/kaikki.js           parsear en stream el JSONL de Wiktextract → filas
  generate/llm.js            cliente Ollama (rellenar definiciones, conexiones, traducir)
  generate/batch.js          pipeline nocturno: secuencial, reanudable, con guarda térmica
  generate/thermal.js        sondeo lm-sensors + guarda de pausa/reanudar
  shared/                    symlink/import de normalize() + lógica de lemas de src/
data/
  kaikki-en.jsonl            dump Wiktextract puesto por el usuario (gitignored, pesado)
  dictionary.sqlite          la KB (gitignored)
```

`server/` reutiliza el `normalize()` y las reglas de lema del frontend importando desde
`src/` directamente (mismo lenguaje = una sola fuente de verdad — la razón entera de
elegir Node). Agregar `better-sqlite3` y `express` a `package.json`; agregar `data/` a
`.gitignore`.

### 0.2 Esquema SQLite (`server/db.js`)

```sql
CREATE TABLE entries (
  id        TEXT PRIMARY KEY,      -- `${lang}:${word}`, ej. "en:run"
  lang      TEXT NOT NULL,
  word      TEXT NOT NULL,         -- lema normalizado (normalize() de src/)
  pos       TEXT,                  -- array JSON de categorías gramaticales
  schema_version INTEGER NOT NULL
);
CREATE INDEX idx_entries_lang ON entries(lang);

CREATE TABLE inflections (         -- indicaciones de tiempo verbal (de forms[] de Kaikki)
  entry_id TEXT NOT NULL REFERENCES entries(id),
  tag      TEXT NOT NULL,          -- "past" | "past participle" | "present participle" | ...
  form     TEXT NOT NULL,          -- "ran", "running", ...
  PRIMARY KEY (entry_id, tag, form)
);

CREATE TABLE senses (
  id        INTEGER PRIMARY KEY,
  entry_id  TEXT NOT NULL REFERENCES entries(id),
  definition TEXT NOT NULL,
  example    TEXT,                 -- ejemplo estándar (el del libro sigue a demanda)
  ord        INTEGER NOT NULL      -- orden del sentido
);

CREATE TABLE relations (           -- el grafo de "conexiones"
  from_sense INTEGER NOT NULL REFERENCES senses(id),
  to_word    TEXT NOT NULL,        -- lema destino normalizado (puede no existir aún como entry)
  type       TEXT NOT NULL,        -- "synonym" | "antonym" | "related"
  PRIMARY KEY (from_sense, to_word, type)
);

CREATE TABLE translations (        -- EN→ES ahora; abierto a N idiomas
  sense_id    INTEGER NOT NULL REFERENCES senses(id),
  target_lang TEXT NOT NULL,       -- "es", luego "ko", "fr", ...
  text        TEXT NOT NULL,
  PRIMARY KEY (sense_id, target_lang, text)
);

CREATE TABLE provenance (          -- diseño §5.2 / §8, ahora relacional
  entry_id   TEXT NOT NULL REFERENCES entries(id),
  field_path TEXT NOT NULL,        -- "senses.0.definition", "inflections", ...
  source     TEXT NOT NULL,        -- "offline-dataset" | "dictionary-api" | "ai" | "manual"
  source_name TEXT,                -- "Wiktextract 2026-xx" | "gemma4:e2b" | ...
  generated_at INTEGER NOT NULL,
  locked     INTEGER NOT NULL DEFAULT 0,   -- edición manual → 1, nunca se sobrescribe
  PRIMARY KEY (entry_id, field_path)
);

CREATE TABLE generation_progress ( -- reanudabilidad (diseño §7.4)
  lang   TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL, total INTEGER NOT NULL,
  status TEXT NOT NULL,            -- "running" | "paused" | "done" | "error"
  started_at INTEGER
);
```

### 0.3 API HTTP

```text
GET  /define?word=run&lang=en
     → 200 { entry }  si existe (cero cómputo)
     → en miss: generar una entrada (LLM o lookup del dump), guardar, devolverla
     → CORS: permitir los orígenes del lector (Vite dev + la IP LAN)
POST /admin/generate { lang }    → iniciar/reanudar el lote nocturno (responde de inmediato)
POST /admin/refine   { lang, model } → re-correr solo campos ai+desbloqueados (diseño §8)
POST /admin/translate { lang, target } → pase de translategemma para traducciones faltantes
GET  /admin/status               → { lang, cursor, total, status, lastTempC }
```

### 0.4 Pipeline de generación (`server/generate/batch.js`)

Secuencial, reanudable, con guarda térmica — el §7 del diseño con la cascada de §0.4:

1. **Sembrar desde Kaikki primero** (`ingest/kaikki.js`): leer `data/kaikki-en.jsonl`
   línea por línea (nunca cargarlo entero — es grande), y para cada lema que aparece en
   el conjunto de palabras únicas de la biblioteca, insertar `entries` + `senses`
   (glosas) + `inflections` (de `forms[]` con etiquetas de tiempo) + `relations`
   (sinónimos de Wiktextract). Procedencia `source = "offline-dataset"`. Esto **no** es
   trabajo de LLM y corre en minutos.
2. **Rellenar huecos con LLM** (`generate/llm.js`, `gemma4:e2b`): solo para palabras de
   la biblioteca *ausentes* del dump. Producir una definición estándar (sin contexto) +
   POS. Procedencia `source = "ai"`.
3. **Pase de conexiones** (`gemma4:e2b`): para entradas sin sinónimos, pedir palabras
   relacionadas al nivel del usuario; insertar `relations`.
4. **Pase de traducción** (`translategemma:12b`): por sentido sin traducción `es`,
   traducir; insertar en `translations(target_lang='es')`. Pase nocturno aparte.
5. **Reanudable + write-through:** commitear cada entrada de inmediato; actualizar
   `generation_progress` cada N palabras; al reiniciar saltar ids ya presentes.
6. **Guarda térmica** (`generate/thermal.js`): sondear `sensors` entre palabras; si
   `k10temp`/`amdgpu` > umbral, pausar hasta que enfríe. Correr el proceso bajo
   `nice -n 19 ionice -c3`.

### 0.5 Integración con el frontend (mínima)

Un solo proveedor nuevo en la cadena existente — la UI no cambia:

- `src/definitions/kbApi.js`: `lookupKB(word)` → `fetch(${KB_URL}/define?word=…&lang=…)`
  usando `getReadingLang()`; devuelve la misma forma `Definition`, `source: 'kb'`.
- Insertarlo **primero** en `getQuickDefinition` ([definitions/index.js](../src/definitions/index.js)),
  antes de `dictionaryapi.dev`. En un miss/host inalcanzable devuelve `null` y la cadena
  existente toma el control sin cambios — así el lector sigue funcionando fuera de la LAN.
- `KB_URL` es un ajuste nuevo (por defecto `http://192.168.100.6:PUERTO`), junto a la URL
  de Ollama en [settings.js](../src/settings.js).

### 0.6 Orden de hitos revisado

1. **Esqueleto de `server/`**: Express + `better-sqlite3` + esquema (§0.2) + `GET /define`
   que solo lee SQLite (404 en miss). Reusar `normalize()` de `src/`.
2. **Ingesta de Kaikki** (§0.4 paso 1): poner el dump, parsear, poblar entradas inglesas +
   flexiones + relaciones. Ahora `/define` devuelve datos reales para casi todas las palabras.
3. **Proveedor `kbApi.js` en el frontend** (§0.5): el lector lee desde la LAN, instantáneo
   y offline-de-IA.
4. **Rellenar huecos + conexiones con LLM** (`gemma4:e2b`), read-through en miss de
   `/define` + el lote nocturno `/admin/generate`, reanudable + guarda térmica.
5. **Procedencia + bloqueo + `/admin/refine`** (`gemma4:e4b`).
6. **Traducciones** (`translategemma:12b`, EN→ES) vía `/admin/translate`.
7. **Más idiomas**: agregar un `lang` + su dump de Kaikki/Wiktextract; el esquema ya es
   multilingüe.

Los pasos 1–3 entregan un diccionario inglés real, offline y compartido en la LAN con
tiempos verbales **sin nada de tiempo de LLM**. 4–7 agregan el valor exclusivo de IA
(huecos, conexiones, traducción).

---

> El resto de este documento (§0 "Cómo aterriza…" hasta §10) es el **plan original en el
> navegador**, conservado como referencia. Donde diga IndexedDB / Web Worker / exportación
> `.tirdict`, léelo a través de la revisión de arriba; la tabla de aterrizaje en el código
> (§0) y el trabajo de idioma del libro (§1) siguen válidos tal como están.

## 0. Cómo aterriza en el código actual

El diseño ya encaja con el código que tenemos. Concretamente:

| Concepto del diseño | Ya existe | Dónde |
| --- | --- | --- |
| Recolección de palabras únicas por libro | `uniqueWords(text)` | [src/deck.js](../src/deck.js#L25) |
| Modelo de lema (contracciones → partes, números ignorados) | `lemmasOf` | [src/deck.js](../src/deck.js#L17) |
| Clave de palabra normalizada | `normalize()` | [src/vocabulary.js](../src/vocabulary.js) |
| Cadena de proveedores a demanda (el respaldo que la KB conserva) | `getQuickDefinition`, cadena de proveedores | [src/definitions/index.js](../src/definitions/index.js) |
| Cache de definiciones por palabra | `definitionsCache.js` | [src/definitionsCache.js](../src/definitionsCache.js) |
| Helper de IndexedDB + stores versionados | `idb.js` (DB `immersive-reader`, v3) | [src/idb.js](../src/idb.js) |
| Listas de palabras por libro ya persistidas | store `bookwords` | [src/library.js](../src/library.js) |

Así que la implementación es sobre todo **nuevos stores + un worker + un camino de
lectura**, no una reescritura. Tres cosas NO deben cambiar de rol: `vocabulary.js`
(estado), `definitionsCache.js` (cache de respaldo a demanda) y la cadena de
proveedores existente.

## 1. Idioma del libro (el idioma fuente) — elegido por libro

La KB es multi-idioma y la biblioteca contiene muchos libros, así que el **idioma
fuente** — el idioma en que está escrito un libro, el que el usuario está aprendiendo —
**debe vivir en el libro, no en un ajuste global**. Hoy es un único `readingLang`
global en [settings.js](../src/settings.js#L29); eso se vuelve ambiguo en cuanto la
biblioteca mezcla una novela en inglés y una en español (¿bajo qué `lang` tokenizo /
indexo / busco?). Este es el prerrequisito que permite que un libro "comprenda su
propio diccionario base".

**Decisión (confirmada): el idioma se elige manualmente al importar** — un selector
requerido en el diálogo de importación, con opciones de `READING_LANGUAGES`
([settings.js](../src/settings.js#L12)). Sin auto-detección, sin dependencia nueva. El
`readingLang` global pasa a ser solo el *default pre-seleccionado* en ese selector.

### 1.1 Modelo de datos

- `BookMeta` ([library.js](../src/library.js#L12)) gana `lang: string` (código ISO,
  ej. `'en'`); `addBook({ title, text, ..., lang })` lo guarda.
- Migración: los libros existentes no tienen `lang`. Al cargar, rellenar con el
  `readingLang` global actual (default `'en'`); el valor queda editable desde los
  detalles del libro después. (El mismo patrón de relleno versionado que ya usa
  `bookwords`.)

### 1.2 Todo lo que depende del idioma lee `book.lang`, no el global

- **Tokenizer**: `tokenize(text)` hoy llama a `getReadingLang()` directo
  ([tokenizer.js](../src/tokenizer.js#L31)). Volverlo
  `tokenize(text, lang = getReadingLang())` y enhebrar el `lang` del libro abierto desde
  `main.js`. Esto además condiciona las **reglas de clíticos de contracción/posesivo
  solo-inglés** ([tokenizer.js](../src/tokenizer.js#L21)) — no deben dispararse en un
  libro en español o chino.
- **Claves de KB**: las entradas son `${book.lang}:${word}`. El worker de generación
  itera los libros e indexa las palabras de cada libro bajo *el lang de ese libro* — así
  un lote de biblioteca puede poblar `en:*` y `es:*` correctamente en una sola corrida.
- **Prompts**: `getReadingLangName()` ([prompts.js](../src/definitions/prompts.js#L38))
  deriva del lang del libro abierto.
- **Camino de lectura**: el popup busca `getEntry(book.lang, normalize(word))`.
- **El native language sigue global**: `settings.language` ('Spanish') es el idioma
  *del usuario* y maneja `translations[]` por acepción — es por-usuario, nunca
  por-libro.

### 1.3 Dos ejes de idioma, mantenidos separados

| Eje | Alcance | Maneja | Dónde |
| --- | --- | --- | --- |
| **Idioma fuente / del libro** | por **libro** (`BookMeta.lang`) | tokenizer, dataset offline, clave `lang` de KB, idioma de la definición | campo nuevo |
| **Native language** | por **usuario** (global) | `translations[]` por acepción, rescate a demanda | `settings.language` |

## 2. Cambios en IndexedDB (`src/idb.js`)

La DB es `immersive-reader`, hoy `DB_VERSION = 3` con stores
`['kv', 'books', 'content', 'bookwords']`. Subir a **v4** y agregar dos stores:

```js
const DB_VERSION = 4;
const STORES = ['kv', 'books', 'content', 'bookwords', 'dictionaryKB', 'generationProgress'];
```

`dictionaryKB` se indexa por `id` con la forma `${lang}:${word}`. Los helpers actuales
(`idbGet/idbGetAll/idbSet/idbDelete`) usan claves out-of-line (`put(value, key)`), lo
cual funciona, pero la KB necesita un **índice `byLang`** para "listar todas las
entradas `en`" sin recorrer todos los idiomas. Eso requiere:

- **Opción A (mínima):** mantener claves out-of-line, guardar `lang` en el valor, y
  filtrar `idbGetAll('dictionaryKB')` en memoria. Suficiente hasta decenas de miles de
  filas (la escala del diseño → unos pocos MB). Entregar esto primero.
- **Opción B (después):** dar a `dictionaryKB` un `keyPath: 'id'` inline y un índice
  real `index('byLang', 'lang')`. Necesita una pequeña rama `createObjectStore` en
  `onupgradeneeded`. Hacerlo solo si el perfilado muestra que el filtro en memoria
  duele.

Recomendación: **entregar la Opción A**, dejar una nota `// TODO: índice byLang
(Opción B)`. Un wrapper nuevo `kbdb.js` (abajo) oculta qué opción está activa para que
el camino de lectura nunca cambie.

## 3. Módulo nuevo: `src/dictionaryKB.js` (la API de lectura/escritura)

Una fachada delgada sobre el store `dictionaryKB`, para que el worker, el dashboard y
el swiper pasen todos por un solo lugar. Replicar la forma de `definitionsCache.js`.

```js
// src/dictionaryKB.js
import { idbGet, idbSet, idbGetAll, idbDelete } from './idb.js';

export const KB_SCHEMA_VERSION = 1;
const STORE = 'dictionaryKB';

export const kbId = (lang, word) => `${lang}:${word}`;

/** @returns {Promise<DictionaryEntry|null>} */
export async function getEntry(lang, word) {
  return (await idbGet(STORE, kbId(lang, word))) || null;
}

/** Commit write-through de una entrada (lo usa el generador y las ediciones manuales). */
export async function putEntry(entry) {
  entry.schemaVersion = KB_SCHEMA_VERSION;
  await idbSet(STORE, entry.id, entry);
}

/** Todas las entradas de un idioma (Opción A: filtro en memoria). */
export async function listByLang(lang) {
  const all = await idbGetAll(STORE);
  return all.filter((e) => e.lang === lang);
}

/** Setea un campo + estampa procedencia; las ediciones manuales bloquean el campo para siempre. */
export async function setField(lang, word, fieldPath, value, prov) {
  const entry = (await getEntry(lang, word)) || newEntry(lang, word);
  setDeep(entry, fieldPath, value);
  entry.provenance[fieldPath] = {
    source: prov.source, sourceName: prov.sourceName,
    generatedAt: Date.now(),
    locked: prov.source === 'manual' ? true : entry.provenance[fieldPath]?.locked || false,
  };
  await putEntry(entry);
  return entry;
}
```

`DictionaryEntry` es exactamente la forma del §5.1 del diseño. `newEntry`, `setDeep` y
los typedefs JSDoc viven aquí también. **Este módulo es la única superficie de import**
que usa el resto de la app — nadie más le habla directo al store `dictionaryKB`.

## 4. El worker de generación: `src/kb/generateWorker.js`

Un Web Worker real (requisito duro del §7.3 del diseño — un lote de toda la biblioteca
contra Ollama es de varias horas y nunca debe bloquear el hilo principal). Vite soporta
`new Worker(new URL('./kb/generateWorker.js', import.meta.url), { type: 'module' })`.

Pipeline dentro del worker, según el §7 del diseño:

1. **Recolectar vocabulario.** Reusar `uniqueWords(text)` sobre el contenido de cada
   libro (`getBookContent`), unirlo en un `Set`. El manejo de números/partes-de-
   contracción ya es correcto en `lemmasOf` — no reimplementarlo.
2. **Cascada de fuentes por palabra** (secuencial, nunca en paralelo contra Ollama):
   - dataset offline (si hay un dump cargado) → `dictionaryapi.dev` → Ollama.
   - El código de llamada a Ollama y a la API de diccionario ya existe en
     `src/definitions/`; extraer el `fetch` puro para que el worker lo importe sin el
     pegamento de UI, O que el worker haga `postMessage` de las consultas al hilo
     principal si importar `ollama.js` en el worker resulta incómodo (hace `fetch`
     plano, así que debería importar limpio — preferir el import directo).
   - Estampar `provenance[fieldPath]` con la fuente que realmente respondió.
3. **Write-through:** `await putEntry(entry)` inmediatamente tras cada palabra, para que
   un lote aún en curso ya beneficie al lector.
4. **Reanudable:** cada N palabras (ej. 25, igual que `DICT_CHUNK`), escribir
   `generationProgress` `{ lang, cursor, total, done, startedAt, status }`. Al
   (re)iniciar, leerlo y saltar ids ya presentes (`getEntry` con hit → saltar).
5. **Mensajes:** worker → main `{ type: 'progress', done, total }` para una barra de
   progreso; `{ type: 'done' }`; `{ type: 'error', word, message }`.

Un controlador en el hilo principal `src/kb/generation.js` maneja el ciclo de vida del
worker (start/pause/resume/cancel) y expone el progreso al dashboard.

### Oración fuente para desambiguar acepciones

El diseño quiere `senses[].exampleSentence` sacado del libro real. Ya construimos
lookups de oraciones: `buildSentenceLookup(text, tokens)` en
[src/sentences.js](../src/sentences.js), usado por `buildDeck`. El worker puede
reusarlo para adjuntar una oración de ejemplo real (y `sourceBook`) a la acepción que
le pide desambiguar a Ollama — sin lógica de extracción nueva.

## 5. Procedencia y bloqueo (diseño §5.2, §8)

Implementado enteramente dentro de `dictionaryKB.setField` (arriba):

- Cualquier edición de UI llama `setField(..., { source: 'manual' })` → setea
  `locked: true`, permanentemente.
- Un **pase de re-refinamiento** es solo el worker de generación corrido en
  `mode: 'refine'`: por cada entrada existente, regenerar solo los campos donde
  `provenance[path].source === 'ai' && !provenance[path].locked`, reemplazando
  `sourceName`/`generatedAt`, nunca un campo bloqueado.
- `KB_SCHEMA_VERSION` en cada entrada → migración por lote al cargar, el mismo patrón
  que `vocabulary.js` ya usa para su migración `{state, at}` (§5 del doc del dashboard).

## 6. Paquete portable `.tirdict` (diseño §6.2)

Replicar el patrón del paquete de libro `.tir` (`library-design.md`). `fflate` ya es la
dependencia de zip del proyecto (usada por el ingestor de EPUB).

- **Exportar** `src/kb/tirdict.js#exportLang(lang)`: streamear `listByLang(lang)` a
  `entries.ndjson` (un `JSON.stringify(entry)` por línea) + un `manifest.json`
  (`{ format: 'tirdict', lang, schemaVersion, wordCount, generatorModel, builtAt }`),
  zip con fflate, disparar una descarga `en.tirdict`.
- **Importar** `importTirdict(file, { merge })`: descomprimir, leer `entries.ndjson`
  línea por línea, `putEntry` cada una. Si `merge` (pregunta abierta §12 del diseño):
  para un id existente, rellenar huecos y actualizar solo campos **no bloqueados**;
  nunca pisar los bloqueados. Si no es merge: reemplazar por completo ese idioma.
- Nunca cargar el ndjson entero en memoria — leer incrementalmente (importa con 20k+
  filas).

Un archivo por idioma para que compartir/actualizar un idioma no toque los demás.

## 7. Camino de lectura / consumo (diseño §4, §10)

Cero red para cualquier palabra en la KB. Tres consumidores, todos de solo lectura:

- **Popup del lector** ([src/popup.js](../src/popup.js)): antes de pegarle a la cadena
  de proveedores, intentar `getEntry(activeLang, normalize(word))`. Con hit, renderizar
  sinónimos/antónimos/traducciones por acepción desde la KB. Con miss, caer a la cadena
  a demanda **sin cambios**. Este es el único cambio de comportamiento que el usuario
  siente: definiciones instantáneas y offline.
- **Pestaña Dictionary** ([src/dashboard.js](../src/dashboard.js)): ver el doc compañero
  [dictionary-ui-redesign-ES.md](dictionary-ui-redesign-ES.md). Mostrar los campos de la
  KB y un ícono de pin en los campos bloqueados; agregar un selector de idioma.
- **Word Swiper** ([src/swiper.js](../src/swiper.js), `deck.js`): opcionalmente leer el
  `senses[].exampleSentence` de una entrada de la KB en vez de re-derivarlo — puramente
  aditivo.

`activeLang` por defecto es `en`; el registro de idiomas (§5.3 del diseño) es una
pequeña tabla estática en un nuevo `src/kb/languages.js` (`LanguageAdapter[]`). Inglés
es el único adaptador `active` al principio.

## 8. Orden de hitos (entregable en cada paso)

Mapea el §11 del diseño sobre pasos del tamaño de un PR:

0. **Idioma del libro (§1).** Agregar `BookMeta.lang`, un selector de idioma requerido
   en el diálogo de importación (default = `readingLang` global), rellenar libros
   existentes, y enhebrar `book.lang` en `tokenize`. Prerrequisito para indexar la KB
   correctamente; chico y entregable de forma independiente.
1. **Stores + fachada.** `idb.js` → v4 + dos stores; `dictionaryKB.js` con
   get/put/listByLang/setField + typedefs. Sin UI todavía. (Pura plomería, sin cambio
   visible — seguro de aterrizar primero.)
2. **Generador por lote en inglés.** `kb/generateWorker.js` + `kb/generation.js`
   (dataset-offline-opcional → dictionaryapi.dev → Ollama), write-through, reanudable
   vía `generationProgress`. Un botón "Generar KB" solo-dev para manejarlo.
3. **Camino de lectura en el popup.** Hit de KB → render offline; miss → cadena
   existente. Aquí es cuando el feature empieza a rendir.
4. **Export/import `.tirdict`** (fflate, ndjson streameado, merge opcional).
5. **Procedencia + bloqueo + acción de re-refinamiento** (worker `mode: 'refine'`).
6. **Adaptador de español** (`es`): traducciones por acepción vía Ollama; el selector de
   idioma se vuelve significativo.
7. **Coreano + mandarín** (trabajo de tokenizador — `Intl.Segmenter` no alcanza para
   chino; cargar un segmentador WASM de forma perezosa por adaptador). **Klingon** queda
   solo-curación.

Los pasos 1–3 entregan la promesa central (diccionario completo offline para inglés).
4–7 son valiosos de forma independiente y se pueden reordenar según lo que el usuario
quiera después.

## 9. Riesgos / decisiones a confirmar (diseño §12)

- **Distribución de datasets:** empaquetar dumps de WordNet/Wiktextract en el repo
  (pesado) vs. arrastrar-y-soltar una vez y parsear localmente. **Recomendación:**
  arrastrar-y-soltar + parsear en la KB en un worker; mantiene el repo liviano y encaja
  con la meta de "poseído localmente".
- **Índice `byLang`:** Opción A (filtro en memoria) primero; promover a índice real solo
  si el perfilado lo exige.
- **Granularidad de re-refinamiento:** empezar por idioma; agregar selección por
  palabra/acepción después si el pase todo-o-nada se siente muy tosco.
- **Import de `ollama.js` en el worker:** confirmar que importa limpio en un worker de
  módulo (es `fetch` plano, así que debería). Si se cuela un import solo-de-UI, extraer
  primero la petición pura a `definitions/ollama.js`.

## 10. Fuera de alcance (sin cambios respecto a los no-objetivos del diseño)

Sin servicio de traducción automática en vivo, sin servidor SQL, sin promesa de
completitud por idioma. La KB aumenta; la cadena de proveedores a demanda sigue siendo
la red de seguridad para lo que aún no se haya generado.
