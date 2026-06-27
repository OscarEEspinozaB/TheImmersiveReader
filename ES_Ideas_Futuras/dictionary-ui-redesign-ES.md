# The Immersive Reader — Reestructuración de UI: Diccionario / Progreso

> Estado: **Implementado (2026-06-26).** Reemplaza el borrador anterior basado en pestañas
> (tarjetas clicables + chips *dentro* del dashboard de Vocabulary). La reestructuración es
> más profunda: **Diccionario y Progreso ahora son destinos hermanos de primer nivel** bajo
> una navegación principal persistente, no pestañas padre/hijo.
>
> Código: [src/dashboard.js](../src/dashboard.js), [src/main.js](../src/main.js),
> [index.html](../index.html), [src/styles/main.css](../src/styles/main.css). Es el
> complemento de cara al usuario de
> [dictionary-knowledge-base-implementation-ES.md](dictionary-knowledge-base-implementation-ES.md).

## 1. Por qué

Todo lo relacionado con "palabras" colgaba de **un solo icono de gráfica** que abría un único
`#dashboard` con **dos pestañas internas — Stats y Dictionary**. Eso mezclaba dos cosas
distintas:

- **Progreso** = el aprendizaje propio del usuario (conteos, crecimiento en el tiempo,
  desglose por libro).
- **Diccionario** = el contenido de referencia (palabra → definición / IA cacheada / futuro KB).

Anidar el Diccionario *dentro* de las estadísticas lo hacía sentir como un anexo de los
números, y llegar a una lista filtrada implicaba: abrir dashboard → cambiar de pestaña → abrir
un desplegable → elegir un estado. La solución es una separación real con navegación dedicada,
para que el Diccionario sea un lugar de primer nivel y los conteos sean la puerta de entrada.

## 2. Lo que se implementó

### 2a. Navegación principal (barra inferior persistente)

Un `#primary-nav` fijo abajo ([index.html](../index.html)) con tres destinos de primer nivel
— **Library · Dictionary · Progress** — cada uno un `button.nav-item` con icono sobre
etiqueta. Solo se muestra en las vistas "hub" y se **oculta al leer y en el swiper**
(inmersivas), vía una clase `body.nav-hidden` que alterna `setView`
([src/main.js](../src/main.js)), igual que el patrón existente `chrome-hidden`. El destino
activo se resalta. El antiguo icono de gráfica "Vocabulary" de la biblioteca desaparece.

```text
┌──────────────────────────────────────┐
│            (vista activa)            │
├──────────────────────────────────────┤
│   📚         📖          📈           │
│ Library   Dictionary  Progress       │
└──────────────────────────────────────┘
```

*Practice* (el swiper) sigue siendo una acción por libro lanzada desde la biblioteca; queda un
4.º hueco limpio en la nav para cuando exista un mazo global.

### 2b. Modelo de vistas

`setView(view)` ahora maneja `shelf | dictionary | progress | reader | swiper`. La única
sección `#dashboard` se reutiliza como contenedor compartido de ambas vistas hub (mismo
scroll/padding `.dashboard`; sus hijos directos comparten una columna centrada con
`max-width`). `main.js` expone `showProgress()` y `showDictionary(filter?)`; los botones de la
nav llaman a `showShelf`, `showDictionary()`, `showProgress`.

### 2c. Hub de Progreso — los conteos como puerta de entrada

`renderProgress(root, { onOpenDictionary })` ([src/dashboard.js](../src/dashboard.js))
dibuja las tarjetas de estadística, el donut, la gráfica de crecimiento y el desglose por
libro. Las tarjetas **Known y Learning son `<button>` reales** (`statCard(label, value,
onClick?)` → `button.stat-card--btn`) que **enlazan directo al Diccionario ya filtrado** vía
`onOpenDictionary('known'|'learning')`. Las tarjetas decorativas (Total, This week) siguen
siendo `<div>` inertes.

### 2d. Hub de Diccionario — controles mínimos

`renderDictionary(root, { filter })` reemplaza los dos desplegables `<select>` por:

- **chips de filtro** `All / Known / Learning` (`button.chip` con `aria-pressed`), sembrados
  desde el `filter` entrante para que al llegar desde una tarjeta se aterrice ya filtrado con
  el chip correcto activo — las dos superficies coinciden por construcción;
- un pequeño **toggle de orden** (`Recent ⇆ A–Z`) a la derecha del buscador.

```text
┌─────────────────────────────────────────────┐
│  🔍 Search words…                  [ Recent ]│
│  ( All )  ( Known )  ( Learning )            │  ← chip activo relleno
│  ───────────────────────────────────────────│
│  wand        learning                         │
│    a thin stick used for magic…               │
│  owl         known                            │
└─────────────────────────────────────────────┘
```

La lógica de lista con ventana (`renderList`, `IntersectionObserver`,
`renderChunk`/`unloadChunk`, `dictRow`, `lookupCard`) queda intacta — ya lee
`state.filter / search / sort`. Un `dictState` a nivel de módulo conserva búsqueda/orden/filtro
entre cambios de hub. El `<select>` de estado por fila se aligera a un chip sin borde (borde al
hover/focus).

### 2e. Alcance por idioma (cada idioma es su propio diccionario)

El vocabulario y las definiciones se indexan por idioma de lectura (`<lang>:<word>`), así que
**cada idioma es un diccionario y un progreso separados — nunca mezclados**. Ambos hubs están
acotados a un solo idioma y llevan un **selector de idioma** (`langSwitcher` en
[src/dashboard.js](../src/dashboard.js)) arriba: un `select` que lista cada idioma con palabras
marcadas (más el que se está viendo). Como el idioma de lectura ahora es una propiedad por
libro, este cambio vive **en la UI, no en configuración**. Al cambiarlo se fija `dashLang`, se
re-alinea todo el stack vía `setActiveReadingLang` (para que las escrituras de estado, las
búsquedas y el caché apunten a ese idioma) y se re-renderiza. En concreto:

- `listEntries(lang)` / `counts(lang)` (y por tanto `summary` / `growthSeries` / `recent`)
  aceptan un filtro de idioma opcional; `usedLanguages()` lista los idiomas con palabras.
- El desglose **Per book** se filtra a los libros escritos en el idioma seleccionado.
- El **caché de definiciones** ([src/definitionsCache.js](../src/definitionsCache.js)) también
  se indexa por `<lang>:<word>`, así grafías idénticas entre idiomas (`important`, `table`,
  `son`) mantienen definiciones independientes. (Las entradas previas sin idioma quedan
  huérfanas y se vuelven a pedir.)

## 3. Accesibilidad y detalles

- Tarjetas interactivas e ítems de nav son `<button>` reales (Enter/Space, anillo de foco);
  las decorativas siguen `<div>`.
- Los chips exponen `aria-pressed`; el filtro activo se ve relleno.
- El leve realce al hover de las tarjetas respeta `prefers-reduced-motion`.
- La nav respeta `env(safe-area-inset-bottom)` para PWA / dispositivos con notch.

## 4. Relación con el rediseño del KB

Esto solo reestructura navegación y presentación. Cuando aterrice
[dictionary-knowledge-base-implementation-ES.md](dictionary-knowledge-base-implementation-ES.md),
sus campos más ricos (sinónimos/antónimos/traducciones por acepción, campos fijados/bloqueados)
se renderizan dentro de los mismos `dictRow`, y un selector de idioma se une a la fila de chips
— sin rehacer la navegación construida aquí.
