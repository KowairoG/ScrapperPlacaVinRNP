# placa-a-vin — Placa costarricense → VIN

Convierte una **placa costarricense** en su **VIN / # de chasis** (más marca,
estilo, año, color, motor, categoría y estado) consultando la *Consulta de
Vehículo* gratuita del portal público **RNP Digital** (`rnpdigital.com`,
Registro Nacional de Costa Rica).

Hecho con **Playwright**. Se usa como CLI, como módulo Node o como **API HTTP**
con cache y despliegue en Docker.

> El reto técnico real no es el scraping en sí, sino sobrevivir al **WAF (F5
> ASM)** del portal y respetar su **límite de 10 consultas cada 2 minutos** sin
> que la cuenta se bloquee. Ese es el corazón del proyecto.

---

## Uso

### CLI

```bash
node index.js ABC123
node index.js ABC123 DEF456 --json --csv salida.csv
```

Banderas: `--json` (salida estructurada), `--csv <archivo>`, `--debug` (guarda
el HTML de cada consulta en `debug/consultas/`).

### Como módulo

```js
const { RnpScraper } = require('./scraper');
const s = await new RnpScraper().start();
const r = await s.consultarPlaca('ABC123');
await s.close();
```

### Salida (ejemplo ilustrativo)

```json
{
  "placa": "ABC123",
  "ok": true,
  "vin": "XXXXXXXXXXXXXXXXX",
  "fuente": "# de VIN",
  "marca": "TOYOTA",
  "estilo": "...",
  "anio": "20XX",
  "color": "...",
  "motor": "...",
  "categoria": "AUTOMOVIL",
  "estado": "INSCRITO"
}
```

`vin` es el dato final: toma `# de VIN` si el registro lo trae, si no cae a
`# de Chasis` y luego a `# de Serie`. El campo `fuente` indica cuál se usó.

---

## API HTTP

```bash
npm start        # node server.js
```

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | estado, sin api key |
| GET | `/api/vin/:placa` | consulta (cache primero) |
| GET | `/api/vin/:placa?refresh=1` | ignora cache |
| GET | `/api/vin/:placa?clase=TAX` | clases no particulares |
| POST | `/api/vin` body `{"placas":[...]}` | lote, máx 10 |
| POST | `/admin/shutdown` | apaga el servicio |

Si definís `API_KEY` en `.env`, todo excepto `/health` exige el header
`x-api-key`. Respuestas: `200` ok, `404` no encontrado, `400` placa inválida,
`502` fallo técnico (login / WAF / timeout).

El cache (`cache/vin-cache.json`) es permanente: una placa→VIN no cambia, así
que un hit de cache **no gasta cupo** del límite del portal. La cola serializa
todo: una consulta a la vez, 13 s entre consultas.

---

## Configuración

Copiá `.env.example` a `.env` y completá tus valores (ver también el archivo):

```
RNP_EMAIL=tu-correo@ejemplo.com
RNP_PASSWORD=tu-password
HEADLESS=true
API_KEY=            # opcional
```

---

## Docker

```bash
docker compose up -d --build
curl http://localhost:3000/health
```

Variables opcionales: `PORT` (3000), `IDLE_CLOSE_MIN` (15; cierra Chrome tras
inactividad y la siguiente consulta re-loguea sola).

```bash
docker compose logs -f                                 # ver actividad
docker compose restart                                 # reiniciar
rm cache/vin-cache.json && docker compose restart      # limpiar cache
docker compose up -d --build                           # redesplegar
```

El cache vive en `./cache/vin-cache.json` (volumen montado): se carga a RAM al
arrancar y se reescribe con cada consulta nueva. Sobrevive rebuilds. ~0.5 KB
por placa; aguanta ~100.000 placas antes de que convenga migrar a SQLite.

---

## Decisiones de diseño (lo interesante)

- **Chrome real obligatorio.** El sitio corre detrás de F5 ASM y responde
  *"Request Rejected"* al chromium headless-shell que trae Playwright. Por eso
  `channel: 'chrome'` y, en Docker, `google-chrome-stable` + `--no-sandbox`.
- **Throttle de 13 s entre consultas.** El portal permite 10 consultas cada 2
  minutos (≈12 s); 13 s da margen. Pasarse **bloquea la cuenta**, así que el
  scraper serializa todo en una cola y nunca paraleliza.
- **Una sola sesión por cuenta.** Un login concurrente desplaza al anterior
  (modal *"Sí, continuar"*), por eso corre una única instancia del servicio.
- **Selectores JSF por sufijo.** Los IDs de JSF (`j_idNNN`) cambian entre
  despliegues del portal; los selectores usan sufijos estables
  (`input[id$=":correo"]`) para no romperse.
- **Cache como ahorro de cupo**, no solo de latencia: placa→VIN es inmutable.

### Problemas conocidos

| Síntoma | Causa | Arreglo |
|---|---|---|
| `Request Rejected` / 502 con WAF | headless-shell o IP de salida sospechosa | verificar Chrome real en la imagen; salir desde una IP de CR |
| `Login falló: sigue pidiendo credenciales` | credenciales malas o portal caído | revisar `.env`; probar login manual |
| 502 en todas las consultas | sesión caída y re-login fallando | `docker compose restart`; revisar logs |
| Cuenta bloqueada | se excedió 10 consultas / 2 min | esperar; nunca bajar el throttle ni correr dos instancias |
| Chrome muere al arrancar (Docker) | falta `shm_size` o sandbox | mantener `shm_size: 1gb` y `--no-sandbox` |

---

## Uso responsable

Esta herramienta automatiza la **consulta pública y gratuita** que el propio
portal RNP ofrece, usando **tu cuenta** y respetando su límite de uso. El
throttle y el cache existen justamente para **no sobrecargar** el servicio.
Úsalo solo para consultas legítimas y acordes a los términos del portal.

---

## Stack

Node.js · Playwright · Express · Docker

## Licencia

MIT — ver [LICENSE](LICENSE).
