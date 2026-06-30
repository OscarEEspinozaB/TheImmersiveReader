# The Immersive Reader — Activar el servidor web

> Estado: **Referencia / runbook.** Última actualización 2026-06-25.
>
> Cómo levantar el servidor web del proyecto y llegar a él desde otros dispositivos de
> la red local (ej. el celular) en `http://192.168.100.6:5173/`.

## 1. Qué es "el servidor"

La Fase 1 es una app **100% del lado del cliente** (JavaScript puro + Vite, sin
backend). El "servidor" es solo el **dev server de Vite**, que sirve los archivos y
recarga en caliente mientras editas. No hay nada más que arrancar para usar la app.

> Ollama (el modelo de IA) es un servidor **distinto** y opcional; eso es otro tema.
> Este documento es solo el servidor web.

## 2. Ya está configurado para la red local

[vite.config.js](../vite.config.js) trae:

```js
server: {
  host: true,   // escucha en todas las interfaces de red, no solo localhost
  port: 5173,
}
```

`host: true` hace que el server escuche en todas las interfaces, así que es accesible
desde otros equipos de la LAN. Tu IP en esta máquina es **`192.168.100.6`**, por eso la
URL queda `http://192.168.100.6:5173/`. No hay que cambiar nada de la config.

## 3. Activarlo

```bash
# 1. Instalar dependencias (solo la primera vez, o si cambió package.json)
npm install

# 2. Arrancar el servidor de desarrollo
npm run dev
```

Vite imprime dos URLs:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.100.6:5173/
```

- **Local** — para el navegador de esta misma máquina.
- **Network** — pégala en el celular u otro equipo conectado al **mismo WiFi/LAN**.

Déjalo corriendo en esa terminal; mientras esté abierta, el server vive. `Ctrl+C` lo
apaga.

## 4. Llegar desde el celular

1. Que el celular esté en la **misma red** que esta máquina.
2. Abrir `http://192.168.100.6:5173/` en el navegador del celular.

Si la IP cambia (DHCP), vuelve a mirarla con:

```bash
hostname -I        # la primera es la de la LAN, ej. 192.168.100.6
```

## 5. Si no carga desde otro dispositivo

| Síntoma | Causa probable | Arreglo |
| --- | --- | --- |
| Local funciona, Network no | Firewall del host bloquea el 5173 | `sudo ufw allow 5173/tcp` |
| El celular no abre la página | No están en la misma red / aislamiento de clientes del router | Mismo WiFi; desactivar "AP/client isolation" en el router |
| La IP no es 192.168.100.6 | DHCP la reasignó | `hostname -I` y usar la nueva (o fijar IP estática en el router) |
| `port 5173 is in use` | Ya hay un `npm run dev` corriendo | Cerrar el otro, o Vite usará 5174 automáticamente |

## 6. Versión de producción (build servido, no dev)

El dev server es para desarrollo (recarga en caliente). Para servir el build optimizado:

```bash
npm run build      # genera dist/
npm run preview    # sirve dist/ — también expuesto en la red por la misma config
```

`preview` usa el mismo `host: true`, así que también queda en
`http://192.168.100.6:4173/` (puerto de preview de Vite por defecto).

## 7. Dejarlo corriendo en segundo plano (opcional)

Para que no dependa de tener la terminal abierta:

```bash
nohup npm run dev > /tmp/tir-dev.log 2>&1 &   # arranca desacoplado, log en el archivo
```

Para pararlo después: `pkill -f vite` (o busca el PID con `jobs` / `ps`).
