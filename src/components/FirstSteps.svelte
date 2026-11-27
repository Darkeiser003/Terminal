<script lang="ts">
    // Primeros pasos (21-11, Romen: «al abrir la app por primera vez, el
    // usuario va a tener que ver todos los popup, ¿por qué no un tour?»).
    //
    // Sale sola la primera vez (`showFirstSteps`), nunca en E2E salvo que la
    // prueba la abra, y se puede volver a abrir desde Ajustes y la paleta.
    // Mientras se ve, App esconde los avisos de abajo; al cerrarla salen.
    // Cada paso resalta el botón del que habla, si está a la vista.
    import { onMount } from 'svelte';
    import { app } from '../lib/appState.svelte';
    import { FIRST_STEPS, FIRST_STEPS_OPEN_EVENT } from '../lib/first-steps';

    let { active = $bindable(false) }: { active?: boolean } = $props();

    let index = $state(0);
    let highlight = $state<{ left: number; top: number; width: number; height: number } | null>(null);

    const step = $derived(FIRST_STEPS[index]);
    const last = $derived(index === FIRST_STEPS.length - 1);

    function open(): void {
        index = 0;
        active = true;
    }

    /** Al cerrarla ya no vuelve a salir sola. Terminarla o saltarla (también
     *  con Esc) apaga `showFirstSteps` (21-11, Romen: «al completarlo o
     *  saltarlo, automáticamente se apaga la opción»); vuelve a salir sola si
     *  se enciende otra vez en Ajustes, y siempre se puede abrir desde allí o
     *  desde la paleta. */
    function close(): void {
        active = false;
        highlight = null;
        if (app.preferences?.showFirstSteps !== false) {
            void app.savePreferences({ showFirstSteps: false });
        }
    }

    function measure(): void {
        const selector = step?.target;
        const node = selector ? document.querySelector<HTMLElement>(selector) : null;
        const rect = node?.getBoundingClientRect();
        highlight = rect && rect.width > 0 && rect.height > 0
            ? { left: rect.left - 4, top: rect.top - 4, width: rect.width + 8, height: rect.height + 8 }
            : null;
    }

    $effect(() => {
        if (!active) return;
        void index;
        measure();
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    });

    onMount(() => {
        const onOpen = () => open();
        window.addEventListener(FIRST_STEPS_OPEN_EVENT, onOpen);
        return () => window.removeEventListener(FIRST_STEPS_OPEN_EVENT, onOpen);
    });

    function onKeydown(event: KeyboardEvent): void {
        if (!active) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (last) close();
            else index += 1;
        } else if (event.key === 'ArrowLeft' && index > 0) {
            event.preventDefault();
            event.stopPropagation();
            index -= 1;
        }
    }
</script>

<svelte:window onkeydowncapture={onKeydown} />

{#if active && step}
    <div class="first-steps-backdrop" role="presentation"></div>
    {#if highlight}
        <div
            class="first-steps-highlight"
            data-testid="first-steps-highlight"
            style:left={`${highlight.left}px`}
            style:top={`${highlight.top}px`}
            style:width={`${highlight.width}px`}
            style:height={`${highlight.height}px`}
        ></div>
    {/if}
    <div
        class="first-steps"
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-steps-title"
        data-testid="first-steps"
        data-step={index + 1}
    >
        <div class="counter">
            {app.t('firstSteps.counter', 'Paso {n} de {total}')
                .replace('{n}', String(index + 1))
                .replace('{total}', String(FIRST_STEPS.length))}
        </div>
        <h2 id="first-steps-title">{app.t(`firstSteps.${step.id}.title`, step.title)}</h2>
        <p>{app.t(`firstSteps.${step.id}.text`, step.text)}</p>
        <div class="dots" aria-hidden="true">
            {#each FIRST_STEPS as item, dot (item.id)}
                <span class:current={dot === index}></span>
            {/each}
        </div>
        <div class="actions">
            <span class="grow"></span>
            {#if index > 0}
                <button type="button" data-testid="first-steps-back" onclick={() => (index -= 1)}>
                    {app.t('firstSteps.back', 'Atrás')}
                </button>
            {/if}
            {#if !last}
                <button type="button" data-testid="first-steps-skip" onclick={() => close()}>
                    {app.t('firstSteps.skip', 'Saltar')}
                </button>
            {/if}
            <button
                type="button"
                class="primary"
                data-testid="first-steps-next"
                onclick={() => (last ? close() : (index += 1))}
            >
                {last ? app.t('firstSteps.done', 'Empezar') : app.t('firstSteps.next', 'Siguiente')}
            </button>
        </div>
    </div>
{/if}

<style>
    .first-steps-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 900;
    }

    .first-steps-highlight {
        position: fixed;
        border: 2px solid var(--accent, #4aa3ff);
        border-radius: 8px;
        box-shadow: 0 0 0 4px rgba(74, 163, 255, 0.25);
        pointer-events: none;
        z-index: 901;
        transition: left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease;
    }

    .first-steps {
        position: fixed;
        left: 50%;
        bottom: 48px;
        transform: translateX(-50%);
        width: min(520px, calc(100vw - 32px));
        background: var(--surface, #1e1f22);
        color: var(--text, #e6e6e6);
        border: 1px solid var(--border, #3a3b3f);
        border-radius: 10px;
        padding: 16px 18px 14px;
        z-index: 902;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    }

    .counter {
        font-size: 12px;
        opacity: 0.7;
    }

    h2 {
        margin: 4px 0 6px;
        font-size: 16px;
    }

    p {
        margin: 0 0 12px;
        line-height: 1.45;
        font-size: 13px;
    }

    .dots {
        display: flex;
        gap: 6px;
        margin-bottom: 12px;
    }

    .dots span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--border, #3a3b3f);
    }

    .dots span.current {
        background: var(--accent, #4aa3ff);
    }

    .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .grow {
        flex: 1;
    }

    /* Como los botones de los avisos (App, `.update button`), con el
       principal en el color de acento. */
    .actions button {
        padding: 3px 12px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
    }

    .actions button.primary {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--app-bg);
        font-weight: 600;
    }

    .actions button:not(.primary):hover {
        background: var(--surface-hover);
    }

</style>
