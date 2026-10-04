# BusMet · datos de la red

Este repositorio solo genera y publica los **datos de la red** de la app BusMet
(paradas, líneas y recorridos de TMB y AMB), a partir de sus GTFS oficiales.

- Cada noche, GitHub Actions ejecuta `scripts/build-data.mjs` y publica el resultado en GitHub Pages.
- Los recorridos se ajustan a las calles con Valhalla/OpenStreetMap; los ajustes se guardan en `cache/matched`
  para no repetir consultas.
- La clave de TMB se guarda como *secret* del repositorio (`TMB_APP_ID`, `TMB_APP_KEY`), nunca en el código.

Para forzar una actualización: pestaña **Actions → Actualizar red de BusMet → Run workflow**.

Fuentes: TMB Open Data, AMB Mobilitat (datos abiertos). © OpenStreetMap contributors.
