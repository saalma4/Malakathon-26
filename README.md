# Intelligent Game Validation · Malackathon 2026 (Betsson)

Herramienta que valida un juego de casino de un proveedor externo (Pragmatic Play) **tal y como lo ve el jugador**, sin
acceso al DOM del juego. Abre el juego, localiza el botón Spin en pantalla, gira, observa cómo se mueven y se detienen
los rodillos, lee los valores mostrados y comprueba que el saldo cuadra:

> **saldo después = saldo antes − apuesta + premio**

Todo se ejecuta en local y sin coste: no se utilizan APIs de inteligencia artificial de pago.

---

## La solución: visión por computador + peticiones web

El juego se dibuja en un `canvas` dentro de un iframe de otro dominio, así que no hay botones ni textos que leer en el DOM.
La solución es **híbrida**: combina tres fuentes independientes y contrasta unas con otras.

| Fuente | Qué aporta | Cómo se obtiene |
|---|---|---|
| **Pantalla** (prueba principal) | Que el juego reaccionó, que el giro empezó y terminó, y que la apuesta, el saldo, el premio, la moneda y los mensajes **se ven** | Capturas de la zona del juego. Comparación de fotogramas (`pixelmatch`) para detectar movimiento. OCR local (`tesseract.js`) para leer textos. Búsqueda del botón Spin por plantilla con máscara. |
| **Peticiones web del juego** (verificación cruzada) | Apuesta, premio y saldo exactos de cada ronda | Playwright intercepta las respuestas `gameService` que el juego intercambia con el servidor del proveedor (`balance`, `c`×`l`, `tw`, `na`). |
| **Página de Betsson** | Saldo de la cuenta y moneda | Árbol de accesibilidad de la cabecera de Betsson, que es DOM propio de Betsson. |

Principios de diseño:
- **Un clic nunca es una prueba.** Cada comprobación exige que la pantalla reaccione y, cuando se puede observar, que las peticiones web coincidan.
- **El OCR confirma, no adivina.** Las fuentes de las tragaperras son muy decoradas. Por eso el OCR se usa sobre todo para confirmar que un valor ya conocido (por la red o por Betsson) está visible en pantalla. Si no lo encuentra, la comprobación falla con la captura adjunta, nunca da un PASS falso.
- **El DOM del juego no se usa nunca.** Solo se usa la posición del iframe/canvas, para hacer capturas y clics por coordenadas.

```
 Betsson ──► cabecera: saldo + moneda (DOM de Betsson)
            ┌──────── iframe/canvas del juego (solo píxeles) ────────┐
            │ capturas → diff de fotogramas → ¿empezó? ¿paró?        │
            │          → OCR                → CRÉDITO / APUESTA / €   │
            │          → plantilla Spin     → dónde hacer clic        │
            └─────────────────────────────────────────────────────────┘
 Peticiones web (gameService) → apuesta, premio, saldo → ¿coinciden con la pantalla?
```

---

## Instalación

### Requisitos

| Software | Instalación |
|---|---|
| Git | <https://git-scm.com/downloads>. En Linux: `sudo apt install git` (Ubuntu/Debian) o `sudo pacman -S git` (Arch). |
| Node.js 22 o superior | <https://nodejs.org>, versión LTS. En Linux también con [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`. |

También hace falta conexión a internet: el juego se carga desde la web y, la primera vez, se descargan el navegador y
los datos de idioma del OCR.

### Linux

```bash
git clone https://github.com/saalma4/Malakathon-26.git
cd Malakathon-26
npm ci
npx playwright install chromium
```

En algunas distribuciones Playwright muestra el aviso `BEWARE: your OS is not officially supported by Playwright`.
Es informativo: se descarga una compilación compatible. Si faltasen librerías del sistema, se pueden instalar con
`npx playwright install --with-deps chromium`.

### Windows (PowerShell)

```powershell
git clone https://github.com/saalma4/Malakathon-26.git
cd Malakathon-26
npm ci --no-audit --no-fund
npx playwright install chromium
```

Sin Git, se descarga el ZIP y se trabaja desde la carpeta `Malakathon-26-main`:

```powershell
Invoke-WebRequest -UseBasicParsing "https://github.com/saalma4/Malakathon-26/archive/refs/heads/main.zip" -OutFile main.zip
Expand-Archive main.zip -DestinationPath .
cd Malakathon-26-main
```

En Windows se usan los comandos `npm run …`. El atajo `./play.sh` requiere bash.

