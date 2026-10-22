import type { LToolsAction } from './types';

/** Estado de los botones elegidos para un catálogo concreto de LTools. */
export interface LToolsSelectionState {
    selectedIds: string[];
    knownIds: string[];
}

export const LTOOLS_SELECTION_KEY = 'lterminal.ltools.quick-actions.v1';

/** La selección se guarda por sistema: un catálogo de Windows y otro de Linux
 *  no comparten IDs. La Biblioteca y la paleta de comandos leen la misma clave. */
export function ltoolsSelectionStorageKey(platform: string | undefined): string {
    return `${LTOOLS_SELECTION_KEY}.${platform ?? 'unknown'}`;
}

/** Las acciones fijadas, en el orden en que el usuario las eligió. */
export function pinnedLToolsActions(actions: LToolsAction[], stored: unknown): LToolsAction[] {
    const byId = new Map(actions.map((action) => [action.id, action]));
    return reconcileLToolsSelection(actions, stored).selectedIds
        .map((id) => byId.get(id))
        .filter((action): action is LToolsAction => Boolean(action));
}

/** Las que modifican el sistema piden confirmación antes de ejecutarse, se
 *  pulsen en la Biblioteca o se elijan en la paleta de comandos. */
export function ltoolsActionNeedsConfirmation(action: Pick<LToolsAction, 'mutating' | 'confirmation'>): boolean {
    return action.mutating || action.confirmation !== 'none';
}

function ltoolsBaseLabel(action: LToolsAction): string {
    return action.shortLabel?.trim() || action.label.trim() || action.id;
}

function ltoolsScope(action: LToolsAction): string {
    return action.scope || action.group || action.actionKey || action.id;
}

/**
 * El catálogo puede ser perfectamente válido y aun así publicar varios
 * «Status» o «Inventory». Conservamos el texto del catálogo, pero solo
 * añadimos el ámbito/ID cuando hace falta para que cada atajo sea
 * reconocible sin abrir el tooltip.
 */
export function ltoolsActionLabel(action: LToolsAction, catalog: LToolsAction[]): string {
    const base = ltoolsBaseLabel(action);
    const normalized = base.toLocaleLowerCase();
    const sameLabel = catalog.filter((candidate) => ltoolsBaseLabel(candidate).toLocaleLowerCase() === normalized);
    if (sameLabel.length < 2) return base;
    const scope = ltoolsScope(action);
    const sameScope = sameLabel.some(
        (candidate) => candidate.id !== action.id && ltoolsScope(candidate) === scope,
    );
    return `${base} · ${sameScope ? action.id : scope}`;
}

export function ltoolsActionMeta(action: LToolsAction): string {
    return `${action.group || action.scope} · ${action.operation || action.actionKey || action.id}`;
}

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
