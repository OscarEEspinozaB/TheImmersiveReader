# The Immersive Reader — Servidor de Biblioteca Casero (Análisis y Diseño)

> Estado: **Diseño / futuro (Fase 2).** Redactado 2026-06-28. Es el split
> cliente/servidor que anticipa [CLAUDE.md](../CLAUDE.md) ("Fase 2") y el "no-objetivo"
> de sincronización en la nube de [docs/library-design.md](../docs/library-design.md),
> ahora promovido a objetivo. Acompaña a la biblioteca local actual
> ([src/library.js](../src/library.js)), al almacén de vocabulario
> ([src/vocabulary.js](../src/vocabulary.js)) y a la base de conocimiento del diccionario
> ([dictionary-knowledge-base-design-ES.md](dictionary-knowledge-base-design-ES.md)).
>
> Versión canónica en inglés:
> [home-library-server-design.md](home-library-server-design.md).

## 1. Objetivo

Convertir la app de un solo dispositivo en un **servidor de biblioteca digital casero**:
una máquina en la LAN de casa guarda los libros, las cuentas de usuario y los datos de
aprendizaje; cada dispositivo (laptop, celular) se conecta para subir libros al estante,
descargarlos y leer sin conexión, y mantener su **vocabulario y progreso de lectura
sincronizados**.

Importante: **esto no es solo un servidor de archivos**. El producto es una herramienta
para **leer en un idioma que no es el materno y registrar qué palabras ya conoces en ese
idioma**. Por eso el dato de primera clase del servidor no son los libros — es el
**vocabulario por usuario y por idioma de aprendizaje** y el **diccionario compartido**
que crece a medida que la gente lee. La biblioteca (almacenamiento, cuentas, control por
edad, subida/descarga) es la capa commodity alrededor de ese núcleo.

### Decisiones tomadas (2026-06-28)

| Pregunta | Decisión | Consecuencia |
| --- | --- | --- |
| Construir vs. integrar | **Servidor propio**, construido sobre nuestra KB del diccionario + modelo de libros + modelo de usuario | Control total; el dato único de inmersión es nativo del esquema, no añadido a la fuerza |
| Alcance de red | **Solo LAN de casa** | Modelo de amenaza mínimo; sin exposición a internet, sin TLS/CA público, auth ligera |
| Restricción de contenido | **Registro autoservicio con verificación** | Los usuarios se registran solos; un admin (padre/madre) aprueba y confirma el nivel de edad de cada cuenta |

## 2. Estado del arte (por qué no reinventamos las *ideas* de la capa de almacenamiento)

"Plex/Jellyfin para libros" ya existe y está maduro: **Kavita** (ebooks/cómic, rating de
edad por cuenta), **Calibre-Web** (ebooks, permisos por tag por usuario), **Komga**,
**Audiobookshelf**, el **content server de Calibre**. El estándar de intercambio de
catálogo entre un servidor y cualquier lector es **OPDS** (un feed tipo RSS de entradas de
libros). Las cuentas, la subida/descarga y la **restricción por edad por usuario son
problemas resueltos** allí — Kavita filtra el catálogo según el rating máximo de cada
cuenta de fábrica.

Aun así construimos servidor propio a propósito, porque nuestro diferencial (estado de
vocabulario por palabra + diccionario contextual + refinamiento con LLM, todo por idioma
de aprendizaje) tiene que ser nativo del modelo de datos — ninguno de esos servidores lo
guarda. Pero **tomamos prestados sus patrones probados** (catálogo filtrado por rating,
navegación/descarga con forma OPDS) en vez de inventar nuevos, y dejamos **la exportación
OPDS como un hito posterior** para que lectores genéricos también puedan consumir nuestra
biblioteca.

## 3. Arquitectura

```text
        LAN de casa (sin exposición a internet)
 ┌──────────────┐        ┌──────────────┐        ┌─────────────────────────┐
 │  Laptop      │        │  Celular     │        │  Servidor casero (1 caja)│
 │  Cliente TIR │  HTTP  │  Cliente TIR │  HTTP  │  ┌────────────────────┐  │
 │  (PWA)       │◄──────►│  (PWA)       │◄──────►│  │ API TIR (Node/TS)  │  │
 │  caché       │  /LAN  │  caché       │  /LAN  │  │  auth · libros ·   │  │
 │  IndexedDB   │        │  IndexedDB   │        │  │  vocab · progreso ·│  │
 └──────────────┘        └──────────────┘        │  │  diccionario KB    │  │
                                                 │  └─────────┬──────────┘  │
                                                 │     SQLite │  archivos/  │
                                                 │            │  blobs      │
                                                 │     ┌──────┴───────┐     │
                                                 │     │ Ollama (opc.)│     │
                                                 │     └──────────────┘     │
                                                 └─────────────────────────┘
```

