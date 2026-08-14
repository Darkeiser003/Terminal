# Herramientas de automatización

LTerminal incluye herramientas operativas reutilizables en `scripts/containers/`.
El panel **Scripts**, en el modo **Aquí**, las descubre como cualquier otro
script del proyecto y las ejecuta en la terminal visible. También se pueden usar
desde cualquier terminal convencional.

Las builds las empaquetan además como recursos de la aplicación. Por ello están
siempre disponibles en **Scripts → Favoritos**, dentro del grupo **LTerminal**,
sin importar la carpeta actual de la terminal.

Cuando uno de los gestores está visible, el panel muestra además una sección de
**Operaciones rápidas**. Sus botones preparan las consultas y acciones seguras
más habituales; **Avanzado…** abre el campo de argumentos para acceder al resto
de la CLI. En ambos casos el comando y su salida permanecen visibles.

## Docker Compose

`docker-manager.sh` toma como base el gestor v14 creado para Infraestructura
Web, pero su ámbito principal es ahora el motor Docker completo:

- gestiona contenedores, imágenes, redes y volúmenes sin requerir un proyecto;
- muestra estado, logs y estadísticas y permite iniciar, detener, reiniciar,
  inspeccionar o entrar en contenedores existentes;
- mantiene Docker Compose como subcomando opcional `compose`;
- al usar Compose busca sus archivos desde el directorio actual hacia arriba y
  permite seleccionar otra raíz con `--project` u otro archivo con `--file`;
- usa Docker Compose v2 y conserva cada argumento como un argumento real, sin
  reconstruir comandos con `eval`;
- ofrece menú interactivo y acciones automatizables (`up`, `down`, `restart`,
  `status`, `logs`, `pull`, `build`, `config`, `exec` y `prune`);
- exige confirmación antes de borrar volúmenes o recursos.

Ejemplos:

```bash
scripts/containers/docker-manager.sh status
scripts/containers/docker-manager.sh containers
scripts/containers/docker-manager.sh logs --follow --tail 200 nginx
scripts/containers/docker-manager.sh restart api redis
scripts/containers/docker-manager.sh compose up --build api worker
```

## Kubernetes

`kubernetes-manager.sh` sigue el mismo contrato de uso para `kubectl`: menú,
acciones CLI, namespace/contexto explícitos y confirmación para borrados.

```bash
scripts/containers/kubernetes-manager.sh --namespace staging status
scripts/containers/kubernetes-manager.sh --context minikube apply k8s/
scripts/containers/kubernetes-manager.sh -n staging logs --follow api-abc123
scripts/containers/kubernetes-manager.sh -n staging scale api 3
```

`--dry-run` usa la simulación del cliente de Kubernetes en las acciones que la
admiten. En Docker, `--dry-run` imprime el comando completo sin ejecutarlo.

## Criterio para nuevas herramientas

Una herramienta añadida a `scripts/<dominio>/` debería:

1. funcionar desde la terminal y desde el panel Scripts;
2. ofrecer `--help`, modo no interactivo y errores con códigos distintos de cero;
3. detectar valores razonables, pero aceptar configuración explícita;
4. no usar `eval` con entrada del usuario;
5. mostrar y confirmar las operaciones destructivas;
6. dejar la salida en la terminal visible para que se pueda auditar y cancelar.

Esta capa es adecuada para gestores de bases de datos, copias de seguridad,
despliegues y mantenimiento. Las funciones que necesiten estado persistente o
una interfaz rica pueden promoverse después a un dominio nativo del backend,
manteniendo estas CLI como contrato estable.