---

## Uso

### Interfaz web

```bash
npm run ui
```

La interfaz se abre en <http://127.0.0.1:4321>. Para lanzar una prueba:
1. En **Juego**, elegir *Demo Pragmatic Play · Sweet Bonanza (ES/EUR)*: es un juego real, gratuito y no necesita cuenta.
2. Indicar el número de **Giros**.
3. Pulsar **Play**.

Durante la ejecución se muestran el juego en directo, cada comprobación (correcta en verde, fallida en rojo, con el valor
esperado frente al observado) y las capturas anotadas que se van tomando. Al terminar se presentan el resultado global,
el vídeo de la sesión y un informe HTML (`report.html`) que se puede abrir sin servidor. El historial permite reabrir
cualquier ejecución anterior.

Notas:
- La interfaz se ejecuta sin ventana de navegador (headless); la vista en directo hace sus veces.
- Solo se permite una ejecución a la vez.
- El servidor se detiene con `Ctrl+C`, y hay que reiniciarlo si se modifica `.env` o el código.
- Para usar otro puerto: `UI_PORT=4322 npm run ui`.

### Terminal

```bash
npm run fun -- demo --headless              # demo de Pragmatic Play, 1 giro
npm run fun -- demo --headless --spins=3    # 3 giros
```

Cada ejecución imprime el resultado de cada comprobación y guarda en `runs/fun-<fecha>/` las capturas anotadas, el vídeo,
el registro de peticiones web, `result.json` y `report.html`.

### Demostración de fallos

Esta demo tiene dos objetivos:

- **Mostrar cómo se presentan los fallos.** Con un juego que funciona correctamente todas las comprobaciones pasan, así
  que esta demo permite ver cómo se indican un fallo en la interfaz y en el informe: resultado en rojo, valor esperado
  frente al observado y capturas de evidencia.
- **Demostrar que el validador detecta errores reales (control negativo).** Una herramienta que siempre diera PASS no
  probaría nada. Si se simula una integración rota y las comprobaciones afectadas fallan, queda demostrado que el
  validador distingue un juego correcto de uno defectuoso. Por eso el workflow de CI la ejecuta en cada push y exige que falle.

Se elige *Demo fallos · Sweet Bonanza (ES/EUR)* en la interfaz, o desde la terminal:

```bash
npm run fun -- demo-fallos --headless
```

El juego se ejecuta de verdad, pero se simula una integración rota: el mercado espera otra moneda y el proveedor cobra
0,10 más de la apuesta mostrada. Fallan las comprobaciones de moneda, apuesta y saldo; las de giro iniciado y giro
terminado siguen dependiendo del juego real y pasan. La interfaz y el informe indican que los fallos son intencionados.

### Juegos dentro de Betsson

```bash
npm run fun -- betsson                   # Bubble Up en betsson.es (modo "jugar gratis"), con ventana
npm run fun -- betsson --headless        # sin ventana (requiere credenciales en .env)
```

En España incluso el modo gratuito exige iniciar sesión. Se puede hacer con `ES_FUNDED_USER` y `ES_FUNDED_PASS` en `.env`,
o a mano en la ventana (sin `--headless`). El login se hace en un navegador aparte que no graba nada, y la sesión se
guarda en `.cache/browser-profile`.

### Escenarios del reto con cuentas de Betsson

```bash
cp .env.example .env           # rellenar las cuentas de prueba
npm run test:com               # escenarios 1 y 2 en betsson.com (EN/EUR)
npm run test:es                # escenarios 1 y 2 en betsson.es
npm run report                 # informe de Playwright (vídeo y capturas por comprobación)
```

betsson.com aplica geobloqueo: desde España redirige a betsson.es. Para usarlo hace falta `COM_PROXY` en `.env` o
ejecutar desde un país permitido.

---

## Comprobaciones

Las reglas de PASS/FAIL son funciones puras (`src/checks/reconcile.ts` y `src/scenarios/spin.ts`). El escenario 1 lo
comparten la interfaz, la terminal y los tests de Playwright, así que todos validan exactamente lo mismo.

**Escenario 1: giro completado en Real Play**

