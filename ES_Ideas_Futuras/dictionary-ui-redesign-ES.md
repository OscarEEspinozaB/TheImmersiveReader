# The Immersive Reader — Rediseño de UI de Diccionario y Stats (Plan de Implementación)

> Estado: **Propuesto (plan de implementación).** Última actualización 2026-06-25.
>
> Alcance: hacer la vista de vocabulario (a la que se llega vía el **ícono de
> estadísticas**) más mínima e intuitiva, y hacer que las tarjetas de stats **Known** y
> **Learning** actúen como botones que saltan directo a la pestaña Dictionary con ese
> filtro ya aplicado. Implementado en [src/dashboard.js](../src/dashboard.js); CSS en
> [src/styles/main.css](../src/styles/main.css). Es el compañero de cara al usuario de
> [dictionary-knowledge-base-implementation-ES.md](dictionary-knowledge-base-implementation-ES.md).

## 1. Contexto

El diccionario vive bajo el **ícono de estadísticas**: la vista de nivel superior
"Vocabulary" ([src/dashboard.js](../src/dashboard.js)) abierta desde la biblioteca, con
dos pestañas — **Stats** y **Dictionary**. Hoy las dos pestañas se sienten
desconectadas: Stats muestra conteos (`Known`, `Learning`, `Total`, `This week`) como
tarjetas inertes, y Dictionary tiene su propio `<select>` de filtro
`All / Known / Learning`. El usuario tiene que conectar mentalmente "tengo 312 palabras
conocidas" con "ahora cambio de pestaña, abro el dropdown del filtro, elijo Known".

El arreglo es hacer de los conteos el punto de entrada: **las tarjetas Known y Learning
se vuelven botones** que abren la pestaña Dictionary pre-filtrada. Los mismos datos, un
clic en vez de tres, y los números dejan de ser decorativos.

## 2. Objetivos

- Las tarjetas de stats Known / Learning son **clicleables** → abren la pestaña
  Dictionary filtrada a ese estado, scrolleada al tope.
- La pestaña Dictionary refleja el filtro entrante (el `state.filter` existente ya
  maneja la lista — solo lo seteamos antes de cambiar de pestaña).
- Una superficie de diccionario **mínima y más intuitiva**: reemplazar la fila de
  dropdowns `<select>` por **chips** de filtro inline (igualando el estilo de píldora
  existente `.dash__tab`), mantener la búsqueda, y hacer obvio el estado activo.
- Sin dependencias nuevas, sin vista nueva. Puro `dashboard.js` + CSS. Los invariantes
  de estado y el diseño de la KB quedan intactos.

## 3. No-objetivos

- Sin cambios a la lógica de estado de vocabulario, conteos o almacenamiento.
- No es la KB de diccionario en sí (eso es el doc de implementación compañero). Este
  rediseño es compatible con ella: cuando la KB aterrice, sus campos más ricos se
  renderizan dentro de las mismas filas.

## 4. Lo que existe hoy (aterrizaje)

