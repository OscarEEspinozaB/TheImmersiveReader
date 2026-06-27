# The Immersive Reader — Base de Conocimiento de Diccionario Personal (Diseño)

> Estado: **Propuesto.** Última actualización 2026-06-26.
>
> Se construye sobre la capa de definiciones existente (`definitionsCache.js`, la
> cadena de `DefinitionProvider`) y el patrón de formato de libro `.tir`
> (`library-design.md`). **No** reemplaza ninguno de los dos — agrega una nueva base
> de conocimiento indexada por idioma, generada una vez por palabra en lote, y leída
> en tiempo de ejecución sin ninguna llamada de red.

## 0. Revisión 2026-06-26 — Arquitectura de servicio LAN (reemplaza partes de §3, §6, §7)

Tras una revisión de hardware y requisitos con el dueño, tres decisiones de
arquitectura **reemplazan** partes del diseño original de abajo. Los objetivos (§2),
el modelo de procedencia/bloqueo por campo (§5.2), el registro de idiomas (§5.3) y el
chequeo de realidad por idioma (§9) **no cambian**. Lo que cambia es *dónde* vive la
KB, *cómo* se almacena y *qué fuente lidera* la cascada.

### 0.1 Realidad del hardware (manda en todas las decisiones)

La máquina generadora es `rakzo@zymbol`: **AMD Ryzen 7 4800H** (16 hilos), GPU
discreta **AMD Radeon RX 5500M** (**4 GB de VRAM**, Navi 14 / gfx1012), 15 GB RAM,
Debian 13.

- **Ollama corre en CPU aquí, no en GPU.** ROCm no soporta oficialmente gfx1012, y 4 GB
  de VRAM no pueden cargar un modelo de 7–9 GB de todos modos. La inferencia queda
  limitada por la CPU Ryzen: de forma realista **~10–25 s por entrada de diccionario**.
  Generar *cada* palabra con el LLM tomaría muchas noches — esta es la restricción que
  rediseña §7.
- **Guarda de temperatura/procesos:** el monitoreo usa **`lm-sensors`** (`k10temp` para
  la CPU, `amdgpu` para la GPU), no `nvidia-smi`. El job nocturno corre bajo
  `nice`/`ionice`, duerme entre palabras, y se pausa si se cruza un umbral de
  temperatura (ej. 80 °C).

### 0.2 Revisión 1 — Un servicio local en la LAN, no IndexedDB + Worker en el navegador

La KB pasa de un store IndexedDB en el navegador + Web Worker a un **pequeño servicio
local en la LAN** (la máquina generadora en `192.168.100.6`). Razón:

- **Compartir entre dispositivos gratis.** IndexedDB vive *dentro de un navegador* y no
  se sincroniza; el diseño original necesitaba exportar/importar `.tirdict` a mano para
  llegar a un teléfono o laptop. Un endpoint LAN permite que la máquina potente genere
  una vez y todos los dispositivos de la red lean la misma KB. Este es el requisito
  principal del usuario.
- **Una sola fuente de verdad para la normalización.** La KB se indexa `<lang>:<word>`
  usando exactamente el mismo `normalize()` que [vocabulary.js](../src/vocabulary.js).
  El servicio se escribe en **Node** justamente para poder importar esa única
  implementación; otro lenguaje (Python/Rust) reimplementaría la normalización y
  arriesgaría desajustes de clave que romperían en silencio cada acierto de caché.
- **Read-through, perezoso-luego-lote.** La primera solicitud de una palabra
  desconocida dispara la generación, la guarda y la devuelve; las siguientes la
  devuelven desde el store con cero cómputo. Un lote nocturno rellena la cola larga.
  (Ambos comportamientos ya estaban en §7; ahora corren del lado del servidor.)

Este es el backend "Fase 2" documentado del diseño llegando temprano, pero en su forma
mínima: un caché read-through de un solo usuario, no un servidor multiusuario.

### 0.3 Revisión 2 — SQLite (`better-sqlite3`), no IndexedDB / NDJSON

