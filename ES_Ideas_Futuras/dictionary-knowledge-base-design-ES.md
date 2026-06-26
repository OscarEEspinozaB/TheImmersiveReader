# The Immersive Reader — Base de Conocimiento de Diccionario Personal (Diseño)

> Estado: **Propuesto.** Última actualización 2026-06-24.
>
> Se construye sobre la capa de definiciones existente (`definitionsCache.js`, la
> cadena de `DefinitionProvider`) y el patrón de formato de libro `.tir`
> (`library-design.md`). **No** reemplaza ninguno de los dos — agrega una nueva base
> de conocimiento indexada por idioma, generada una vez por palabra en lote, y leída
> en tiempo de ejecución sin ninguna llamada de red.

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
- Una base de datos relacional / un servidor SQL. `palabra → registro estructurado`
  no tiene joins que justifiquen el costo de un servidor; IndexedDB (más un archivo
  de exportación plano) alcanza a esta escala (decenas de miles de entradas × un
  puñado de idiomas son unos pocos MB).
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
