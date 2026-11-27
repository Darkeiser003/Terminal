// El aviso de guardar en el perfil los ajustes cambiados (21-11, Romen:
// «cuando cambias algún ajuste, no ofrece guardarlo»).
//
// Se compara la huella de los ajustes al abrir Ajustes con la de al cerrarlo.
// No cuenta lo que la app escribe sola (el tamaño de la terminal y el gestor
// de archivos detectado), igual que `customized_preferences` en el backend.

import type { Preferences, ProfileEntry } from './types';

export const SELF_WRITTEN_PREFERENCES = ['viewportCols', 'viewportRows', 'fileManagerId'] as const;

/** Huella estable de los ajustes que elige el usuario. */
export function preferencesFingerprint(preferences: Partial<Preferences> | null | undefined): string {
    if (!preferences) return '';
    const copy: Record<string, unknown> = { ...preferences };
    for (const key of SELF_WRITTEN_PREFERENCES) delete copy[key];
    return JSON.stringify(Object.keys(copy).sort().map((key) => [key, copy[key]]));
}

/** El perfil que se ofrece actualizar: el guardado más reciente. */
export function latestProfile(profiles: readonly ProfileEntry[]): ProfileEntry | null {
    let latest: ProfileEntry | null = null;
    for (const profile of profiles) {
        if (!latest || profile.modifiedMs > latest.modifiedMs) latest = profile;
    }
    return latest;
}

/** Si al cerrar Ajustes hay que ofrecer guardar en el perfil. */
export function shouldOfferProfileUpdate(
    before: string,
    after: string,
    profiles: readonly ProfileEntry[],
    enabled: boolean,
): boolean {
    return enabled && before !== '' && before !== after && profiles.length > 0;
}