El no-objetivo "sin BD relacional" de **§3 se retira para la capa de servicio.** Se
escribió bajo el supuesto de IndexedDB en el navegador. Ahora que la KB es un servicio
LAN *y* los requisitos crecieron para incluir **conexiones palabra↔palabra**
(sinónimos/relacionadas) y **traducciones por-sentido entre idiomas**, los datos *son*
un pequeño grafo relacional. SQLite (`better-sqlite3`, síncrono, un solo archivo,
trivial de respaldar) encaja mucho mejor que JSON plano — y alinea con el CLAUDE.md,
que ya nombra SQLite como la tecnología de almacenamiento (solo que ahora nativo del
lado servidor en vez de WASM en el navegador). La exportación portable `.tirdict`
(§6.2) sobrevive como un dump de SQLite / exportación NDJSON.

### 0.4 Revisión 3 — El dataset offline (Kaikki/Wiktextract) lidera; el LLM solo rellena huecos

La cascada de §7 se mantiene (dataset offline → API gratuita → Ollama) pero su
**énfasis se invierte**: como la inferencia en CPU es el recurso escaso, el grueso
**no debe** venir del LLM.

- **Definiciones + categoría gramatical + flexiones de tiempo verbal** vienen de un
  dump JSON inglés de **Kaikki.org / Wiktextract** (Wiktionary, legible por máquina).
  Sus `forms[]` traen etiquetas de tiempo (`past`, `past participle`,
  `present participle`, `third-person singular`), cumpliendo el nuevo requisito de
  "indicaciones de tiempos verbales" *de forma determinista y precisa* — mejor de lo
  que podría un LLM.