- **El estado de pestañas compartido** ya vive en un objeto:
  `state = { tab, search, filter, sort }` ([src/dashboard.js](../src/dashboard.js#L26)).
  `renderBody()` lee `state.tab`; la lista del diccionario lee `state.filter`. Así que
  un deep-link es solo: setear `state.tab='dictionary'`, `state.filter='known'`,
  re-renderizar.
- Las **tarjetas de stats** las construye `statCard(label, value)`
  ([src/dashboard.js](../src/dashboard.js#L159)) — actualmente un `<div>` plano.
- El **filtro del diccionario** es un `<select>` de `select([...])`
  ([src/dashboard.js](../src/dashboard.js#L185)); `renderList()` filtra `listEntries()`
  por `state.filter`.
- Los **botones de pestaña** tienen estilo píldora `.dash__tab`
  ([main.css](../src/styles/main.css#L877)). Las tarjetas de stats son `.stat-card`
  ([main.css](../src/styles/main.css#L911)).

Todo lo necesario para el deep-link ya está cableado; este es un cambio chico y bien
contenido.

## 5. Diseño

### 5a. Tarjetas de stats clicleables

`statCard` gana un `onClick` opcional. Cuando está presente, renderizar un `<button>` en
vez de un `<div>` (accesible por teclado, enfocable, semántica correcta), mantener el
look `.stat-card`, agregar una señal sutil (elevación al hover / `cursor: pointer` / un
tenue `›`).

```text
┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
│   312  › │ │   87   › │ │  399   │ │   +24    │
│  Known   │ │ Learning │ │ Total  │ │ This week│
└──────────┘ └──────────┘ └────────┘ └──────────┘
   botón        botón       (plano)     (plano)
```

`renderStats` cablea las dos tarjetas interactivas a un nuevo `goToDictionary(filter)`:

```js
cards.append(
  statCard('Known', s.known, () => goToDictionary('known')),
  statCard('Learning', s.learning, () => goToDictionary('learning')),
  statCard('Total', s.total),
  statCard('This week', `+${r.known + r.learning}`),
);
```

`goToDictionary` necesita acceso al `state` compartido + el cambiador de pestañas. El
cableado más limpio: `renderStats(body)` ya se llama desde dentro de `renderDashboard`
donde `state`, `updateTabs` y `renderBody` están en alcance. Pasar un pequeño callback
hacia abajo:

```js
// en renderDashboard:
if (state.tab === 'stats')
  renderStats(body, (filter) => { state.tab = 'dictionary'; state.filter = filter;
                                   updateTabs(); renderBody(); });
else renderDictionary(body, state, root);
```

Así `renderStats(body, goToDictionary)` y las dos tarjetas llaman
`goToDictionary('known'|'learning')`.

### 5b. Controles de diccionario mínimos (chips en vez de dropdowns)

Reemplazar los dos `<select>` por **chips de filtro inline** reusando la estética de
píldora, y mantener la búsqueda como el único input de texto. El orden
(`Recent / A–Z`) se vuelve un pequeño toggle a la derecha en vez de un dropdown.

```text
┌─────────────────────────────────────────────┐
│  🔍  Buscar palabras…                 A–Z ⇅  │
│  ( Todas )  ( Known )  ( Learning )          │   ← chips; el activo relleno
│  ───────────────────────────────────────────│
│  wand            ● learning                   │
│    a thin stick used for magic…               │
│  owl             ● known                      │
└─────────────────────────────────────────────┘
```

- Los chips son botones; clicar uno setea `state.filter` y llama `renderList()` (la
  lógica de la lista no cambia — ya filtra por `state.filter`).
- Cuando el usuario **llega vía una tarjeta de stats**, el chip correspondiente ya está
  activo porque `state.filter` se seteó antes de cambiar de pestaña — las dos
  superficies ahora coinciden por construcción.
- El toggle de orden alterna `state.sort` entre `recent` y `a-z` (los mismos valores que
  usaba el `select` existente), así que el comparador de orden de `renderList` queda
  intacto.

### 5c. Filas más livianas

Pulido menor, todo CSS-only o markup trivial:

- El `<select>` de estado por fila ([dashboard.js](../src/dashboard.js#L299)) es
  visualmente pesado. Mantenerlo (es la forma más rápida de re-estatuar una palabra)
  pero estilizarlo hacia abajo a un chip sin borde que solo muestra su borde al
  hover/focus.
- Ajustar el padding de la fila y apoyarse en el punto de estado de color + el color de
  palabra `data-state` (ya presentes) para cargar el estado, reduciendo el cromado
  redundante.

## 6. CSS (`src/styles/main.css`)

- `.stat-card` → agregar una variante `button.stat-card`: `cursor: pointer`,
  `text-align` izquierda, resetear defaults del botón, `:hover` sutil
  `border-color: var(--text)` + pequeño `translateY(-1px)`, anillo `:focus-visible`
  visible. Las tarjetas no interactivas siguen siendo `<div>` y mantienen el look
  actual.
- Nueva fila `.dict-chips` reusando el estilo `.dash__tab` / `.dash__tab.is-active` (o
  una clase compartida `.chip` extraída de él, para que pestañas y chips de filtro
  queden consistentes).
- `.dict-controls` se vuelve `search` + un toggle de orden alineado a la derecha; la
  fila de chips se ubica debajo. Quitar el uso de `.dict-select` aquí (el select de
  estado por fila puede mantener una variante adelgazada).

## 7. Pasos de implementación

1. **`statCard` → `onClick` opcional** renderiza un `<button>`; agregar el CSS
   `button.stat-card`. (Auto-contenido; sin cambio de comportamiento cuando falta
   `onClick`.)
2. **Deep-link:** enhebrar `goToDictionary(filter)` desde `renderDashboard` hacia
   `renderStats`; cablear las tarjetas Known/Learning.
3. **Chips de filtro:** reemplazar el `<select>` de filtro en `renderDictionary` por una
   fila de chips manejada por `state.filter`; mantener `renderList` como está.
4. **Toggle de orden + filas livianas:** cambiar el `<select>` de orden por un toggle
   chico; pulido CSS en filas y en el select de estado por fila.
5. Verificación manual (`npm run dev`): marcar algunas palabras, abrir stats, clicar
   Known → aterriza en Dictionary filtrado a Known con el chip Known activo; clicar
   Learning igual; la búsqueda sigue funcionando; el orden alterna.

Los pasos 1–2 entregan el comportamiento estrella (conteos clicleables) y pueden
entregarse solos; 3–4 son el pulido minimalista y pueden seguir.

## 8. Accesibilidad y detalles

- Las tarjetas interactivas son `<button>` reales (Enter/Espacio, anillo de foco, lector
  de pantalla dice "botón"); las decorativas siguen siendo `<div>`.
- Los chips son botones con `aria-pressed` reflejando el filtro activo.
- Respetar `prefers-reduced-motion` para la elevación al hover.
- Volver a Stats y regresar preserva `state.filter` (ya persiste en el objeto `state`
  compartido durante la vida del dashboard).

## 9. Relación con el rediseño de la KB

Este rediseño solo toca presentación y navegación. Cuando aterrice
[dictionary-knowledge-base-implementation-ES.md](dictionary-knowledge-base-implementation-ES.md),
las mismas filas del diccionario ganan sinónimos/antónimos/traducciones-por-acepción de
la KB y un ícono de pin en los campos bloqueados, y un selector de idioma se suma a la
fila de chips — sin retrabajo de la navegación construida aquí.
