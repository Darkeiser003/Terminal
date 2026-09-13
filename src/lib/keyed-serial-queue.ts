/** Ejecuta las operaciones de cada clave en orden sin bloquear claves distintas. */
export function createKeyedSerialQueue<K>() {
    const tails = new Map<K, Promise<void>>();

    return function enqueue<T>(key: K, operation: () => Promise<T>): Promise<T> {
        const previous = tails.get(key) ?? Promise.resolve();
        const result = previous
            .catch(() => undefined)
            .then(operation);
        const tail = result.then(() => undefined, () => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) tails.delete(key);
        });
        return result;
    };
}