- **El LLM (Ollama) se reserva para** palabras ausentes del dump (jerga, neologismos del
  universo como *Quidditch*/*Muggle*), la capa de **conexiones** (sinónimos/relacionadas
  al nivel del usuario) y las **traducciones EN→ES**.
- Esto recorta el lote del LLM de decenas de miles de palabras a cientos/pocos miles —
  la diferencia entre una noche y varias semanas en esta CPU.

### 0.5 Nuevos requisitos capturados

- **Diccionario genérico** (significado estándar tipo Oxford/Cambridge), *no* la
  explicación del contexto del libro — la explicación según contexto sigue siendo el
  camino a demanda en [ollama.js](../src/definitions/ollama.js). El significado estándar
  es 100% cacheable y se deduplica entre libros.
- **Indicaciones de tiempos verbales** → `inflections` (de los `forms[]` de Kaikki).
- **"Diccionario mejorado con conexiones"** → un grafo de relaciones (sinónimos/relacionadas).
- **Traducciones**, EN→ES primero, **esquema abierto a N idiomas** → una tabla
  `translations` indexada por `target_lang`.

### 0.6 Asignación de modelos (del `ollama list` del dueño)

| Modelo | Rol |
| --- | --- |
| `gemma4:e2b` | Grueso del LLM: rellenar huecos + conexiones (suficientemente rápido en CPU) |
| `gemma4:e4b` | Pase posterior de "re-refinar" sobre entradas difíciles/vacías (diseño §8) |
| `translategemma:12b` | Traducciones EN→ES (hecho para esto); un pase nocturno aparte |
| `codegemma:7b` | No usado por la KB |

La disposición concreta del servicio, el esquema SQL, el parser de Kaikki, la API y el
orden de hitos viven en el [plan de implementación](dictionary-knowledge-base-implementation-ES.md)
acompañante, que se actualizó para coincidir con esta revisión.

## 1. Contexto

El lector ya obtiene definiciones *a demanda*, una palabra a la vez, con una cadena
de proveedores (cache → dictionaryapi.dev → Ollama). Ese es el diseño correcto para
una sola consulta, pero no es lo que se pide aquí: un **diccionario personal
completo**, que cubra todo el vocabulario de Harry Potter (decenas de miles de lemas
únicos a lo largo de los 7 libros), generado principalmente por IA y datos
lingüísticos offline, **almacenado y poseído localmente**, sin dependencia recurrente
de ninguna API externa.

Un segundo requisito cambia la forma del diseño: esto tiene que seguir siendo útil a
medida que el usuario aprenda más idiomas (español primero, luego coreano, mandarín,
eventualmente el pIqaD klingon). El esquema necesita ser abierto por construcción, no
con forma de inglés y el español pegado encima.

Un tercer requisito: los modelos de IA van a seguir mejorando y abaratándose. El
usuario quiere poder **volver a correr la generación más adelante con un modelo más
fuerte** y que eso *mejore* la base de conocimiento — sin destruir nada que haya
corregido o curado a mano. Eso significa que cada campo necesita saber de dónde vino
y si está protegido.

## 2. Objetivos

- **Generar en lote** una entrada completa para cada palabra única de toda la
  biblioteca, por idioma de destino — una sola vez, no en cada vuelta de página.
- **Cero llamadas de red en tiempo de ejecución** para cualquier palabra que ya esté
  en la base de conocimiento. La cadena de proveedores a demanda existente se
  mantiene, pero solo como respaldo para palabras que de verdad todavía no están en
  la base (ej. un libro nuevo recién agregado).
- **Almacenamiento local primero** (IndexedDB) más un **paquete exportable
  portable**, para que la base se pueda generar una sola vez (ej. en una máquina de
  casa que ya corre Ollama) y llevarse a cualquier otro dispositivo — celular,
  laptop — sin recalcular nada.
- **Esquema de idiomas abierto**: agregar coreano o klingon más adelante significa
  agregar un adaptador y una fila en una tabla, no rediseñar el modelo de datos.
- **Re-refinable con el tiempo**: un modelo futuro, mejor o más barato, puede
  regenerar los campos generados por IA, mientras que los campos editados por el
  usuario ("bloqueados") nunca se tocan.
- **Procedencia en cada campo**: saber siempre si una definición vino de un
  diccionario offline real, de una API gratuita, de un LLM, o del propio usuario.

## 3. No-objetivos

- Un servicio de traducción automática *en vivo*. La traducción para palabras fuera
  de la base pre-generada sigue pasando por Ollama a demanda, como ya está diseñado.
- ~~Una base de datos relacional / un servidor SQL.~~ **Retirado por §0.3.** Esto valía
  bajo el supuesto de IndexedDB en el navegador; una vez que la KB pasó a ser un
  servicio LAN con conexiones palabra↔palabra y traducciones por-sentido, SQLite
  (`better-sqlite3`) resultó ser lo correcto. (Sigue sin haber servidor SQL
  *multiusuario* — se mantiene de un solo usuario, local.)
- Prometer completitud para cada idioma. Algunos (klingon, ver §9) hoy no tienen
  ningún dataset abierto utilizable — la brecha se reconoce, no se esconde detrás de
  un genérico "la IA lo va a resolver".

## 4. Arquitectura de dos capas

```text
GENERACIÓN (offline, en lote, puede tardar horas, reanudable)
  Palabras únicas de toda la biblioteca  (por idioma)
        │
        ▼
  Cascada de fuentes por palabra  (dataset offline → API gratuita → Ollama)
        │
        ▼
  dictionaryKB  (IndexedDB)  ──exporta──▶  paquete .tirdict (portable)

CONSUMO (en tiempo de ejecución, instantáneo, sin red)
  Popup del lector / pestaña Dictionary / Word Swiper
        │  consulta de solo lectura
        ▼
  dictionaryKB
        │  falla (palabra aún no generada para este idioma)
        ▼
  cadena de DefinitionProvider a demanda existente (sin cambios, sigue siendo el respaldo)
```

La lógica de estado de palabra del lector (`vocabulary.js`) no se toca con este
diseño: la base de conocimiento provee *información sobre* una palabra, nunca su
estado known/learning/unknown — exactamente igual al invariante existente ("el
estado nunca cambia automáticamente").

## 5. Modelo de datos

### 5.1 Forma de una entrada (por palabra, por idioma)

```text
DictionaryEntry = {
  id: string                  // `${lang}:${normalizedWord}`, ej. "en:wand"
  lang: string                 // código ISO 639 — abierto, ver §5.3
  word: string                  // lema normalizado
  displayForm?: string           // forma de superficie para mostrar (ej. Hanzi + pinyin)
  pos?: string[]                  // una o más categorías gramaticales

  senses: [{
    id: string
    definition: string
    exampleSentence?: string       // tomada del libro real, cuando está disponible
    sourceBook?: string
    synonyms?: string[]
    antonyms?: string[]
    translations?: { lang: string, text: string }[]   // por sentido, no un campo
                                                        // global único — "bank" (río)
                                                        // vs "bank" (banco) necesitan
                                                        // palabras distintas en español
  }]

  notes?: string                  // libre: etimología, uso, notas personales

  provenance: {
    // una entrada por cada ruta de campo que se haya establecido,
    // ej. "senses.0.definition"
    [fieldPath: string]: {
      source: "offline-dataset" | "dictionary-api" | "ai" | "manual"
      sourceName?: string           // "WordNet 3.1" | "CC-CEDICT" | "gemma3:4b" | ...
      generatedAt: number
      locked?: boolean               // true una vez que el usuario lo edita directamente —
                                       // un campo bloqueado nunca se sobrescribe
                                       // automáticamente en una pasada de refinamiento
                                       // posterior
    }
  }

  schemaVersion: number
}
```

Las traducciones por sentido (en vez de un único arreglo `translations` plano en la
entrada) es la decisión deliberadamente opinada acá: un diccionario personal solo
sirve si desambigua sentidos, y eso es exactamente lo que un modelo consciente del
contexto puede hacer y una lista bilingüe genérica no puede.

### 5.2 Procedencia y bloqueo a nivel de campo

Esto es lo que hace seguro "volver a correr con un modelo más inteligente más
adelante":

- Una pasada de refinamiento solo toca campos cuyo
  `provenance[campo].source === "ai"` **y** cuyo `locked` no sea `true`.
- Editar cualquier campo en cualquier parte de la app pone `source: "manual"` y
  `locked: true` en ese campo — protegiéndolo permanentemente de la regeneración
  automática.
- `sourceName` registra qué modelo/dataset lo produjo, así el usuario puede más
  adelante pedir "muéstrame todo lo que sigue generado por el modelo chico viejo" y
  refinar selectivamente solo eso.

### 5.3 Registro de idiomas (abierto por diseño)

Agregar un idioma es "implementar un adaptador, agregar una fila" — no un cambio de
esquema.

El idioma fuente de una palabra es **una propiedad del libro del que viene**, no un
ajuste global: cada libro lleva su propio `lang`, elegido manualmente al importar, y eso
es lo que indexa sus entradas de KB (`${lang}:${word}`), selecciona su tokenizer y elige
su dataset offline. El native language del usuario (para las `translations` por
acepción) queda como un ajuste separado, por-usuario. Ver el §1 del plan de
implementación (idioma del libro) para los detalles del modelo de datos e integración.

| Código (ISO 639) | Idioma | Estado del tokenizador | Estado |
| --- | --- | --- | --- |
| `en` | Inglés | `Intl.Segmenter` — listo hoy | **Activo** |
| `es` | Español | `Intl.Segmenter` — listo hoy | Planeado (siguiente) |
| `ko` | Coreano | `Intl.Segmenter` maneja los límites razonablemente; la aglutinación necesita revisión | Planeado |
| `cmn` (a menudo etiquetado `zh`) | Mandarín | `Intl.Segmenter` **no** hace segmentación real de palabras en chino — necesita un segmentador dedicado | Planeado |
| `tlh` | Klingon (pIqaD) | Sin soporte de `Intl.Segmenter`; necesita un tokenizador custom consciente de afijos | Experimental / solo curación |
| *(código futuro)* | *(idioma futuro)* | *(implementar adaptador)* | Planeado |

Un **adaptador de idioma** es el contrato mínimo que necesita implementar una fila
nueva:

```text
LanguageAdapter = {
  code: string                          // ISO 639-1/2/3
  name: string
  tokenizer: "intl-segmenter" | "custom" // qué módulo tokenizador cargar
  offlineSource?: { name, format, url, license }  // ver §9 por idioma
  status: "active" | "planned" | "curation-only"
}
```

## 6. Almacenamiento

### 6.1 Store `dictionaryKB` en IndexedDB

```text
IndexedDB "immersive-reader"
  store "dictionaryKB"   (indexado por id = `${lang}:${word}`)
    → DictionaryEntry (§5.1)
    índice "byLang"  sobre `lang`
  store "generationProgress"   (pequeño, una fila por trabajo de lote en curso)
    { lang, cursor, total, done, startedAt, status: "running"|"paused"|"done"|"error" }
```

Se mantiene como un store **propio**, separado de `definitionsCache` (que se queda
como la cache/respaldo liviano a demanda) y de `vocabulary` (que se queda como el
estado autoritativo de known/learning/unknown). Tres stores, tres responsabilidades,
sin superposición.

### 6.2 Paquete portable: `.tirdict`

Mismo patrón que el formato de libro `.tir`, para que la generación pueda pasar una
sola vez en una máquina capaz (ej. la que ya corre Ollama según el README) y
llevarse a cualquier otro dispositivo sin recalcular nada:

```text
en.tirdict  (zip)
  manifest.json    { format: "tirdict", lang: "en", schemaVersion, wordCount,
                     generatorModel, builtAt }
  entries.ndjson   una DictionaryEntry por línea (streamable — nunca cargar el
                     archivo completo en memoria de una sola vez; importa una vez
                     que esto sean 20k+ entradas)
```

Un archivo por idioma (`en.tirdict`, `es.tirdict`, …) en vez de un único archivo
combinado, para que actualizar o compartir un solo idioma no requiera tocar los
demás.

## 7. Pipeline de generación

1. **Recolectar el vocabulario.** Reutilizar las listas de palabras únicas por libro
   ya calculadas para las vistas de biblioteca/estadísticas — no se necesita lógica
   de extracción nueva.
2. **Por palabra, por idioma, correr la cascada de fuentes:**
   - **Dataset offline primero** (sin red, sin key): datos tipo WordNet para inglés,
     CC-CEDICT para mandarín, KRDICT para coreano (ver §9). Archivos provistos por el
     usuario, parseados una sola vez hacia la base.
   - **API gratuita sin key como respaldo** para huecos en inglés:
     `dictionaryapi.dev` (el respaldo no-IA ya usado en otras partes del proyecto).
   - **Ollama para todo lo demás**: desambiguación de sentido contra la oración real
     del libro, sinónimos/antónimos, traducción por sentido, y los neologismos del
     universo Harry Potter que ningún diccionario estándar tiene (*Quidditch*,
     *Muggle*, *Horcrux* — estos son por naturaleza solo-IA o solo-curación, ningún
     dataset los va a tener nunca).
   - Cada campo queda marcado con la procedencia de la fuente que realmente lo
     produjo.
3. **Correr en un Web Worker**, nunca en el hilo principal — un lote completo de la
   biblioteca contra un LLM local es un trabajo de varias horas.
4. **Reanudable por construcción**: `generationProgress` se escribe cada N palabras,
   así que cerrar una pestaña o reiniciar Ollama no pierde el trabajo ya hecho — la
   generación retoma desde el último cursor, no desde cero.
5. **Secuencial, no paralelo**, contra Ollama: un modelo local no se beneficia de
   peticiones en paralelo, solo agrega contención.
6. **Escritura inmediata**: cada entrada completada se confirma en `dictionaryKB` al
   instante, así el lector puede empezar a beneficiarse de un lote que todavía está
   corriendo, en vez de esperar a que termine todo.

## 8. Flujo de refinamiento (el requisito de "control + mejorar después")

- Una acción de **"Re-refinar con modelo X"**, que se puede acotar por idioma y/o
  tipo de campo, que vuelve a correr la generación **solo** sobre entradas donde
  `provenance[campo].source === "ai"` y `locked` no sea verdadero — reemplazando
  `sourceName`/`generatedAt`, sin tocar nunca un campo bloqueado.
- Cualquier edición manual (futura acción de edición en la pestaña Dictionary) pone
  `locked: true` en ese campo de forma permanente — las correcciones propias del
  usuario son lo único que el sistema nunca va a sobrescribir en silencio, sin
  importar cuán bueno sea el próximo modelo.
- `schemaVersion` en cada entrada habilita migraciones por lote de la misma forma en
  que el proyecto ya migra los datos de vocabulario/contracciones al cargar.

## 9. Chequeo de realidad por idioma

| Idioma | Fuente offline realista | Advertencia |
| --- | --- | --- |
| Inglés | WordNet / un dump de Wiktextract en inglés | Maduro, grande, gratis |
| Español | Un dump de Wiktextract / Wikcionario en español | Buena cobertura, gratis |
| Coreano | KRDICT (Instituto Nacional de la Lengua Coreana) | Gratis, estructurado, pero la aglutinación hace que la tokenización no sea trivial |
| Mandarín | CC-CEDICT | Gratis, hecho exactamente para esto; **el tokenizador es la brecha real** — necesita un segmentador chino dedicado, `Intl.Segmenter` no da límites de palabra reales aquí |
| Klingon (pIqaD) | **Ninguna estructurada/abierta.** Existen fuentes comunitarias (*The Klingon Dictionary*, boQwI') pero con derechos de redistribución poco claros | Esta es la excepción honesta: realísticamente, solo-curación o asistido-por-IA-con-baja-confianza en el futuro previsible — no es una brecha que "la IA simplemente va a resolver" |

Esta tabla es el artefacto vivo — agregar un idioma más adelante significa agregar
una fila aquí y un adaptador (§5.3), nada más cambia en la arquitectura.

## 10. Integración con los módulos existentes

- **`vocabulary.js`** — sin cambios. La base de conocimiento nunca establece el
  estado de una palabra.
- **`definitionsCache.js`** — sin cambios en su rol; sigue siendo el camino a
  demanda para cualquier palabra que aún no esté en `dictionaryKB` (un libro nuevo
  agregado después, o un idioma cuyo lote todavía no corrió).
- **`dashboard.js` (pestaña Dictionary)** — agregar un selector de idioma; cuando
  exista una entrada en la base, mostrar sus sinónimos/antónimos/traducciones por
  sentido junto al panorama dict/AI existente; mostrar un ícono de pin en los campos
  bloqueados (curados por el usuario).
- **`deck.js` / `images.js`** — sin afectar; opcionalmente pueden leer el
  `senses[].exampleSentence` de una entrada de la base en vez de re-derivar una
  oración de muestra.

## 11. Hitos

1. Esquema + store `dictionaryKB` + generador en lote solo-inglés (dataset offline
   → dictionaryapi.dev → Ollama), Web Worker, reanudable.
2. Exportación/importación `.tirdict` (zip vía fflate, ndjson en streaming).
3. Procedencia a nivel de campo + bloqueo + la acción de "re-refinar".
4. Adaptador español (traducciones por sentido pobladas vía Ollama).
5. Adaptadores coreano + mandarín (trabajo de tokenizador, cargadores de dataset
   offline).
6. Klingon — adaptador experimental, solo-curación; revisar si/cuando aparezca un
   dataset estructurado redistribuible.

## 12. Preguntas abiertas

- ¿Los dumps de datasets offline (WordNet, CC-CEDICT, KRDICT) vienen incluidos en el
  repo (pesado), o el usuario los arrastra una vez y se parsean localmente hacia la
  base?
- ¿La acción de "re-refinar" debería ser todo-o-nada por idioma, o seleccionable
  hasta el nivel de palabras/sentidos individuales?
- Tokenizadores de mandarín/coreano: ¿cargar un segmentador WASM de forma anticipada,
  o de forma diferida por adaptador de idioma, solo cuando ese idioma realmente se
  use?
- ¿Deberían los archivos `.tirdict` poder fusionarse (importar uno más nuevo llena
  huecos/actualiza campos no bloqueados en una base local existente) en vez de solo
  reemplazar todo?