- **Cliente = la app actual, sin cambios de fondo.** Sigue siendo una PWA offline-first.
  Su IndexedDB ([src/library.js](../src/library.js)) pasa a ser un **caché/espejo local**
  del servidor, así la lectura funciona sin conexión y sincroniza al volver a la LAN.
- **La ingesta se queda en el cliente.** Un PDF/EPUB se extrae y tokeniza igual que hoy; el
  cliente sube el **libro ya procesado** (el payload `.tir` planeado — texto limpio +
  imágenes ancladas), nunca el archivo fuente. Esto mantiene el servidor delgado y
  agnóstico al formato, y reutiliza el formato `.tir` de
  [docs/library-design.md](../docs/library-design.md) §5 como **formato de transporte**.
- **Servidor = autoridad delgada** para cuentas, almacén de libros, control por edad, y —
  la parte que importa — la **sincronización de vocabulario, progreso y el diccionario
  compartido**.

### 3a. Stack del servidor — recomendación: Node/TypeScript + SQLite

[CLAUDE.md](../CLAUDE.md) bosqueja la Fase 2 como Rust + PostgreSQL. Para una **caja única
en LAN de casa** este diseño recomienda **Node/TypeScript + SQLite (better-sqlite3)** en su
lugar, y expone el trade-off con honestidad:

- **El reuso de código es decisivo.** Todo el stack de ingesta/tokenización/normalización/
  contracciones ya es JavaScript (pdf.js, fflate, `tokenizer.js`, `normalize.js`,
  `contractions.js`). Si algo de eso alguna vez necesita correr en el servidor, Node lo
  reutiliza tal cual; Rust tendría que re-implementar una extracción al nivel de pdf.js.
