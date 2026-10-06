# Notas de desarrollo

API que convierte una placa costarricense → VIN / # de chasis, scrapeando la
*Consulta de Vehículo* gratuita de `rnpdigital.com` (Registro Nacional) con
Playwright.

## Archivos

- `scraper.js` — clase `RnpScraper`: login JSF, consulta y parseo. El núcleo.
- `server.js` — API Express: cola serial, cache en disco, re-login, api key.
- `index.js` — CLI: `node index.js ABC123 [--json] [--csv out.csv]`.
- `cache/vin-cache.json` — cache permanente placa→VIN (volumen en Docker).
- `.env` — `RNP_EMAIL`, `RNP_PASSWORD`, `API_KEY` (nunca commitear).

## Restricciones duras — no relajar

1. **`channel: 'chrome'` obligatorio.** El WAF (F5 ASM) devuelve "Request
   Rejected" al headless-shell de Playwright. En Docker: `google-chrome-stable`
   + `--no-sandbox`.
2. **Throttle 13 s entre consultas (`MIN_MS`).** El portal bloquea la cuenta al
   pasar de 10 consultas / 2 min. No bajarlo, no paralelizar.
3. **Una sesión RNP por cuenta.** Un login concurrente desplaza al anterior
   (modal "Sí, continuar"). Una sola instancia del servicio.
4. **IDs JSF inestables** entre despliegues del portal. Selectores por sufijo
   (`input[id$=":correo"]`) o estables (`#carNumber`,
   `a:has(img[alt="Consultar"])`). No usar IDs `j_idNNN` completos.

## Flujo scrapeado

`login.jspx` (correo/pass, modales "Sí, continuar" y "Aceptar") →
`consultaDocumentos/paramConsultaVehiculo.jspx` → tipo=PLA, clase (select
`#class`, `' '` = particular), `#carNumber` → click img Consultar → resultado
en tablas label/valor. VIN: campo "# de VIN", fallback "# de Chasis", luego
"# de Serie".

## Probar cambios

Consultar una placa conocida con `?refresh=1` para saltar cache. Cada prueba
gasta cupo del límite del portal: probar poco.
