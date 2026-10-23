# Cuadro de mando familiar

Panel familiar para tablet (pensado para iPad), 
calendario de Google, clima de Puerto Montt con alertas de la DMC, tareas y rutinas,
menú semanal, lista de compras, cuenta regresiva, foto del día y pantalla de descanso.

- **Interfaz:** este sitio (GitHub Pages). Se instala en el iPad con *Compartir → Agregar a pantalla de inicio*.
- **Datos:** un proyecto de Google Apps Script en la cuenta de la familia (`apps-script/Code.gs`),
  que responde solo con la clave `KEY`. En este repositorio no hay datos personales ni claves.

## Conectar un iPad
1. En Apps Script: define `KEY` en `Code.gs` e implementa como *Aplicación web*
   (Ejecutar como: Yo · Acceso: Cualquier persona).
2. Abre una sola vez en el iPad:
   `https://rkramm.github.io/cuadro-familiar/?api=URL_DE_APPS_SCRIPT&k=TU_CLAVE`
   La conexión queda guardada solo en ese iPad.
3. *Compartir → Agregar a pantalla de inicio*.

Sin conexión, el sitio muestra una vista previa con datos de ejemplo.