| Comprobación | Qué demuestra | Fuentes |
|---|---|---|
| `S1.betsson-currency` | El saldo de Betsson está en la moneda del mercado | Betsson |
| `S1.game-currency` | En el juego se ve la moneda del mercado y ninguna otra | Pantalla |
| `S1.spin-started` | El giro empezó: la pantalla cambió tras el clic y el proveedor recibió el giro | Pantalla + red |
| `S1.spin-completed` | El giro terminó: pantalla quieta y ronda cerrada | Pantalla + red |
| `S1.wager` | La apuesta mostrada es la apuesta usada | Pantalla + red |
| `S1.ingame-balance` | Saldo en juego después = antes − apuesta + premio (un premio que no se puede leer no se supone 0) | Pantalla + red |
| `S1.ingame-balance-visible` | El saldo nuevo se ve en pantalla | Pantalla |
| `S1.betsson-reconcile` | Saldo de Betsson después = antes − apuesta + premio | Betsson + red |

**Escenario 2: saldo insuficiente**

| Comprobación | Qué demuestra |
|---|---|
| `S2.betsson-currency` | Moneda del mercado en la cabecera de Betsson |
| `S2.spin-rejected` | No hubo giro: sin movimiento sostenido de rodillos y sin giro aceptado por el proveedor |
| `S2.message` | Se muestra un mensaje de saldo insuficiente (en el juego, leído por OCR, o en un diálogo de Betsson) |
| `S2.message-language` | El mensaje está en el idioma del mercado |
| `S2.game-currency` | Moneda del mercado en el juego |
| `S2.ingame-balance-unchanged` | El saldo en juego sigue siendo el mismo en pantalla (y en la red) |
| `S2.betsson-balance-unchanged` | El saldo de Betsson no cambia |

---

## Verificación

```bash
npm run typecheck                         # tipos
npm run test:unit                         # 42 tests sin navegador ni cuenta
npm run calibrate -- demo --headless      # el movimiento de un giro se distingue del reposo (4 criterios)
npm run fun -- demo --headless --spins=3  # juego real: todas las comprobaciones deben pasar
npm run fun -- demo-fallos --headless     # control negativo: las comprobaciones deben fallar
```

Los tests unitarios cubren las reglas de PASS/FAIL con datos manipulados (saldo descuadrado por un céntimo, premio no
abonado, apuesta mostrada distinta de la usada, moneda incorrecta, clic sin reacción, mensaje en otro idioma), el
escenario 1 completo, el oráculo de red, la lectura de importes, el OCR y las protecciones del servidor local.

En `runs/` se incluyen dos ejecuciones de ejemplo, con vídeo, capturas e informe: una correcta
(`fun-2026-10-15T15-51-36-848Z`, 6/6) y una con fallos forzados (`fun-2026-10-15T16-01-06-413Z`, 2/6).

---

## Integración continua (GitHub Actions)

El workflow `.github/workflows/ci.yml` se ejecuta en cada push a `main`, en cada pull request y a mano desde Actions.
No necesita credenciales:

1. **checks:** typecheck y tests unitarios.
2. **live-demo:** instala Chromium y juega la demo pública de Pragmatic Play. La ejecución normal debe pasar y la de fallos forzados debe fallar (control negativo). Escribe una tabla de resultados en el resumen de la ejecución y sube las evidencias (informes, capturas y vídeos) como artefacto `informe-validacion`.
3. **publish:** publica el informe en GitHub Pages si está activado en el repositorio (Settings → Pages → Source: GitHub Actions). Si no, el informe queda en el artefacto y el workflow no falla.

Los escenarios con cuentas de Betsson no se ejecutan en CI, porque requieren credenciales de prueba y una ubicación sin
geobloqueo. Se ejecutan en local (sección *Escenarios del reto con cuentas de Betsson*).

---

## Configuración

- **Mercados:** se definen en `src/config/markets.ts` (URL, idioma, moneda, formato numérico, juego, etiquetas del HUD y frases de saldo insuficiente).
- **Credenciales y opciones:** van en `.env`, a partir de `.env.example`.

| Variable | Uso |
|---|---|
| `COM_FUNDED_USER/PASS`, `ES_FUNDED_USER/PASS` | Cuenta con saldo (escenario 1) |
| `COM_EMPTY_USER/PASS`, `ES_EMPTY_USER/PASS` | Cuenta sin saldo utilizable (escenario 2) |
| `COM_PROXY` | Proxy para betsson.com (`http://user:pass@host:port`) |
| `COM_GAME_PATH`, `COM_GAME_KEY` | Juego de un mercado |
| `UI_PORT` | Puerto de la interfaz (por defecto 4321) |
| `RUNS_DIR` | Carpeta de salida de las ejecuciones (por defecto `runs`) |
| `HEADED=1`, `TRACE=on` | Ver el navegador o grabar traces de Playwright (contienen cookies de sesión) |