- **SQLite, no Postgres.** Un hogar, un puñado de usuarios — SQLite es un solo archivo,
  cero-ops, respaldo trivial, y encaja con el espíritu del proyecto ("sin costo de servidor
  / iteración rápida"). Postgres solo se justifica a la escala multi-inquilino que
  explícitamente no tenemos en una LAN casera.
- **Cuándo reconsiderar Rust/Postgres:** si esto alguna vez sale de la LAN al internet
  público o crece más allá de una familia. No ahora.

## 4. Modelo de datos (SQLite)

```text
users
  id            uuid pk
  username      text unique
  password_hash text                 -- argon2id
  native_lang   text                 -- ej. "es"; nunca se pinta de rojo, nunca se rastrea
  birthdate     date                 -- declarada al registrarse; define el nivel de edad
  rating_tier   text                 -- máximo permitido confirmado: all|teen|mature|adult
  role          text                 -- admin | member
  status        text                 -- pending | active | disabled
  created_at    int

books
  id            uuid pk
  title         text
  author        text
  lang          text                 -- idioma de LECTURA del libro (idioma de aprendizaje)
  rating        text                 -- all|teen|mature|adult  (lo pone quien sube, el admin puede sobrescribir)
  uploader_id   uuid fk users
  added_at      int
  cover_path    text                 -- archivo de miniatura
  payload_path  text                 -- el .tir guardado (texto limpio + imágenes)
  -- visibilidad: filtro por rating + ACL de estante opcional (§6)

reading_progress                     -- por usuario, por libro (antes solo por libro)
  user_id       uuid fk
  book_id       uuid fk
  word_index    int
  updated_at    int
  pk (user_id, book_id)

vocabulary                           -- LA tabla núcleo: palabras conocidas por idioma de aprendizaje
  user_id       uuid fk
  lang          text                 -- idioma de aprendizaje, da scope a la palabra
  word          text                 -- normalizada (minúsculas, sin puntuación)
  state         text                 -- unknown | learning | known  (unknown no se guarda)
  updated_at    int                  -- para sincronización last-write-wins
  pk (user_id, lang, word)

dictionary                           -- base de conocimiento COMPARTIDA, crece para todos
  lang          text
  word          text
  payload       json                 -- acepciones, traducciones, sinónimos, campos refinados por IA
  source        text                 -- local | api | ai
  model         text                 -- qué modelo lo refinó (para re-refinar)
  updated_at    int
  pk (lang, word)
```

Por qué esta forma:

- **El vocabulario y el progreso ahora son por `user_id`**, no globales en un dispositivo.
  Esta es la razón entera de tener servidor: mis "palabras conocidas en inglés" me siguen de
  la laptop al celular. La clave `(user_id, lang, word)` preserva el invariante del producto
  — **la misma grafía en dos idiomas se mantiene independiente, y el idioma materno nunca se
  rastrea**.
- **El diccionario es compartido, con clave solo `(lang, word)`** — no por usuario. Una
  definición es contenido de referencia; que un lector refine *wand* beneficia a todos. Esto
  hace que valga la pena correr el servidor incluso para un solo usuario en varios
  dispositivos, y mucho más para una familia: el mar rojo se desvanece más rápido porque la
  KB crece de forma comunal. (Refleja el mismo keying por `<lang>:<word>` que ya existe en
  [src/definitionsCache.js](../src/definitionsCache.js)).

## 5. Cuentas, verificación de edad y modelo de amenaza

Registro autoservicio, pero **proporcional a "una caja en el WiFi de casa"** — no un SaaS
público.

- **Registro:** usuario + contraseña + `native_lang` + `birthdate`. La cuenta se crea con
  `status = pending`.
- **Verificación = aprobación del admin.** En una casa, el admin (padre/madre/dueño) *sabe*
  las edades reales, así que "verificación" es que el admin apruebe la cuenta pendiente y
  confirme su `rating_tier` (con valor por defecto derivado de `birthdate`). Esto reconcilia
  "autoservicio" (los usuarios se registran solos, eligen sus idiomas, sin alta manual) con
  un hogar (un adulto controla qué pueden alcanzar las cuentas de los niños). No hace falta
  flujo de email/SMS/identificación en una LAN.
- **Filtro de edad en cada lectura del catálogo:** `GET /books` devuelve solo las filas donde
  `book.rating <= user.rating_tier` (más cualquier ACL de estante). El filtro se aplica
  **en el servidor en cada request**, nunca ocultando cosas en el cliente.
- **Origen del rating del libro:** quien sube elige un rating al subir; un admin puede
  sobrescribirlo. Sin clasificación automática de contenido.

Modelo de amenaza (solo LAN):

- En alcance: un niño curioso intentando llegar a un libro de adultos; un segundo dispositivo
  del hogar; higiene básica de credenciales.
- **Fuera de alcance:** atacantes de internet, porque nada está expuesto. El servidor escucha
  solo en la interfaz de la LAN.
- Aun así, hacer lo barato y correcto: hashing de contraseñas con **argon2id**, tokens de
  sesión firmados (cookie HTTP-only o bearer), verificación de autorización en cada ruta
  protegida, y un **TLS autofirmado opcional** para la LAN (o HTTP plano en una red de casa
  confiable). El rate limiting y el bloqueo de cuentas son deseables, no críticos aquí.

## 6. Visibilidad / documentos restringidos

Dos mecanismos independientes, manteniéndolo simple:

1. **Rating de edad** (primario): el filtro `book.rating ≤ user.rating_tier` de arriba. Cubre
   "este documento no es para las cuentas de los niños".
2. **ACL de estante** (opcional, después): un libro puede pertenecer a un estante con nombre,
   y un estante puede restringirse a `user_id`s específicos (ej. un estante privado/personal).
   Por defecto: sin ACL, visible para quien pase el filtro de edad.

Esto se queda deliberadamente grueso — una casa, no una empresa. Permisos por tag por usuario
(estilo Calibre-Web) son un refinamiento posterior si alguna vez hace falta.

## 7. Modelo de sincronización (offline-first)

El cliente nunca se bloquea esperando la red. Lee y escribe en su caché de IndexedDB, luego
reconcilia con el servidor.

- **Vocabulario y progreso:** **last-write-wins por `updated_at`** por fila. Un `PATCH` lleva
  `{lang, word, state, updated_at}`; el servidor conserva el más nuevo. Un `GET
  /vocab?lang=&since=<ts>` periódico o al recuperar foco trae los cambios de otros dispositivos.
  Esto basta para una persona en dos dispositivos y para una familia donde las colisiones sobre
  la misma `(user, lang, word)` son raras.
- **Libros:** el contenido es inmutable una vez subido, así que sincronizar es trivial — listar,
  luego descargar cualquier `.tir` aún no cacheado. Los borrados se propagan como tombstones.
- **Diccionario KB:** compartido y en la práctica solo-añadir/refinar; traer `since` un timestamp.
  Un re-refinamiento con un modelo más fuerte (ya es una funcionalidad, ver git log: "allow
  re-refine with a stronger model") actualiza la fila compartida y se propaga en el siguiente pull.

## 8. Superficie de API (REST sobre la LAN)

```text
POST   /auth/register        {username, password, nativeLang, birthdate} -> cuenta pending
POST   /auth/login           {username, password} -> token de sesión
GET    /auth/me

GET    /books?lang=&q=        -> catálogo, filtrado por EDAD/ACL en el servidor
POST   /books                 -> sube .tir + metadata (multipart)   [member]
GET    /books/:id             -> metadata
GET    /books/:id/content     -> el payload .tir (descarga a caché)
GET    /books/:id/cover

GET    /progress             ?since=        PUT /progress/:bookId
GET    /vocab     ?lang=     &since=        PATCH /vocab            (palabra única)
                                            PUT   /vocab           (reconciliación masiva)
GET    /dictionary/:lang/:word              PUT  /dictionary/:lang/:word   (refinar)

# admin
GET    /admin/users          PATCH /admin/users/:id   (aprobar / fijar tier / deshabilitar)
PATCH  /admin/books/:id      (sobrescribir rating, estante/ACL)
```

## 9. Cómo mapea sobre el código actual

| Hoy (solo cliente) | Pasa a ser |
| --- | --- |
| Almacén de libros IndexedDB de [src/library.js](../src/library.js) | **Caché/espejo local** del catálogo del servidor; descargar = sigue aplicando el "extraer una vez" |
| Export/import `.tir` ([docs/library-design.md](../docs/library-design.md) §5) | El **formato de transporte** de subida/descarga — se construye una vez, se reutiliza |
| Almacén `<lang>:<word>` de [src/vocabulary.js](../src/vocabulary.js) | Gana una **capa de sincronización** hacia la tabla `vocabulary`; semántica sin cambios |
| [src/definitionsCache.js](../src/definitionsCache.js) | Respaldado por la tabla **`dictionary` compartida**; caché local por delante |
| Idioma de lectura activo de [src/settings.js](../src/settings.js) | Sin cambios — sigue por libro, en el cliente |
| `progressWordIndex` por libro | Se mueve a `reading_progress` **por usuario** |
| Dev server de Vite ([web-server-setup-ES.md](web-server-setup-ES.md)) | Sigue sirviendo el **cliente estático**; la nueva API es un proceso hermano |

El cliente sigue siendo una PWA estática servida como hoy; la API es un proceso Node aparte en
la misma caja. Nada de la UI de lectura/coloreado/marcado cambia.

## 10. Hitos

1. **Servidor delgado + cuentas.** Node/TS + SQLite, `/auth`, un solo admin, tabla `users`,
   argon2id, tokens de sesión. Escuchar solo en la LAN.
2. **Almacén de libros + descarga/subida.** `/books`, guardar `.tir`, el cliente navega el
   catálogo y descarga a su biblioteca local existente. (La biblioteca ahora tiene dos fuentes:
   importación local + servidor.)
3. **La sincronización núcleo.** Sincronizar `vocabulary` + `reading_progress` por usuario
   (last-write-wins). Este es el hito que entrega el valor real del producto entre dispositivos.
4. **Diccionario KB compartido** en el servidor; caché del cliente por delante; el re-refinamiento
   se propaga.
5. **Registro autoservicio + aprobación del admin + filtro de edad.** `birthdate` → `rating_tier`,
   filtro de catálogo por request, ratings de libros, cola de aprobación del admin.
6. **Pulido:** portadas, búsqueda, ACL de estante, respaldos (copiar un archivo SQLite + el
   directorio de blobs), y **exportación OPDS** para que lectores genéricos también consuman la
   biblioteca.

## 11. Preguntas abiertas / riesgos

- **Resolución de conflictos de vocabulario:** last-write-wins está bien para un usuario/muchos
  dispositivos; si dos miembros de la familia genuinamente compartieran una cuenta podría
  pisarse — pero el vocabulario es por `user_id`, así que no lo harían. Aceptamos LWW.
- **¿Quién clasifica un libro?** Quien sube elige, el admin sobrescribe. Sin automatización.
  Suficiente en casa.
- **Realismo de la "verificación" en LAN:** la aprobación del admin es la interpretación honesta;
  reconsiderar solo si esto sale de casa (entonces se vuelve la reescritura Rust/Postgres,
  expuesta a internet, con verificación real).
- **Crecimiento del almacenamiento:** los libros ilustrados son grandes; mostrar el uso total y
  permitir borrados (ya es pregunta abierta en
  [docs/library-design.md](../docs/library-design.md) §9), ahora del lado del servidor.
- **Respaldos:** documentar un respaldo de un comando (archivo SQLite + blobs) antes de que esto
  guarde la única copia del vocabulario de alguien.
```

