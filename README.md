# Intelligent Game Validation · Malackathon 2026 (Betsson)

Prueba de concepto que **valida un juego de casino de terceros como lo haría un jugador**, sin acceso al DOM del juego.
El programa mira los píxeles del juego, encuentra el botón Spin en pantalla, gira, observa cómo se mueven y se paran los
rodillos, lee lo que se muestra (saldo, apuesta, premio, moneda, mensajes) y comprueba que los saldos cuadran:

> **saldo después = saldo antes − apuesta + premio**

Todo funciona en local y gratis: no usa APIs de IA de pago.

> **Alcance de esta PoC: euros (EUR).** Mercados en EUR: betsson.com (inglés) y betsson.es (español, solo desarrollo).
> El soporte de otras divisas (PEN para betsson.pe) está esbozado en el código, pero **no está validado**: queda para una fase posterior.

---

## Índice
1. [Estado actual](#1-estado-actual)
2. [Cómo funciona](#2-cómo-funciona)
3. [Instalación](#3-instalación)
4. [Uso rápido](#4-uso-rápido)
5. [Escenarios y comprobaciones](#5-escenarios-y-comprobaciones)
6. [Verificación exhaustiva (resultados)](#6-verificación-exhaustiva-resultados)
7. [Herramientas](#7-herramientas)
8. [Añadir un juego nuevo](#8-añadir-un-juego-nuevo)
9. [Configuración](#9-configuración)
10. [Seguridad y privacidad](#10-seguridad-y-privacidad)
11. [GitHub Actions](#11-github-actions)
12. [Estructura del código](#12-estructura-del-código)
13. [Limitaciones conocidas](#13-limitaciones-conocidas)
14. [Solución de problemas](#14-solución-de-problemas)

---

## 1. Estado actual

| Pieza | Estado |
|---|---|
| Visión del juego: localizar Spin, detectar giro/parada, OCR de saldo, apuesta y premio | ✅ Verificado contra un juego real de Pragmatic Play (Sweet Bonanza, demo pública), en español y en inglés, EUR |
| Cuadre de saldo en juego, incluidos premios con cascadas (tumbles) | ✅ Verificado en vivo, al céntimo |
| Oráculo de red de Pragmatic (`gameService`) | ✅ Verificado en vivo |
| Reglas PASS/FAIL y controles negativos | ✅ Tests de inyección de fallos + control negativo en vivo |
| Login de Betsson y detección de geobloqueo | ✅ Probado en betsson.es (formulario, rechazo de un usuario falso, redirección .com/.pe → .es) |
| Escenarios 1 y 2 completos con cuenta real de Betsson (saldo Betsson antes/después) | ⏳ Pendiente de credenciales de prueba |
| betsson.com desde CI | ⏳ Requiere proxy o runner propio (geobloqueo) |
| Otras divisas (PEN) | ⏸️ Fuera del alcance de esta PoC |

## 2. Cómo funciona

Tres fuentes independientes que se contrastan entre sí. **Un clic nunca es prueba de nada**: cada comprobación exige que la
pantalla reaccione, y que la red esté de acuerdo cuando se puede observar.

```
            ┌──────────────────────── lo que ve el jugador ────────────────────────┐
 Betsson ──►│ cabecera: saldo Betsson + moneda   (DOM propio de Betsson, permitido) │
            │ ┌──────────── iframe/canvas del juego (solo píxeles) ─────────────┐  │
            │ │ capturas → diff de frames  → ¿empezó? ¿paró? ¿no giró?          │  │
            │ │         → OCR (tesseract)  → CRÉDITO / APUESTA / GANANCIA / €   │  │
            │ │         → plantilla Spin   → dónde hacer clic                   │  │
            │ └──────────────────────────────────────────────────────────────────┘  │
            └──────────────────────────────────────────────────────────────────────┘
 Red del juego (verificación cruzada): gameService → apuesta (c×l), premio (tw), saldo, estado (na)
```

| Fuente | Qué aporta | Cómo |
|---|---|---|
| **Pantalla** (prueba principal) | el juego reaccionó; el giro empezó y terminó; apuesta, saldo, premio, moneda y mensajes **visibles** | captura solo la zona del juego; `pixelmatch` (diff de frames), `tesseract.js` (OCR local), *template matching* con máscara del botón Spin, capturas anotadas |
| **Página de Betsson** | saldo Betsson y moneda en la cabecera | árbol de accesibilidad de la web de Betsson |
| **Red del proveedor** (verificación cruzada) | apuesta, premio y saldo exactos de cada ronda | Playwright lee las respuestas `gameService` del iframe (aunque sea de otro dominio) |

El DOM del juego no se usa nunca: solo la **posición** del iframe/canvas, para hacer capturas y clics por coordenadas.

**El truco del OCR:** las fuentes de las tragaperras son muy decoradas, así que el OCR no tiene que leer a ciegas. Se usa sobre
todo para **confirmar que un valor que ya conocemos** (por la red o la cabecera de Betsson) **está visible en pantalla**.
Esto es mucho más fiable. Si no lo encuentra, el resultado es FAIL con la captura adjunta, nunca un PASS falso.

## 3. Instalación

Requisitos: Node.js 22 o superior y Linux, macOS o Windows con WSL.

```bash
git clone https://github.com/saalma4/Malakathon-26.git
cd Malakathon-26
git switch poc
npm ci
npx playwright install chromium
```

La primera vez que se usa el OCR se descargan los datos de idioma (inglés y español) a `.cache/tesseract`.

## 4. Uso rápido

### Interfaz web (la forma más cómoda)

```bash
npm run ui                     # abre http://127.0.0.1:4321 en el navegador
```

1. **Proveedor:** un desplegable con los proveedores de Betsson Casino. Solo aparecen los que tienen plantilla en `templates/` (ver más abajo).
2. **Juegos:** al elegir el proveedor se despliega la lista de **todos sus juegos en Betsson Casino**, con buscador. Se pueden marcar uno o varios. La lista sale del catálogo público de Betsson (`/api/v1/game-studios` y `/api/v2/games`, sin login), guardado unas horas en `.cache/catalog-es.json`.
3. **▶ Play:** se prueban los juegos **uno tras otro**. Cada uno se abre en una pestaña nueva de tu Chrome **en modo prueba** (`?gameAction=playforfun`). Si Chrome no estaba abierto, se abre solo.

Mientras se ejecuta se ve:
- **el informe por juego:** una tabla con cada juego, su estado y el número de **pruebas pasadas y no pasadas**;
- el detalle del juego en curso: la vista en directo, sus pruebas (✔ / ✘, esperado frente a visto), sus capturas anotadas y sus pasos.

**Al pulsar un juego de la tabla** aparece qué pruebas ha pasado y cuáles no, con sus capturas y enlaces a su informe. Al terminar, el enlace "Informe por juego (HTML)" abre `runs/batch-<fecha>/report.html`, que se puede abrir y compartir sin servidor: cada juego se despliega en sus pruebas. El **historial** de la izquierda reabre cualquier prueba anterior.

**Requisito: la plantilla del proveedor.** Para que un proveedor aparezca en la lista tiene que existir `templates/<Proveedor>.png`, por ejemplo `templates/PragmaticPlay.png`. El nombre se compara sin espacios, guiones ni mayúsculas con el del estudio en Betsson. La imagen es un recorte del HUD de uno de sus juegos con:
- la etiqueta del crédito/saldo y su cantidad;
- la etiqueta de la apuesta y su cantidad;
- el botón Spin, con los botones + y − a sus lados.

Todos los juegos de un proveedor comparten esa estructura. Cuando el juego está listo, el programa busca en la pantalla los botones y textos que coinciden con los de la plantilla:
- **Spin**, a cualquier tamaño;
- **− y +**, a ese tamaño, donde la plantilla los sitúa respecto al Spin;
- las **etiquetas** "CRÉDITO" y "APUESTA" en su fila.

**Añadir un proveedor desde la interfaz:** el botón **"＋ Añadir proveedor"** pide dos cosas:
- el **nombre**, con sugerencias de los estudios de Betsson para que coincida exactamente;
- una **captura de la estructura de botones**: elegir el archivo, arrastrarlo o pegarlo con Ctrl+V.

El programa analiza la captura antes de guardar nada. Si encuentra crédito, apuesta, Spin, + y −:
- guarda `templates/<Proveedor>.png` y `templates/<Proveedor>.json`;
- enseña la captura con cada elemento marcado;
- añade el proveedor a la lista con la selección múltiple de sus juegos.

Si falta algo, dice qué y no guarda nada. Para cambiar la plantilla de un proveedor que ya existe, hay que marcar "Reemplazar".

Las cantidades se leen justo a su derecha. Dónde está cada elemento dentro del PNG lo calcula el programa la primera vez (OCR para las etiquetas y cantidades, anillos blancos para los botones) y lo guarda en `templates/<Proveedor>.json`, que se puede revisar y corregir a mano. `gameWidth` es el ancho del juego del que se recortó: sirve para estimar el tamaño en otros juegos.

**Tu Chrome.** Los juegos se prueban en tu propio Chrome, abierto con la depuración remota (`npm run chrome`, o automáticamente al pulsar Play). Usa un perfil propio en `.cache/chrome-profile`: **inicia sesión en Betsson a mano una vez** y la sesión se guarda. Durante la prueba la pestaña se maximiza y se dibuja a doble densidad de píxeles, para que el OCR lea mejor el HUD; al terminar se cierra. Si un juego no se abre en modo prueba (la URL no lleva `gameAction=playforfun`), **no se prueba**, para no apostar dinero real. `ALLOW_REAL_MONEY=1` lo permite a propósito. Chrome solo permite la depuración remota con un perfil distinto del habitual. Otro puerto o navegador: `CDP_PORT`, `CDP_URL` y `CHROME_PATH`.

Detalles:
- Solo hay una prueba a la vez. Si recargas la página a mitad, no se pierde nada.
- No hay vídeo de las pestañas de tu Chrome: las evidencias son las capturas anotadas.
- Solo escucha en `127.0.0.1`. El puerto se cambia con `UI_PORT=8080 npm run ui`, y `-- --no-open` evita que se abra el navegador.

### Ver el programa jugando desde la terminal

```bash
./play.sh demo                 # demo pública de Pragmatic Play (Sweet Bonanza, español, EUR)
./play.sh demo --spins=3       # varios giros seguidos
./play.sh demo --headless      # sin ventana
```

Cada ejecución imprime un PASS o FAIL por cada comprobación y guarda las evidencias en `runs/fun-<fecha>/`:
- vídeo `.webm` de la sesión;
- capturas anotadas: antes del giro, rodillos en movimiento y después;
- registro de red y `result.json`.

Ejemplo real:

```
▸ Spin localizado por: template en (1158, 812)
▸ Movimiento: pico 15.3% de píxeles a los 1247 ms
  ✔ PASS Moneda en el juego — esperado: EUR · visto: EUR
  ✔ PASS El giro empezó (la pantalla reaccionó) — esperado: movimiento + doSpin · visto: 15.3%, doSpin sí
  ✔ PASS El giro terminó — esperado: pantalla quieta + ronda cerrada · visto: quieta tras 12732 ms, ronda cerrada
  ✔ PASS Apuesta mostrada = apuesta usada — esperado: 2,00 EUR · visto: 2,00 EUR
  ✔ PASS Saldo en juego = antes − apuesta + premio — esperado: 99.998,00 EUR − 2,00 EUR + 5,30 EUR = 100.001,30 EUR · visto: 100.001,30 EUR
  ✔ PASS El saldo nuevo se ve en pantalla — esperado: 100.001,30 EUR · visto: 100.001,30 EUR leído por OCR
```

### Juego dentro de Betsson (betsson.es, modo "jugar gratis")

```bash
./play.sh                      # Bubble Up en betsson.es (?gameAction=playforfun)
./play.sh "<url de un juego de Betsson>" --game=<clave-del-juego>
```

En España **incluso el modo gratis exige iniciar sesión**. Hay dos formas:
- con `ES_FUNDED_USER` y `ES_FUNDED_PASS` en `.env`;
- ejecutando sin `--headless` e iniciando sesión a mano en la ventana.

El login se hace en un navegador aparte que no graba nada. La sesión se guarda en `.cache/browser-profile`, así que solo
hay que iniciarla una vez.

### Suite formal (los dos escenarios del reto, con informe)

```bash
cp .env.example .env           # rellenar las cuentas de prueba (nunca subir .env)
npm run test:unit              # 28 tests, sin cuenta
npm run test:es                # escenarios 1 y 2 en betsson.es
npm run test:com               # escenarios 1 y 2 en betsson.com (EN/EUR); necesita estar en un país permitido o un proxy
HEADED=1 npm run test:com      # verlo jugar
npm run report                 # informe Playwright: vídeo, capturas anotadas por comprobación, red
xdg-open report/summary.html   # matriz PASS/FAIL escenario × mercado × comprobación
```

## 5. Escenarios y comprobaciones

Todas las reglas de PASS/FAIL son funciones puras en `src/checks/reconcile.ts`, así que se pueden probar con datos manipulados.

**Pruebas por juego (interfaz y `npm run fun`)** (`src/runner/session.ts`)

El juego está **listo** cuando se encuentran en pantalla el Spin y las etiquetas de crédito y apuesta de la plantilla del proveedor, y se leen sus dos cantidades. El movimiento de fondo se ignora en esta fase, porque hay juegos cuyas animaciones en reposo nunca paran.

| Prueba | Comprobaciones |
|---|---|
| **Estructura** | `El HUD del proveedor está en pantalla` (crédito, apuesta, Spin, + y −, como en la plantilla) · `Moneda en el juego` |
| **Aumento de apuesta** | `La apuesta aumenta en pantalla al pulsar +` · `El giro empezó (los rodillos se mueven)` · `El giro terminó` · `Crédito en pantalla = inicial − apuesta + premio` · `gameService: apuesta cobrada = apuesta en pantalla y saldo = inicial − apuesta + premio` |
| **Resta de apuesta** | Las mismas, con el botón − (`La apuesta disminuye en pantalla al pulsar −`, …). |

El orden de cada prueba es este:
1. Se leen en pantalla el crédito y la apuesta, antes de tocar nada.
2. Se pulsa + (o −) y se lee la apuesta nueva.
3. Se pulsa Spin.
4. Se comprueba que al crédito se le ha restado esa apuesta (más el premio, si lo hay) de dos formas:
   - **en pantalla**;
   - **en los paquetes `gameService`** que el juego envía a su API: el `doSpin` tiene que cobrar exactamente la apuesta mostrada (c × l), y el saldo que devuelve tiene que ser el anterior − apuesta + premio.

- Entre cada pulsación de botón y la siguiente lectura de pantalla hay una pausa de **0,5 s** (`ACTION_PAUSE_MS` en `src/vision/capture.ts`), para dar tiempo a que la interfaz del juego se actualice.
- Tras pulsar Spin, el movimiento solo se mide en una **zona pequeña en el centro de los rodillos** (`reelsRect`, por defecto el 28 % × 38 % central). Así no cuentan las animaciones de fuera de los rodillos (personajes, logo, paneles, HUD) ni las que rozan el borde de la zona. La zona aparece marcada en la captura "rodillos en movimiento".
- Las cantidades se leen solo en su recuadro (a la derecha de cada etiqueta), con varias pasadas de OCR y el valor más repetido, prefiriendo las lecturas con dos decimales.
- Las reglas `betMoved`, `reconcile`, `spinStarted` y `spinCompleted` son funciones puras con tests de inyección de fallos (`tests/unit/provider.spec.ts` y `checks.spec.ts`).

**Escenario 1: giro completado en Real Play** (`tests/e2e/s1-completed-spin.spec.ts`)

| Comprobación | Qué demuestra | Fuentes |
|---|---|---|
| `S1.betsson-currency` | el saldo de Betsson está en la moneda del mercado | Betsson |
| `S1.game-currency` | en el juego se ve la moneda del mercado y ninguna otra | pantalla |
| `S1.spin-started` | el giro empezó: la pantalla cambió tras el clic (y el proveedor recibió un `doSpin`) | pantalla + red |
| `S1.spin-completed` | el giro terminó: pantalla quieta y ronda cerrada | pantalla + red |
| `S1.wager` | la apuesta mostrada es la usada | pantalla + red |
| `S1.ingame-balance` | saldo en juego después = antes − apuesta + premio, **y se ve en pantalla** | pantalla + red |
| `S1.betsson-reconcile` | saldo Betsson después = antes − apuesta + premio | Betsson + red |

**Escenario 2: saldo insuficiente** (`tests/e2e/s2-insufficient-balance.spec.ts`)

| Comprobación | Qué demuestra |
|---|---|
| `S2.betsson-currency` | moneda del mercado en la cabecera |
| `S2.spin-rejected` | no hubo giro: sin movimiento sostenido de rodillos y sin `doSpin` aceptado |
| `S2.message` | se muestra un mensaje de saldo insuficiente (en el canvas por OCR, o en un diálogo de Betsson) |
| `S2.message-language` | el mensaje está en el idioma del mercado |
| `S2.game-currency` | moneda del mercado en el juego |
| `S2.ingame-balance-unchanged` | el saldo en juego no cambia |
| `S2.betsson-balance-unchanged` | el saldo Betsson no cambia |

## 6. Verificación exhaustiva (resultados)

La verificación se hizo el 15 de octubre de 2026 contra la demo pública de Pragmatic Play (Sweet Bonanza, EUR).

| # | Prueba | Resultado |
|---|---|---|
| 1 | Typecheck (`npm run typecheck`) | ✅ sin errores |
| 2 | Tests unitarios (`npm run test:unit`) | ✅ **28/28** |
| 3 | Inyección de fallos (`tests/unit/checks.spec.ts`): saldo descuadrado por 1 céntimo, premio anunciado pero no abonado, cartera sin actualizar, apuesta mostrada ≠ usada, moneda incorrecta o mezclada, clic sin reacción, rodillos que no paran, giro aceptado sin saldo, mensaje en otro idioma, valor en pantalla ≠ real | ✅ todos dan **FAIL**, como deben |
| 4 | Calibración en vivo (`npm run calibrate -- demo`): reposo frente a giro | ✅ 4/4: reposo 5,2 % de cambio y 0 s de movimiento sostenido; giro 31,7 % y 4,4 s |
| 5 | En vivo, español/EUR, 5 giros (`./play.sh demo --spins=5`) | ✅ **30/30**, incluido un premio de 5,30 € con cascadas |
| 6 | En vivo, inglés/EUR con la configuración de betsson.com | ✅ **12/12** |
| 7 | En vivo, ejecución final con el código definitivo, 3 giros | ✅ **18/18**; Spin localizado por plantilla en los 3 |
| 8 | **Control negativo en vivo:** juego en EUR con el mercado configurado como PEN | ✅ la comprobación de moneda da **FAIL** ("esperado PEN · visto EUR") y el resto pasa |
| 9 | Plantilla del Spin sobre fotogramas reales | ✅ botón quieto: 0,000–0,019 (encontrado); intro con botón parecido: 0,068 (rechazado); rodillos girando: ≥ 0,066 (rechazado). Umbral 0,04 |
| 10 | Login de betsson.es con un usuario falso | ✅ rechazado y detectado, sin filtrar nada |
| 11 | Geobloqueo: betsson.com/.pe desde España | ✅ detectado, con un mensaje que indica el proxy a configurar |
| 12 | Secretos: búsqueda en los ficheros versionados, `.gitignore` y tokens de sesión en los logs | ✅ nada versionado; `.env`, `runs/`, `discovery/`, `.cache/` y `report/` ignorados; `mgckey` enmascarado (15/15) |
| 13 | YAML del workflow | ✅ válido (jobs `unit`, `validate`, `report`) |

**Fallos reales que encontró la verificación y que están corregidos:**
- se daba el juego por listo estando aún en la intro;
- el OCR "confirmaba" importes al leer dígitos sueltos;
- la tecla Espacio se pulsaba a ciegas con el juego listo y **lanzaba un giro no pedido**;
- con juegos animados en reposo, la pantalla quieta se confundía con un giro;
- la duración del movimiento se medía mal (muestras × intervalo en lugar de tiempo real);
- la búsqueda gruesa de la plantilla perdía los trazos finos del botón;
- en juegos con cascadas, la ronda se daba por cerrada antes del abono;
- `isVisible({timeout})` no esperaba;
- la moneda del saldo de Betsson se tomaba de cualquier símbolo de la cabecera.

**Cómo repetir la verificación:**

```bash
npm run typecheck && npm run test:unit
npm run calibrate -- demo --headless       # los 4 criterios en ✔
./play.sh demo --headless --spins=5        # 30/30
./play.sh demo --headless --market=pe      # control negativo: la moneda TIENE que dar FAIL
```

## 7. Herramientas

| Comando | Para qué |
|---|---|
| `npm run ui` | interfaz web: Play, vista en directo, comprobaciones, capturas, vídeo e historial |
| `./play.sh` / `npm run fun -- <url\|demo>` | jugar en vivo y comprobar paso a paso (`--spins`, `--game`, `--market`, `--headless`) |
| `npm run calibrate -- <url\|demo> [--game=]` | medir el movimiento en reposo frente a un giro y sugerir umbrales para `game.json`; también es un control negativo (reposo ≠ giro) |
| `npm run make-template -- <png> <x> <y> <w> <h> <salida.png>` | recortar un botón de una captura real como plantilla con máscara (solo los trazos claros) |
| `npm run discover -- es` | grabar una sesión manual (red y capturas) para estudiar un juego o mercado nuevo |
| `npm run replay -- <carpeta>` | pasar la visión sin conexión sobre capturas guardadas y anotarlas |
| `DEBUG_VISION=1 …` | trazas de la espera "¿está listo el juego?"; guarda `runs/debug-ready.png` |

## 8. Añadir un juego nuevo

1. Abrirlo: `./play.sh "<url>" --game=<clave>`. Sin plantilla, el programa usa la posición configurada o el teclado.
2. Recortar el botón Spin de una captura de `runs/…`:
   `npm run make-template -- runs/…/04-spin1-after.png X Y W H assets/games/<clave>/spin.png`
3. Calibrar: `npm run calibrate -- "<url>" --game=<clave>`. Copiar los valores sugeridos a `assets/games/<clave>/game.json`:
   ```json
   { "spinRel": { "x": 0.803, "y": 0.906 }, "maxScore": 0.04, "stableMaxRatio": 0.06, "motionMinRatio": 0.14, "nonSpinMotionMaxMs": 900 }
   ```
4. Repetir la calibración hasta tener los 4 ✔, y después `./play.sh "<url>" --game=<clave> --spins=3`.

Claves opcionales de `game.json` para la sesión de juego (fracciones 0..1 del área del juego):

| Clave | Por defecto | Para qué |
|---|---|---|
| `reelsRect` | `{ "x": 0.36, "y": 0.30, "w": 0.28, "h": 0.38 }` | zona central donde se mide el movimiento de los rodillos tras pulsar Spin |
| `reelMotionMinRatio` | `0.25` | cambio en esa zona que cuenta como "los rodillos se mueven" |
| `reelStableMaxRatio` | `0.04` | cambio entre fotogramas que aún cuenta como "rodillos parados" |
| `plusRel`, `minusRel` | junto al Spin | posición fija de los botones + y − de la apuesta, si el juego no sigue el diseño de Pragmatic |

## 9. Configuración

- **Mercados:** en `src/config/markets.ts` (URL, idioma, moneda, formato numérico, juego, etiquetas del HUD y frases de saldo insuficiente).
- **Credenciales y opciones:** en `.env`, a partir de `.env.example`.

| Variable | Uso |
|---|---|
| `COM_FUNDED_USER/PASS`, `ES_FUNDED_USER/PASS` | cuenta con saldo (Escenario 1) |
| `COM_EMPTY_USER/PASS`, `ES_EMPTY_USER/PASS` | cuenta sin saldo utilizable (Escenario 2) |
| `COM_PROXY` | proxy para betsson.com si hay geobloqueo (`http://user:pass@host:port`) |
| `COM_GAME_PATH`, `COM_GAME_KEY` | cambiar el juego de un mercado |
| `COM_BALANCE_SELECTOR` | locator exacto del saldo en la cabecera, si hiciera falta |
| `HEADED=1`, `TRACE=on` | ver el navegador o grabar traces de Playwright (contienen cookies de sesión: no publicarlos) |

## 10. Seguridad y privacidad

- No hay credenciales en el repositorio: vienen de variables de entorno o de GitHub Secrets.
- **El login va en un contexto de navegador sin vídeo ni trace.** Solo la sesión pasa al contexto que graba, así que lo que se teclea no aparece en las evidencias.
- Los traces están desactivados por defecto, porque contienen cookies. Los tokens de sesión del proveedor (`mgckey`) se enmascaran en todos los logs.
- `runs/`, `discovery/`, `report/` y `.cache/` (perfil del navegador con la sesión) están en `.gitignore`.

## 11. GitHub Actions

El workflow es `.github/workflows/validate.yml`:
1. typecheck y tests unitarios;
2. un job por mercado con los dos escenarios, Chromium con ventana bajo Xvfb (para WebGL);
3. un job que fusiona los informes y los publica en **GitHub Pages**, y además escribe la tabla en el Job Summary.

Antes de lanzarlo:
- **Secrets** del repositorio: `COM_FUNDED_USER/PASS` y `COM_EMPTY_USER/PASS`.
- **Geobloqueo:** los runners de GitHub están fuera de los países permitidos. Hay que añadir el secret `COM_PROXY`, o la variable `RUNNER` con la etiqueta de un runner self-hosted.
- **Pages:** Settings → Pages → Source: "GitHub Actions".
- **Mercados:** en esta PoC (solo EUR), lanzarlo a mano con `markets = ["com"]`.

## 12. Estructura del código

```
src/config/markets.ts       configuración por mercado
src/pages/BetssonPage.ts    lobby, login, saldo de la cabecera y apertura del juego (DOM de Betsson)
src/game/GamePlayer.ts      juega como una persona: espera a que esté listo, lee la pantalla, localiza y pulsa Spin
src/runner/session.ts       pruebas de un juego (estructura, aumento y resta de apuesta) con eventos en vivo; común a CLI e interfaz
src/runner/batch.ts         varios juegos de un proveedor uno tras otro + informe por juego (runs/batch-<fecha>/)
src/runner/chrome.ts        tu Chrome con depuración remota (abrirlo y conectarse)
src/runner/report.ts        informe HTML autónomo por juego (runs/<id>/report.html)
src/catalog/betsson.ts      catálogo de Betsson Casino: proveedores y sus juegos (API pública, en caché)
src/vision/providerTemplate.ts plantillas de proveedor: templates/<Proveedor>.png (+ .json con dónde está cada elemento)
scripts/ui-server.ts        servidor local de la interfaz (API, eventos en vivo por SSE, ficheros de evidencias)
templates/                  una imagen del HUD por proveedor: crédito, apuesta, Spin, + y −
ui/                         interfaz web (HTML/CSS/JS sin compilación)
src/vision/capture.ts       captura de la zona del juego y clics por coordenadas
src/vision/frameDiff.ts     movimiento: empezó / se paró / no giró (con tiempos reales)
src/vision/ocr.ts           OCR local + confirmación de importes, etiquetas, frases e idioma
src/vision/locate.ts        template matching con máscara (coarse-to-fine con varios candidatos)
src/vision/annotate.ts      capturas anotadas (evidencia)
src/oracle/pragmatic.ts     oráculo de red de Pragmatic (cascadas, collect; tokens enmascarados)
src/checks/reconcile.ts     reglas PASS/FAIL puras
src/checks/CheckRecorder.ts comprobaciones con nombre + evidencias → checks.json
src/reporter/summary.ts     matriz PASS/FAIL → HTML, Markdown y Job Summary
tests/e2e/                  escenarios 1 y 2 (necesitan cuenta)
tests/unit/                 40 tests sin navegador ni cuenta (incluida la inyección de fallos)
scripts/                    play-fun, calibrate, make-template, discover, replay
assets/games/<juego>/       spin.png (plantilla) + game.json (umbrales calibrados)
```

## 13. Limitaciones conocidas

- **Solo EUR validado.** El código de PEN existe pero no está probado de punta a punta.
- **Escenarios formales sin ejecutar con cuenta real.** Lo que depende de Betsson (saldo de la cabecera, sincronización de la cartera, mensaje de saldo insuficiente) está implementado pero pendiente de las credenciales de prueba.
- **Un juego calibrado:** Sweet Bonanza. Bubble Up (el contenedor de betsson.es) necesita su plantilla y calibración (sección 8). Además puede no ser de Pragmatic; en ese caso la verificación cruzada por red no aplica, pero la visión sigue funcionando.
- **OCR:** confirma bien valores conocidos, pero las lecturas a ciegas de fuentes muy decoradas pueden fallar. Por eso, sin el oráculo de red, algunas comprobaciones son menos robustas.
- **Free spins y bonus:** si un giro activa tiradas gratis, la ronda puede no cerrarse en el tiempo previsto, y la comprobación lo marcará como FAIL.

## 14. Solución de problemas

| Síntoma | Causa probable / solución |
|---|---|
| `Geo-redirected from www.betsson.com to www.betsson.es` | geobloqueo: usar VPN o `COM_PROXY` |
| `Sin sesión y sin ES_FUNDED_USER/PASS en .env` | ejecutar sin `--headless` e iniciar sesión a mano, o rellenar `.env` |
| `Game did not become playable in time` | ejecutar con `DEBUG_VISION=1` y mirar `runs/debug-ready.png`: ¿se ve el HUD? ¿casa la plantilla? |
| `Spin localizado por: config` o `keyboard` | no hay plantilla o no casa: crear o recalibrar la plantilla (sección 8) |
| `El giro empezó` en FAIL sin `doSpin` | el clic no lanzó un giro (por ejemplo, cerró un diálogo): revisar las capturas anotadas |
| Muchos `Fontconfig warning` | avisos del sistema, inofensivos |