### Añadir un juego nuevo

1. Ejecutarlo una vez: `npm run fun -- "<url>" --game=<clave> --headless`.
2. Recortar el botón Spin de una captura como plantilla con máscara:
   `npm run make-template -- runs/<ejecución>/04-spin1-after.png X Y ANCHO ALTO assets/games/<clave>/spin.png`
3. Calibrar los umbrales con `npm run calibrate -- "<url>" --game=<clave>` y copiar los valores sugeridos a `assets/games/<clave>/game.json`.

Herramientas auxiliares: `npm run discover` (graba una sesión manual con peticiones y capturas) y `npm run replay`
(aplica la visión sin conexión sobre capturas guardadas).

---

## Seguridad

- No hay credenciales en el repositorio: vienen de `.env` (ignorado por git) o de variables de entorno.
- El login se hace en un navegador sin vídeo ni trace; solo la sesión pasa al contexto que graba, así que lo que se teclea no aparece en las evidencias.
- Los tokens de sesión del proveedor (`mgckey`) se enmascaran en todos los registros.
- El servidor de la interfaz solo escucha en `127.0.0.1`. Además:
  - rechaza peticiones de otros orígenes (CSRF) o con otro `Host` (DNS rebinding);
  - exige `application/json` para iniciar una ejecución;
  - valida todas las entradas y no sirve ficheros fuera de sus carpetas.

---

## Estructura del código

```
src/config/markets.ts       configuración por mercado
src/pages/BetssonPage.ts    login, saldo de la cabecera y apertura del juego (DOM de Betsson)
src/game/GamePlayer.ts      juega como una persona: espera a que el juego esté listo, lee la pantalla, pulsa Spin
src/scenarios/spin.ts       escenario 1: observeSpin → extractFacts → evaluateSpin (+ applyFault)
src/checks/                 reglas PASS/FAIL puras y registro de comprobaciones con evidencias
src/vision/                 capturas, diff de fotogramas, OCR, plantillas y capturas anotadas
src/oracle/pragmatic.ts     lectura de las peticiones web del proveedor (gameService)
src/runner/                 motor de sesión (eventos en vivo) e informe HTML
src/server/security.ts      protecciones del servidor local
src/reporter/summary.ts     matriz PASS/FAIL de los tests de Playwright
src/util/                   importes, argumentos de línea de comandos, escape HTML
scripts/                    interfaz (ui-server), terminal (play-fun), CI (ci-summary) y herramientas
ui/                         interfaz web (HTML/CSS/JS sin compilación)
tests/unit/                 tests sin navegador ni cuenta
tests/e2e/                  escenarios 1 y 2 contra Betsson (requieren cuenta)
assets/games/<juego>/       plantilla del botón Spin y umbrales calibrados
```

---

## Limitaciones

- **Moneda:** solo se ha validado EUR. El soporte de PEN (betsson.pe) está esbozado pero no probado.
- **Juegos calibrados:** solo Sweet Bonanza. Bubble Up necesita su plantilla y calibración.
- **Escenarios con Betsson:** dependen de cuentas de prueba y de una ubicación sin geobloqueo.
- **OCR con saldos grandes:** puede confundir dígitos (por ejemplo, leer "N00.018,0" en lugar de "100.018,50"). En ese caso la comprobación de saldo visible falla; nunca da un PASS falso.
- **Tiradas gratis o bonus:** si un giro las activa, la ronda puede no cerrarse en el tiempo previsto y la comprobación falla.
- **Modo con ventana:** puede fallar en gestores de ventanas en mosaico (por ejemplo, Hyprland); se recomienda `--headless`.

---

## Solución de problemas

| Síntoma | Solución |
|---|---|
| `Geo-redirected from www.betsson.com to www.betsson.es` | Geobloqueo: usar `COM_PROXY` o una ubicación permitida |
| `Sin sesión y sin ES_FUNDED_USER/PASS en .env` | Ejecutar sin `--headless` e iniciar sesión a mano, o rellenar `.env` |
| `Game did not become playable in time` | Ejecutar con `DEBUG_VISION=1` y revisar `runs/debug-ready.png` |
| `Spin localizado por config` o `keyboard` | No hay plantilla del botón o no coincide: crearla o recalibrarla |
| Avisos `Fontconfig warning` o `BEWARE` | Son informativos y no afectan al funcionamiento |
