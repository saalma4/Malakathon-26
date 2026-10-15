# Intelligent Game Validation · Malackathon 2026 (Betsson)

Prueba de concepto que **valida un juego de casino de terceros como lo haría un jugador**, sin acceso al DOM del juego.
El programa mira los píxeles del juego, encuentra el botón Spin en pantalla, gira, observa cómo se mueven y se paran los
rodillos, lee lo que se muestra (saldo, apuesta, premio, moneda, mensajes) y comprueba que los saldos cuadran:

> **saldo después = saldo antes − apuesta + premio**

Todo funciona en local y gratis: no usa APIs de IA de pago.

> **Alcance de esta PoC: euros (EUR).** Mercados en EUR: betsson.com (inglés) y betsson.es (español, solo desarrollo).
> El soporte de otras divisas (PEN para betsson.pe) está esbozado en el código, pero **no está validado**: queda para una fase posterior.

---

## Instalación y uso

### Requisitos previos

| Software | Uso | Instalación |
|---|---|---|
| Git | Descarga del repositorio | <https://git-scm.com/downloads>. En Linux: `sudo apt install git` (Ubuntu/Debian) o `sudo pacman -S git` (Arch). |
| Node.js 22 o superior | Ejecución del programa (incluye `npm`) | <https://nodejs.org>, versión LTS. En Linux y macOS también con [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`. |

Comprobación de las versiones instaladas:

```bash
git --version
node --version    # debe ser v22 o superior
```

### Instalación

```bash
git clone https://github.com/saalma4/Malakathon-26.git
cd Malakathon-26
npm ci                              # dependencias del proyecto
npx playwright install chromium     # navegador utilizado por el programa (~150 MB)
```

En algunas distribuciones de Linux Playwright muestra el aviso `BEWARE: your OS is not officially supported by Playwright`.
Es informativo: se descarga una compilación compatible. Si faltasen librerías del sistema, se pueden instalar con
`npx playwright install --with-deps chromium`.

La primera ejecución requiere conexión a internet para cargar el juego y descargar los datos de idioma del OCR.

### Ejecución

```bash
npm run ui
```

La interfaz queda disponible en <http://127.0.0.1:4321> y se abre automáticamente en el navegador. Si no se abre, hay
que introducir esa dirección a mano. Para lanzar una prueba:

1. En **Juego**, seleccionar *Demo Pragmatic Play · Sweet Bonanza*: es un juego real, gratuito y sin cuenta.
2. Indicar el número de **Giros**.
3. Pulsar **Play**.

Durante la ejecución se muestran el juego en directo, el resultado de cada comprobación y las capturas tomadas.
Al finalizar se presentan:
- el resultado global (por ejemplo, "12/12 comprobaciones OK");
- el vídeo de la sesión;
- un informe HTML.

Cada giro tarda aproximadamente entre 1 y 2 minutos. El servidor se detiene con `Ctrl+C`.

### Ejecución desde la terminal

```bash
npm run fun -- demo --headless              # 1 giro
npm run fun -- demo --headless --spins=3    # 3 giros
```

Las evidencias (capturas, vídeo e informe `report.html`) se guardan en `runs/`.

En Windows (sin probar) deben usarse los comandos `npm run …` desde PowerShell. El atajo `./play.sh` requiere bash
(Linux, macOS o Git Bash).

---

