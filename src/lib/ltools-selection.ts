import type { LToolsAction } from './types';

/** Estado de los botones elegidos para un catálogo concreto de LTools. */
export interface LToolsSelectionState {
    selectedIds: string[];
    knownIds: string[];
}

export const LTOOLS_SELECTION_KEY = 'lterminal.ltools.quick-actions.v1';

/**
 * Reconcilia la preferencia local con el catálogo actual.
 *
 * El catálogo es la fuente de verdad: una acción nueva no requiere cambios en
 * LTerminal. Las acciones nuevas marcadas como `quick` se proponen una vez;
 * después, si el usuario las quita, no vuelven a aparecer por sorpresa.
 */
export function reconcileLToolsSelection(
    actions: LToolsAction[],
    stored: unknown,
): LToolsSelectionState {
    const available = actions.filter((action) => action.requirementsAvailable);
    const availableIds = new Set(available.map((action) => action.id));
    const oldState = Array.isArray(stored)
        ? { selectedIds: stored, knownIds: [] }
        : stored && typeof stored === 'object'
            ? stored as Partial<LToolsSelectionState>
            : { selectedIds: [], knownIds: [] };
    const selected = Array.isArray(oldState.selectedIds)
        ? oldState.selectedIds.filter((id): id is string => typeof id === 'string')
        : [];
    const known = new Set(
        Array.isArray(oldState.knownIds)
            ? oldState.knownIds.filter((id): id is string => typeof id === 'string')
            : [],
    );
    const firstCatalogLoad = selected.length === 0 && known.size === 0;
    const newRecommended = available
        .filter(
        (action) => action.quick && action.safe && !known.has(action.id),
        )
        .map((action) => action.id);
    const proposed = firstCatalogLoad
        ? newRecommended
        : [...selected, ...newRecommended];
    const selectedIds = [...new Set(proposed)]
        .filter((id) => availableIds.has(id));

    return {
        selectedIds,
        knownIds: [...new Set([...known, ...availableIds])],
    };
}