## Índice
- [Instalación y uso](#instalación-y-uso)
1. [Estado actual](#1-estado-actual)
2. [Cómo funciona](#2-cómo-funciona)
3. [Requisitos y compatibilidad](#3-requisitos-y-compatibilidad)
4. [Modos de uso](#4-modos-de-uso)
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
| Visión del juego: localizar Spin, detectar giro/parada, OCR de saldo, apuesta y premio | Verificado contra un juego real de Pragmatic Play (Sweet Bonanza, demo pública), en español y en inglés, EUR |
| Cuadre de saldo en juego, incluidos premios con cascadas (tumbles) | Verificado en vivo, al céntimo |
| Oráculo de red de Pragmatic (`gameService`) | Verificado en vivo |
| Reglas PASS/FAIL y controles negativos | Verificado con tests de inyección de fallos y un control negativo en vivo |
| Login de Betsson y detección de geobloqueo | Probado en betsson.es (formulario, rechazo de un usuario falso, redirección .com/.pe → .es) |
| Escenarios 1 y 2 completos con cuenta real de Betsson (saldo Betsson antes/después) | Pendiente de credenciales de prueba |
| betsson.com desde CI | Pendiente: requiere proxy o runner propio (geobloqueo) |
| Otras divisas (PEN) | Fuera del alcance de esta PoC |

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

## 3. Requisitos y compatibilidad

- **Requisitos:** Git, Node.js 22 o superior y conexión a internet en la primera ejecución. Los datos de idioma del OCR (inglés y español) se guardan en `.cache/tesseract`.
- **Probado** en Linux: en el equipo de desarrollo (Arch/Omarchy) y en una máquina Ubuntu limpia de GitHub Actions (instalación, typecheck y tests unitarios).
- **Sin probar** en macOS y Windows. El código no depende del sistema operativo, salvo el atajo `./play.sh`, que es un script de bash.
- **Modo headless recomendado.** El modo con ventana puede fallar en gestores de ventanas en mosaico (por ejemplo, Hyprland), porque la ventana no conserva el tamaño de 1440×900.

## 4. Modos de uso

### Interfaz web

```bash
npm run ui                     # abre http://127.0.0.1:4321 en el navegador
```

Eliges el juego y el número de giros y pulsas **Play**. Mientras se ejecuta, ves en directo:
- **la vista del juego**, con el paso actual: "Esperando a que el juego sea jugable…", "Giro 2/3"…;
- **las comprobaciones**, marcadas como correctas (verde) o fallidas (rojo) según se completan, con el valor esperado frente al observado y agrupadas por giro;
- **las capturas que toma el programa**: juego listo, antes del giro (con el saldo, la apuesta y el botón Spin marcados), rodillos en movimiento y después. Al hacer clic se amplían, y se navega con ← y →.

Al terminar aparece:
- un resumen en verde ("12/12 comprobaciones OK") o, si hay fallos, en rojo;
- el **vídeo** de la sesión;
- enlaces al **informe HTML** (`report.html`, que se puede abrir y compartir sin servidor), a `result.json` y a `network.json`.

El **historial** de la izquierda reabre cualquier ejecución anterior, también las lanzadas desde la terminal.

Detalles:
- La interfaz ejecuta siempre en modo *headless*: la vista en directo sustituye a la ventana del navegador.
- Solo hay una ejecución a la vez. Si recargas la página a mitad, no se pierde nada.
- Solo escucha en `127.0.0.1`. El puerto se cambia con `UI_PORT=8080 npm run ui`, y `-- --no-open` evita que se abra el navegador.

### Terminal

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
| 1 | Typecheck (`npm run typecheck`) | sin errores |
| 2 | Tests unitarios (`npm run test:unit`) | **28/28** |
| 3 | Inyección de fallos (`tests/unit/checks.spec.ts`): saldo descuadrado por 1 céntimo, premio anunciado pero no abonado, cartera sin actualizar, apuesta mostrada ≠ usada, moneda incorrecta o mezclada, clic sin reacción, rodillos que no paran, giro aceptado sin saldo, mensaje en otro idioma, valor en pantalla ≠ real | todos dan **FAIL**, como deben |
| 4 | Calibración en vivo (`npm run calibrate -- demo`): reposo frente a giro | 4/4: reposo 5,2 % de cambio y 0 s de movimiento sostenido; giro 31,7 % y 4,4 s |
| 5 | En vivo, español/EUR, 5 giros (`./play.sh demo --spins=5`) | **30/30**, incluido un premio de 5,30 € con cascadas |
| 6 | En vivo, inglés/EUR con la configuración de betsson.com | **12/12** |
| 7 | En vivo, ejecución final con el código definitivo, 3 giros | **18/18**; Spin localizado por plantilla en los 3 |
| 8 | **Control negativo en vivo:** juego en EUR con el mercado configurado como PEN | la comprobación de moneda da **FAIL** ("esperado PEN · visto EUR") y el resto pasa |
| 9 | Plantilla del Spin sobre fotogramas reales | botón quieto: 0,000–0,019 (encontrado); intro con botón parecido: 0,068 (rechazado); rodillos girando: ≥ 0,066 (rechazado). Umbral 0,04 |
| 10 | Login de betsson.es con un usuario falso | rechazado y detectado, sin filtrar nada |
| 11 | Geobloqueo: betsson.com/.pe desde España | detectado, con un mensaje que indica el proxy a configurar |
| 12 | Secretos: búsqueda en los ficheros versionados, `.gitignore` y tokens de sesión en los logs | nada versionado; `.env`, `runs/`, `discovery/`, `.cache/` y `report/` ignorados; `mgckey` enmascarado (15/15) |
| 13 | YAML del workflow | válido (jobs `unit`, `validate`, `report`) |

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
npm run calibrate -- demo --headless       # deben cumplirse los 4 criterios
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
4. Repetir la calibración hasta que se cumplan los 4 criterios, y después `./play.sh "<url>" --game=<clave> --spins=3`.

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
- **Pages (opcional):** para publicar el informe en GitHub Pages, un administrador del repositorio debe activar Settings → Pages → Source: "GitHub Actions". Si no está activado, el workflow no falla: el informe se descarga como artefacto `validation-report` desde la página de la ejecución.
- **Mercados:** en esta PoC (solo EUR), lanzarlo a mano con `markets = ["com"]`.

## 12. Estructura del código

```
src/config/markets.ts       configuración por mercado
src/pages/BetssonPage.ts    lobby, login, saldo de la cabecera y apertura del juego (DOM de Betsson)
src/game/GamePlayer.ts      juega como una persona: espera a que esté listo, lee la pantalla, localiza y pulsa Spin
src/runner/session.ts       motor de una sesión de juego (eventos: paso, frame, captura, comprobación, fin), común a CLI e interfaz
src/runner/report.ts        informe HTML autónomo por ejecución (runs/<id>/report.html)
scripts/ui-server.ts        servidor local de la interfaz (API, eventos en vivo por SSE, ficheros de evidencias)
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
tests/unit/                 28 tests sin navegador ni cuenta (incluida la inyección de fallos)
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
