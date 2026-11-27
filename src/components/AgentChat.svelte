<script lang="ts">
    // Chat lateral con los agentes de IA (12-11, idea de Romen): preguntar a
    // una IA del equipo sin entrar en su CLI, con el contexto de la terminal
    // si se quiere. El backend (`environments/agent_chat.rs`) abre la CLI una
    // vez por pregunta. Este panel nunca ejecuta nada: un bloque de código se
    // puede insertar en la terminal SIN Intro, o copiar.
    //
    // 13-11, segunda vuelta (Romen: «la UI es muy plástica, muy hecha por una
    // IA»; «lo de escribir el modelo a mano, y que el de fábrica sea "el de
    // siempre"»; «los demás fallaron y no me ofrecieron abrir la sesión»):
    // - aspecto de terminal: transcripción con prompt, letra de terminal, sin
    //   burbujas, avatares ni portada con icono;
    // - el modelo se elige de una lista, y la primera opción dice el que usa
    //   el agente de verdad (leído de su configuración, `agent_chat_models`);
    // - tras un fallo, la solución ahí mismo: meter la clave, abrir el agente
    //   en su pestaña para iniciar sesión o configurarlo, o avisar de Python;
    // - las IA que no entran en el chat salen con su motivo y un enlace para
    //   abrirlas en su pestaña.
    //
    // 14-11 noche (Romen, probando la 62): la lista de agentes se vuelve a
    // pedir cuando acaba la detección; el clip vuelve; agente en su fila y
    // modelo, intensidad y permisos juntos; el error, resumido en una línea
    // con lo que dijo el agente plegado; las IA que solo van en su pestaña,
    // al final del desplegable de agentes (antes, un renglón «En su
    // pestaña:» que no se entendía); «Otro…» solo si la lista del agente
    // puede estar incompleta.
    import { onDestroy, onMount, tick, untrack } from 'svelte';
    import * as api from '../lib/api';
    import { app } from '../lib/appState.svelte';
    import { panels } from '../lib/panels.svelte';
    import { getTerminalControls } from '../lib/terminalRegistry';
    import {
        answerModel,
        buildChatPrompt,
        conversationTranscript,
        errorHeadline,
        formatBytes,
        parseTextBlocks,
        redactSecrets,
        splitAgentAnswer,
        stripAnsi,
        type ChatTurn,
    } from '../lib/agent-chat';
    import { autoTitle, canResumeNative, cleanAgentTitle, nativeAfterAnswer, newChatId, toStoredMessages, type NativeLink, type NativeSession, type StoredChat } from '../lib/agent-chat-history';
    import type { AgentChatAgent, AgentChatAttachment, AgentChatFailureHelp, AgentChatModels } from '../lib/types';
    import type { UnlistenFn } from '@tauri-apps/api/event';

    type Message = {
        id: number;
        role: 'user' | 'agent';
        agent: string;
        text: string;
        pending: boolean;
        error: string | null;
        requestId: number | null;
        /** Usuario: el contexto y los adjuntos que se mandaron con la pregunta. */
        context?: string | null;
        attachments?: { name: string; bytes: number; truncated: boolean }[];
        /** Agente: con qué se preguntó (para repetir) y cuánto tardó. */
        ask?: { agentId: string; prompt: string; question: string; model: string; effort: string; mode: string; fast: boolean; fullPrompt?: string; session?: NativeSession | null };
        startedAt?: number;
        /** Agente: la sesión que dijo abrir la CLI (Codex). */
        nativeSession?: string;
        /** Agente: la pregunta retomó la sesión propia (24-11). */
        resumed?: boolean;
        finishedAt?: number;
        /** Agente: el reintento por saturación en curso (`agent-chat-status`). */
        retry?: { attempt: number; max: number; status: number } | null;
        /** Agente: el modelo que dice estar usando la CLI (Codex lo dice). */
        reportedModel?: string;
        /** Lo que dijo el agente al fallar, entero (se enseña plegado). */
        errorDetail?: string;
        /** Tras un fallo: lo que lo arregla (`agent_chat_failure_help`). */
        help?: AgentChatFailureHelp | null;
        keyDraft?: string;
        keyError?: string;
    };

    // Dentro de AgentChats (14-11): varios chats en paralelo, uno por pestaña.
    // `embedded`: sin borde, ancho ni cierre propios (los lleva el
    // contenedor); `active`: es el que se ve; `onstatus` le dice al
    // contenedor si está trabajando y con qué agente.
    //
    // Historial (23-11): `chatId` es el archivo de esta conversación y
    // `restore`, la conversación guardada que se reabre. Cada cambio se
    // guarda (si el ajuste del historial está encendido) y `onstatus` le pasa
    // al contenedor el id, el título y si está vacío.
    let {
        embedded = false,
        active = true,
        chatId = undefined,
        restore = null,
        help = false,
        onstatus = undefined,
    }: {
        embedded?: boolean;
        active?: boolean;
        chatId?: string;
        restore?: StoredChat | null;
        /** El chat de ayuda: recoge las preguntas del aviso de ayuda con IA. */
        help?: boolean;
        onstatus?: (status: { busy: boolean; agent: string; chatId: string; title: string; empty: boolean }) => void;
    } = $props();

    const WIDTH_KEY = 'wterminal.agentChat.width';
    const CHOICES_KEY = 'wterminal.agentChat.choices';
    const MIN_WIDTH = 300;
    const MAX_WIDTH = 900;
    const MAX_ATTACHMENTS = 5;
    /** El valor de «Otro…» en la lista de modelos: se escribe a mano. */
    const OTHER_MODEL = '__other__';
    /** Las IA que solo van en su pestaña, dentro del desplegable de agentes:
     *  elegir una la abre, sin cambiar el agente del chat. */
    const TAB_AGENT = '__tab__:';
    /** Los motivos que algo puede quitar: «Dejar editar», «Omitir permisos» o
     *  la configuración del propio agente. */
    const UNLOCKABLE_REASONS = new Set(['needs-edit', 'needs-bypass', 'needs-config']);
    /** Los modos de permisos que cambian archivos (piden `agentChatCanEdit`). */
    const EDITING_MODES = ['acceptEdits', 'auto', 'bypass'];

    let agents = $state<AgentChatAgent[]>([]);
    let agentId = $state('');
    let loading = $state(true);
    let messages = $state<Message[]>([]);
    let draft = $state('');
    let withContext = $state(false);
    let notice = $state('');
    let attachments = $state<AgentChatAttachment[]>([]);
    let model = $state('');
    let customModel = $state(false);
    let effort = $state('');
    /** El modo de permisos elegido; vacío: el de fábrica del agente. */
    let mode = $state('');
    let fast = $state(false);
    let modelsByAgent = $state<Record<string, AgentChatModels>>({});
    let width = $state(readWidth());
    let now = $state(Date.now());
    let atBottom = $state(true);
    let list = $state<HTMLDivElement | undefined>(undefined);
    let input = $state<HTMLTextAreaElement | undefined>(undefined);
    let customInput = $state<HTMLInputElement | undefined>(undefined);
    let agentSelect = $state<HTMLSelectElement | undefined>(undefined);
    let nextId = 0;
    let clock: ReturnType<typeof setInterval> | undefined;
    // La conversación guardada: su archivo, su título y cuándo empezó.
    let conversationId = $state(untrack(() => restore?.id ?? chatId ?? newChatId()));
    /** El nombre fijo del chat de ayuda. */
    function helpTitle(): string {
        return app.t('agentChat.helpChatTitle', 'Ayuda de WTerminal');
    }
    let title = $state(untrack(() => restore?.title || (help ? helpTitle() : '')));
    let titleEdited = $state(untrack(() => restore?.titleEdited === true));
    let createdAt = untrack(() => restore?.createdAt ?? Date.now());
    // La sesión propia del agente que ya conoce esta conversación (24-11).
    let native = $state<NativeLink | null>(untrack(() => restore?.native ?? null));
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    // Lo guardado vuelve tal cual: mensajes, agente (si sigue en la lista; si
    // no, `loadAgents` elige otro) y título.
    untrack(() => {
        if (!restore) return;
        messages = restore.messages.map((message) => ({ ...message, id: ++nextId, pending: false, requestId: null }));
        agentId = restore.agentId;
    });
    const unlisten: UnlistenFn[] = [];

    const pending = $derived(messages.find((message) => message.pending) ?? null);
    const chatAgents = $derived(agents.filter((item) => item.chat));
    /** «Solo en su pestaña»: las que algo puede dejar entrar en el chat, un
     *  ajuste de WTerminal (Amp, Grok) o su configuración (Continue). Las que
     *  nunca contestan aquí (aider, que edita por su cuenta) no se ofrecen:
     *  se abren desde el selector de entornos (15-11, Romen: «no vale de nada
     *  en la barra»). */
    const tabOnlyAgents = $derived(agents.filter((item) => !item.chat && UNLOCKABLE_REASONS.has(item.unavailable ?? '')));
    /** La detección completa de entornos (la que trae las IA) aún no llegó. */
    const detecting = $derived(app.inventory === null);
    const agent = $derived(chatAgents.find((item) => item.id === agentId) ?? null);
    const agentLabel = $derived(agent?.label ?? '');
    const models = $derived(modelsByAgent[agentId] ?? null);
    const otherModels = $derived((models?.models ?? []).filter((item) => item !== models?.defaultModel));
    const modelValue = $derived(customModel ? OTHER_MODEL : model);
    /** La intensidad que admite el modelo elegido (Codex la dice por modelo); si
     *  no, la del agente. */
    const effortLevels = $derived((model && models?.efforts?.[model]) || agent?.efforts || []);
    // Un modelo que no admite la intensidad elegida la vuelve a «Por defecto».
    $effect(() => {
        if (effort && !effortLevels.includes(effort)) effort = '';
    });
    const remember = $derived(app.preferences?.agentChatRemember !== false);
    /** Claude Code y Codex retoman su sesión (`agentChatNativeSessions`). */
    function nativeOn(id: string): boolean {
        return remember && app.preferences?.agentChatNativeSessions !== false
            && agents.some((item) => item.id === id && item.nativeSessions === true);
    }
    /** Una sesión nueva (Claude Code la abre con este id; Codex, con el suyo). */
    function freshSession(id: string): NativeSession | null {
        return nativeOn(id) ? { id: crypto.randomUUID(), resume: false } : null;
    }
    const canEdit = $derived(app.preferences?.agentChatCanEdit === true);
    const allowBypass = $derived(canEdit && app.preferences?.agentChatAllowBypass === true);
    // Los modos (14-11, Romen con el menú de Claude: «los permisos tmb»). El
    // de fábrica solo lee; con «editar» encendido, «Aceptar ediciones».
    const modes = $derived(agent?.modes ?? []);
    const defaultMode = $derived(canEdit && modes.includes('acceptEdits') ? 'acceptEdits' : (modes[0] ?? ''));
    const effectiveMode = $derived(mode || defaultMode);
    // Un modo que ya no está permitido (se apagó el ajuste) vuelve al de fábrica.
    $effect(() => {
        if (mode && (!modes.includes(mode) || !modeAllowed(mode))) mode = '';
    });
    /** El modo rápido: Claude Code siempre; Codex, si el modelo lo trae. */
    const fastAvailable = $derived.by(() => {
        if (!agent?.fast) return false;
        const list = models?.fast;
        const current = model.trim() || models?.defaultModel || '';
        return !list || !current || list.includes(current);
    });
    $effect(() => {
        if (fast && !fastAvailable) fast = false;
    });

    // El modo consejero deja una pregunta preparada (sin mandarla): se recoge
    // en el campo, con el contexto marcado, y el usuario decide si la envía.
    // Solo el chat que se ve: con varios, la recogería uno escondido.
    // La del aviso de ayuda solo la recoge el chat de ayuda (el contenedor lo
    // abre o lo crea y lo pone delante); con «Mandar sola la pregunta de
    // ayuda», se manda en cuanto el agente está listo.
    let sendWhenReady = $state(false);
    $effect(() => {
        const prepared = app.agentChatDraft;
        if (!prepared || !active || (prepared.help === true && !help)) return;
        draft = prepared.text;
        withContext = prepared.withContext;
        app.agentChatDraft = null;
        sendWhenReady = prepared.help === true && app.preferences?.agentChatAdvisorSend === true;
        void tick().then(() => {
            autoGrow();
            input?.focus();
        });
    });
    $effect(() => {
        if (!sendWhenReady || loading || pending) return;
        sendWhenReady = false;
        if (agentId && draft.trim()) void send();
    });

    // Al contenedor: si este chat trabaja, con qué agente, su archivo y su
    // título (su pestaña y la sesión).
    const historyOn = $derived(app.preferences?.agentChatHistory !== false);
    $effect(() => {
        onstatus?.({ busy: pending !== null, agent: agentLabel, chatId: conversationId, title, empty: messages.length === 0 });
    });

    // ---- Historial ----

    /** Guarda la conversación (sin esperar: un fallo de disco no corta el
     *  chat). Sin mensajes no hay nada que guardar. */
    function persistNow(): void {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = undefined;
        if (!historyOn || messages.length === 0) return;
        const firstQuestion = messages.find((message) => message.role === 'user')?.text ?? '';
        if (!titleEdited) title = help ? helpTitle() : autoTitle(firstQuestion) || title;
        const label = agentLabel || messages.find((message) => message.agent)?.agent || '';
        const chat: StoredChat = {
            version: 1,
            id: conversationId,
            title,
            titleEdited: titleEdited || undefined,
            agentId,
            agentLabel: label,
            createdAt,
            updatedAt: Date.now(),
            messages: toStoredMessages(messages, app.t('agentChat.interrupted', 'Cortado: se cerró el chat mientras contestaba.')),
            native: native ?? undefined,
            help: help || undefined,
        };
        void api.agentChatHistorySave(chat).catch(() => {});
    }

    /** Guarda poco después: varios cambios seguidos (cada trozo de una
     *  respuesta no, solo los cambios de estado) en una sola escritura. */
    function persistSoon(): void {
        if (destroyed) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(persistNow, 400);
    }

    /** Cambia el título desde el historial; ya no se cambia solo. */
    export function rename(next: string): void {
        const clean = next.trim().slice(0, 120);
        if (!clean) return;
        title = clean;
        titleEdited = true;
        persistNow();
    }

    /** El historial borró esta conversación: lo de pantalla empieza de cero
     *  con otro archivo, para no volver a guardarla. */
    export function forget(): void {
        if (pending) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = undefined;
        messages = [];
        startFresh();
    }

    /** El chat de ayuda que caducó (24-11): guarda este y empieza otro en la
     *  misma pestaña. Devuelve el id del que se dejó. */
    export function restartConversation(): string | null {
        if (pending) return null;
        const previous = messages.length ? conversationId : null;
        persistNow();
        messages = [];
        startFresh();
        return previous;
    }

    /** El id de esta conversación (el contenedor lo usa para fijarla). */
    export function currentId(): string {
        return conversationId;
    }

    /** Cuándo empezó y cuántos mensajes lleva (caducidad del chat de ayuda). */
    export function age(): { createdAt: number; messages: number } {
        return { createdAt, messages: messages.length };
    }

    function startFresh(): void {
        titleAsked = false;
        native = null;
        conversationId = newChatId();
        title = help ? helpTitle() : '';
        titleEdited = false;
        createdAt = Date.now();
        notice = '';
    }

    // Al volver a la vista, el foco al campo de la pregunta.
    $effect(() => {
        if (active) void tick().then(() => input?.focus());
    });

    // La lista de agentes sale de la detección de entornos, que puede acabar
    // después de abrir el chat (14-11, Romen: «no muestra nada y no se
    // actualiza solo, tengo que cerrarlo y volver a abrirlo»): se vuelve a
    // pedir cada vez que llega un inventario nuevo.
    $effect(() => {
        void app.environments;
        untrack(() => void loadAgents());
    });

    // Al cambiar de agente (y SOLO entonces: `untrack`): su modelo e
    // intensidad de la última vez, y sus modelos, que se piden una vez por
    // agente. Sin `untrack`, la lista al llegar volvía a ejecutar esto y
    // borraba el modelo elegido mientras tanto (14-11, prueba de IA).
    $effect(() => {
        const id = agentId;
        if (!id) return;
        untrack(() => {
            const saved = readChoices()[id];
            model = saved?.model ?? '';
            customModel = false;
            effort = saved?.effort && agent?.efforts.includes(saved.effort) ? saved.effort : '';
            mode = saved?.mode && agent?.modes.includes(saved.mode) ? saved.mode : '';
            fast = saved?.fast === true && agent?.fast === true;
            if (!modelsByAgent[id] && agent?.modelChoice) {
                void api.agentChatModels(id).then((loaded) => {
                    modelsByAgent[id] = loaded;
                }).catch(() => {
                    modelsByAgent[id] = { defaultModel: null, source: null, models: [], efforts: {}, fast: null, custom: true };
                });
            }
        });
    });

    // Un modelo guardado que ya no está en la lista se enseña como «Otro…»,
    // si el agente lo admite; si su lista es completa, vuelve al de fábrica.
    $effect(() => {
        if (!models || !model || model === models.defaultModel || models.models.includes(model)) return;
        if (models.custom) customModel = true;
        else untrack(() => { model = ''; customModel = false; });
    });

    // ---- Lo que se recuerda en este navegador (comodidad, no ajustes) ----

    function readWidth(): number {
        try {
            const value = Number(localStorage.getItem(WIDTH_KEY));
            return Number.isFinite(value) && value >= MIN_WIDTH ? Math.min(value, MAX_WIDTH) : 380;
        } catch {
            return 380;
        }
    }

    function readChoices(): Record<string, { model?: string; effort?: string; mode?: string; fast?: boolean }> {
        try {
            const value = JSON.parse(localStorage.getItem(CHOICES_KEY) ?? '{}');
            return value && typeof value === 'object' ? value : {};
        } catch {
            return {};
        }
    }

    function saveChoice(): void {
        if (!agentId) return;
        try {
            const choices = readChoices();
            choices[agentId] = { model: model.trim(), effort, mode, fast };
            localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
        } catch {
            // Sin almacenamiento (modo privado): se elige cada vez.
        }
    }

    function chooseModel(value: string): void {
        if (value === OTHER_MODEL) {
            customModel = true;
            model = '';
            void tick().then(() => customInput?.focus());
            return;
        }
        customModel = false;
        model = value;
        saveChoice();
    }

    function modeAllowed(id: string): boolean {
        if (id === 'bypass') return allowBypass;
        return !EDITING_MODES.includes(id) || canEdit;
    }

    function chooseMode(value: string): void {
        if (!modeAllowed(value)) return;
        mode = value === defaultMode ? '' : value;
        saveChoice();
    }

    function modeLabel(id: string): string {
        return app.t(`agentChat.mode.${id}`, id);
    }

    function modeHint(id: string): string {
        const hints: Record<string, string> = {
            plan: 'Solo lee y propone: no cambia nada.',
            manual: 'Lo que pida permiso se le niega (el chat no puede preguntarte): lee, pero no cambia nada.',
            acceptEdits: 'Cambia archivos de la carpeta de la pestaña sin preguntarte.',
            auto: 'El propio agente decide qué es seguro y lo hace; lo arriesgado lo frena.',
            bypass: 'Hace todo sin preguntarte, también ejecutar órdenes y borrar archivos. Peligroso.',
        };
        return app.t(`agentChat.modeHint.${id}`, hints[id] ?? '');
    }

    // ---- Agentes ----

    async function loadAgents(): Promise<void> {
        // Al recargar con la lista ya puesta no se bloquea el desplegable.
        loading = agents.length === 0;
        try {
            agents = await api.agentChatAgents();
            if (!agents.some((item) => item.chat && item.id === agentId)) {
                agentId = agents.find((item) => item.chat)?.id ?? '';
            }
        } catch {
            agents = [];
        } finally {
            loading = false;
        }
    }

    /** El desplegable de agentes: una IA de pestaña se abre en la suya y el
     *  chat sigue con el agente que tenía. */
    function chooseAgent(value: string): void {
        if (value.startsWith(TAB_AGENT)) {
            openAgentTab(value.slice(TAB_AGENT.length));
            if (agentSelect) agentSelect.value = agentId;
            return;
        }
        agentId = value;
    }

    /** Abre el agente en una pestaña nueva: ahí se inicia sesión, se
     *  configura o se usa con su pantalla completa. */
    function openAgentTab(envId: string): void {
        void app.createTab(envId);
    }

    function unavailableReason(code: string | null): string {
        switch (code) {
            case 'args-only':
                return app.t('agentChat.reasonArgsOnly', 'Solo acepta la pregunta como argumento y no se puede dejar en solo lectura: ábrelo en su pestaña.');
            case 'edits-files':
                return app.t('agentChat.reasonEditsFiles', 'Edita archivos por su cuenta: mejor en su pestaña, donde ves lo que hace.');
            case 'needs-edit':
                return app.t('agentChat.reasonNeedsEdit', 'Cambia archivos sin preguntar y no puede quedarse en solo leer: entra en el chat con «Dejar que los agentes del chat editen archivos» activado en Ajustes. Mientras, ábrelo en su pestaña.');
            case 'needs-bypass':
                return app.t('agentChat.reasonNeedsBypass', 'Hace todo sin preguntar (órdenes y cambios de archivos) y no puede quedarse en solo leer: entra en el chat solo con «Omitir permisos» habilitado en Ajustes. Mientras, ábrelo en su pestaña.');
            case 'needs-permissions':
                return app.t('agentChat.reasonNeedsPermissions', 'Pide permiso para todas sus herramientas: úsalo en su pestaña.');
            case 'needs-cmd':
                return app.t('agentChat.reasonNeedsCmd', 'Su lanzador solo funciona a través de cmd, que interpretaría lo que escribes: úsalo en su pestaña.');
            case 'needs-config':
                return app.t('agentChat.reasonNeedsConfig', 'Le falta su config.yaml con algún modelo (en ~/.continue): sin él no tiene con qué contestar.');
            default:
                return app.t('agentChat.reasonNoOneShot', 'No tiene modo de una pregunta: ábrelo en su pestaña.');
        }
    }

    // ---- Desplazamiento ----

    function onScroll(): void {
        if (!list) return;
        atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    }

    async function scrollToEnd(force = false): Promise<void> {
        await tick();
        if (list && (force || atBottom)) {
            list.scrollTop = list.scrollHeight;
            atBottom = true;
        }
    }

    // ---- La pregunta ----

    /** La pregunta y, si se pidió, la última orden de la pestaña activa con
     *  su salida. Se enseña en el propio mensaje: el usuario ve qué se mandó. */
    function composeContext(): string | null {
        if (!withContext || !app.activeTabId) return null;
        const last = getTerminalControls(app.activeTabId)?.lastCommandContext() ?? null;
        if (!last) {
            notice = app.t('agentChat.noContext', 'Esta pestaña no marca sus órdenes: la pregunta va sin contexto.');
            return null;
        }
        const shell = app.activeTab?.label ?? '';
        const raw = [
            app.t('agentChat.contextHeader', 'Contexto de mi terminal ({shell}):').replace('{shell}', shell),
            `$ ${last.command}`,
            last.output,
            last.exitCode !== null ? app.t('agentChat.contextExit', '(código de salida: {code})').replace('{code}', String(last.exitCode)) : '',
        ].filter(Boolean).join('\n');
        // Las claves, tokens y contraseñas que salieran en la terminal no se
        // mandan al agente.
        const { text: context, count } = redactSecrets(raw);
        if (count > 0) {
            notice = app.t('agentChat.redacted', 'Se ocultaron {count} secretos del contexto antes de mandarlo.').replace('{count}', String(count));
        }
        return context;
    }

    /** Las vueltas anteriores (pregunta y respuesta) que el agente debe recordar. */
    function history(): ChatTurn[] {
        const turns: ChatTurn[] = [];
        for (let index = 0; index < messages.length; index += 1) {
            const question = messages[index];
            const answer = messages[index + 1];
            if (question.role === 'user' && answer?.role === 'agent' && !answer.pending && !answer.error) {
                turns.push({ question: question.text, answer: answer.text });
            }
        }
        return turns;
    }

    async function send(): Promise<void> {
        const question = draft.trim();
        if (!question || !agentId || pending) return;
        notice = '';
        const context = composeContext();
        const transcript = remember
            ? conversationTranscript(history(), {
                you: app.t('agentChat.you', 'Tú'),
                agent: app.t('agentChat.agentRole', 'Agente'),
            })
            : '';
        const labels = {
            conversation: app.t('agentChat.promptConversation', 'Conversación hasta ahora:'),
            attachment: app.t('agentChat.promptAttachment', 'Archivo adjunto «{name}»:'),
            truncated: app.t('agentChat.promptTruncated', 'solo el principio'),
            question: app.t('agentChat.promptQuestion', 'Pregunta:'),
        };
        const fullPrompt = buildChatPrompt({ question, transcript, attachments, context, labels });
        // Claude Code y Codex retoman su sesión (24-11): solo va lo nuevo. Si
        // no se puede (otro agente, un fallo en medio), una sesión nueva con
        // la conversación entera.
        const resume = nativeOn(agentId) && canResumeNative(native, agentId, messages.length);
        const session: NativeSession | null = resume && native ? { id: native.id, resume: true } : freshSession(agentId);
        const prompt = resume ? buildChatPrompt({ question, transcript: '', attachments, context, labels }) : fullPrompt;
        const sent = attachments.map(({ name, bytes, truncated }) => ({ name, bytes, truncated }));
        draft = '';
        attachments = [];
        autoGrow();
        saveChoice();
        messages.push({ id: ++nextId, role: 'user', agent: agentLabel, text: question, pending: false, error: null, requestId: null, context, attachments: sent });
        persistSoon();
        await ask({ agentId, prompt, question, model: model.trim(), effort, mode: effectiveMode, fast: fast && fastAvailable, fullPrompt, session });
        void titleWithAgent();
    }

    async function ask(request: NonNullable<Message['ask']>): Promise<void> {
        const label = agents.find((item) => item.id === request.agentId)?.label ?? agentLabel;
        const answer: Message = { id: ++nextId, role: 'agent', agent: label, text: '', pending: true, error: null, requestId: null, ask: request, startedAt: Date.now(), resumed: request.session?.resume === true };
        messages.push(answer);
        await scrollToEnd(true);
        try {
            const requestId = await api.agentChatAsk(request.agentId, request.prompt, app.activeTabId, request.model, request.effort, request.mode, request.fast, request.session ?? null);
            const target = messages.find((message) => message.id === answer.id);
            if (target) target.requestId = requestId;
        } catch (error) {
            const target = messages.find((message) => message.id === answer.id);
            if (!target) return;
            const reason = String(error);
            // El agente o el modo no retoman sesión (Codex en automático) o
            // el ajuste se apagó: la misma pregunta, con la conversación entera.
            if (request.session && reason.includes('session-unsupported')) {
                native = null;
                await replaceAnswer(target, { ...request, prompt: request.fullPrompt ?? request.prompt, session: null });
                return;
            }
            target.pending = false;
            target.finishedAt = Date.now();
            const needsKey = /needs-key:([A-Z0-9_]+)/u.exec(reason);
            if (needsKey) {
                // ShellGPT sin clave la pide por consola y se colgaría: no se
                // lanza, y se ofrece la clave aquí (14-11).
                target.error = app.t('agentChat.needsKeyFirst', '{agent} pide su clave ({envVar}) por consola si no la tiene, y el chat se quedaría esperando: no se ha lanzado.')
                    .replace('{agent}', label)
                    .replace('{envVar}', needsKey[1]);
                void api.agentChatFailureHelp(request.agentId, needsKey[1]).then((help) => {
                    const current = messages.find((message) => message.id === target.id);
                    if (current) current.help = help.apiKey || help.openTab ? help : { apiKey: null, openTab: 'setup', pythonModule: false };
                }).catch(() => {});
                return;
            }
            target.error = describeAskError(reason);
            persistSoon();
        }
    }

    function describeAskError(error: string): string {
        if (error.includes('invalid-model')) return app.t('agentChat.invalidModel', 'Ese nombre de modelo no vale: solo letras, números y . _ : / @ -');
        if (error.includes('invalid-effort') || error.includes('unsupported-option') || error.includes('unsupported-mode')) return app.t('agentChat.unsupportedOption', 'Este agente no admite esa opción.');
        if (error.includes('mode-needs-edit')) return app.t('agentChat.modeNeedsEdit', 'Ese modo cambia archivos: actívalo en Ajustes, con «Dejar que los agentes del chat editen archivos».');
        if (error.includes('mode-needs-bypass')) return app.t('agentChat.modeNeedsBypass', '«Omitir permisos» hay que habilitarlo antes en Ajustes, junto a los demás ajustes del chat.');
        if (error.includes('too-long-for-agent')) return app.t('agentChat.tooLongForAgent', 'Para este agente la pregunta tiene que caber en una orden de Windows (unos 30 000 caracteres, con adjuntos y conversación). Quita algo o empieza una conversación nueva.');
        if (error.includes('too-long')) return app.t('agentChat.tooLong', 'La pregunta es demasiado larga (con los adjuntos y la conversación). Quita algo o empieza una conversación nueva.');
        if (error.includes('unsafe-launcher')) return app.t('agentChat.unsafeLauncher', 'No se pudo lanzar este agente sin pasar por cmd, así que no se le pregunta: úsalo en su pestaña.');
        if (error.includes('needs-config')) return app.t('agentChat.reasonNeedsConfig', 'Le falta su config.yaml con algún modelo (en ~/.continue): sin él no tiene con qué contestar.');
        return error;
    }

    /** «Modelo saturado (error 503). Reintentando… (1 de 3)»: Gemini CLI y Qwen
     *  Code reintentan en silencio; el panel lo cuenta según pasa (16-11). */
    function retryText(retry: { attempt: number; max: number; status: number }): string {
        return (retry.status === 429
            ? app.t('agentChat.retryingQuota', 'Sin cupo (error 429). Reintentando… ({attempt} de {max})')
            : app.t('agentChat.retryingOverloaded', 'Modelo saturado (error {status}). Reintentando… ({attempt} de {max})'))
            .replace('{status}', String(retry.status))
            .replace('{attempt}', String(retry.attempt))
            .replace('{max}', String(retry.max));
    }

    // ---- Título puesto por el agente (`agentChatAutoTitle`, 24-11) ----
    // Tras la primera respuesta buena, una pregunta aparte (sin la guía ni la
    // sesión) pide un título corto. Gasta cuenta: apagado de fábrica.
    let titleRequest: { id: number | null; text: string } | null = null;
    let titleAsked = untrack(() => Boolean(restore));
    async function titleWithAgent(): Promise<void> {
        if (titleAsked || titleEdited || help || app.preferences?.agentChatAutoTitle !== true) return;
        // Espera a que la primera respuesta acabe bien.
        await new Promise<void>((resolve) => {
            const check = () => (destroyed || !pending ? resolve() : setTimeout(check, 500));
            check();
        });
        const first = messages.find((message) => message.role === 'agent');
        const question = messages.find((message) => message.role === 'user')?.text ?? '';
        if (destroyed || titleAsked || titleEdited || !first || first.error || !first.text.trim() || !question) return;
        titleAsked = true;
        const prompt = app.t('agentChat.titlePrompt', 'Pon un título de 3 a 6 palabras, en el idioma de la pregunta, a esta conversación. Contesta solo el título, sin comillas.')
            + `\n\n${question.slice(0, 2000)}\n\n${first.text.slice(0, 2000)}`;
        titleRequest = { id: null, text: '' };
        try {
            const id = await api.agentChatAsk(first.ask?.agentId ?? agentId, prompt, app.activeTabId, first.ask?.model ?? '', '', '', false, null);
            if (titleRequest) titleRequest.id = id;
        } catch {
            titleRequest = null;
        }
    }

    /** Quita una respuesta que no llegó a empezar y vuelve a preguntar. */
    async function replaceAnswer(target: Message, request: NonNullable<Message['ask']>): Promise<void> {
        const index = messages.findIndex((message) => message.id === target.id);
        if (index >= 0) messages.splice(index, 1);
        await ask(request);
    }

    /** Repite la misma pregunta, con el mismo agente, modelo, intensidad y
     *  modo. Tras un fallo, siempre con la conversación entera. */
    async function retry(message: Message): Promise<void> {
        if (!message.ask || pending) return;
        await ask({ ...message.ask, prompt: message.ask.fullPrompt ?? message.ask.prompt, session: freshSession(message.ask.agentId) });
    }

    async function stop(): Promise<void> {
        if (pending?.requestId != null) await api.agentChatCancel(pending.requestId);
    }

    /** Empieza otra conversación en esta pestaña. La anterior queda en el
     *  historial (23-11): antes se perdía. */
    function newConversation(): void {
        if (pending) return;
        persistNow();
        messages = [];
        startFresh();
        void tick().then(() => input?.focus());
    }

    // ---- Tras un fallo ----

    /** Guarda la clave (cifrada, nunca al log) y repite la pregunta. */
    async function saveKeyAndRetry(message: Message): Promise<void> {
        const envId = message.ask?.agentId;
        if (!envId) return;
        const result = await api.aiKeySave(envId, message.keyDraft ?? '');
        if (!result.ok) {
            message.keyError = result.error === 'empty'
                ? app.t('agentChat.keyEmpty', 'Escribe la clave.')
                : result.error === 'invalid-characters'
                    ? app.t('agentChat.keyInvalid', 'La clave no puede llevar espacios ni saltos de línea.')
                    : app.t('agentChat.keyFailed', 'No se pudo guardar la clave.');
            return;
        }
        message.keyDraft = '';
        message.keyError = '';
        message.help = null;
        await retry(message);
    }

    // ---- Adjuntos ----

    async function attachFiles(): Promise<void> {
        let paths: string[] = [];
        try {
            paths = await api.pickChatAttachments();
        } catch {
            return;
        }
        for (const path of paths) {
            if (attachments.length >= MAX_ATTACHMENTS) {
                notice = app.t('agentChat.tooManyFiles', 'Como mucho {count} archivos por pregunta.').replace('{count}', String(MAX_ATTACHMENTS));
                break;
            }
            try {
                const file = await api.agentChatReadAttachment(path);
                if (attachments.some((item) => item.name === file.name && item.bytes === file.bytes)) continue;
                attachments.push(file);
                if (file.truncated) {
                    notice = app.t('agentChat.fileTruncated', '«{name}» es grande: se manda solo el principio.').replace('{name}', file.name);
                }
            } catch (error) {
                const reason = String(error);
                const name = path.split(/[\\/]/u).pop() ?? path;
                notice = reason.includes('binary')
                    ? app.t('agentChat.fileBinary', '«{name}» no es un archivo de texto: no se puede adjuntar.').replace('{name}', name)
                    : reason.includes('too-big')
                        ? app.t('agentChat.fileTooBig', '«{name}» pasa de 5 MB: no se adjunta.').replace('{name}', name)
                        : app.t('agentChat.fileUnreadable', 'No se pudo leer «{name}».').replace('{name}', name);
            }
        }
        void tick().then(() => input?.focus());
    }

    function removeAttachment(index: number): void {
        attachments.splice(index, 1);
    }

    // ---- Teclado y campo ----

    function onKeydown(event: KeyboardEvent): void {
        // Las teclas del campo no deben llegar a la terminal ni a los atajos.
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            app.agentChatVisible = false;
        }
    }

    /** El campo crece con lo escrito, hasta unas diez líneas. */
    function autoGrow(): void {
        if (!input) return;
        input.style.height = 'auto';
        input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
    }

    function useSuggestion(text: string, context: boolean): void {
        draft = text;
        withContext = context;
        void tick().then(() => {
            autoGrow();
            input?.focus();
        });
    }

    // ---- Respuestas ----

    /** Escribe el bloque en la terminal activa SIN Intro: el usuario lo lee y
     *  decide. Solo una línea: varias se ejecutarían al pegarse en la shell. */
    function insertIntoTerminal(code: string): void {
        const controls = app.activeTabId ? getTerminalControls(app.activeTabId) : undefined;
        const rejected = controls?.insertLine(code.trim()) ?? 'not-ready';
        // Cada motivo con su aviso (23-11): antes todos decían «tiene que estar
        // en un prompt vacío», también con la orden ya escrita.
        notice = rejected === 'draft'
            ? app.t('agentChat.insertRejectedDraft', 'La línea de la terminal ya tiene otro texto escrito: bórralo y vuelve a insertarlo.')
            : rejected === 'busy'
                ? app.t('agentChat.insertRejectedBusy', 'La terminal está ocupada con una orden: espera a que vuelva el prompt.')
                : rejected
                    ? app.t('agentChat.insertRejected', 'No se pudo escribir en la terminal: tiene que estar en un prompt vacío.')
                    : app.t('agentChat.inserted', 'Escrito en la terminal, sin ejecutar. Revísalo y pulsa Intro si quieres.');
    }

    async function copy(code: string): Promise<void> {
        const ok = await api.writeClipboard(code);
        notice = ok ? app.t('agentChat.copied', 'Copiado') : app.t('agentChat.copyFailed', 'No se pudo copiar');
    }

    function elapsed(message: Message): string {
        if (!message.startedAt) return '';
        const ms = (message.finishedAt ?? now) - message.startedAt;
        const seconds = Math.max(0, Math.round(ms / 100) / 10);
        return seconds < 60
            ? `${seconds.toLocaleString(app.catalog.language, { maximumFractionDigits: 1 })} s`
            : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
    }

    function effortLabel(level: string): string {
        return app.t(`agentChat.effort.${level}`, level);
    }

    // ---- Ancho ----

    function startResize(event: PointerEvent): void {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const target = event.currentTarget as HTMLElement;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
            const limit = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth * 0.7));
            width = Math.round(Math.min(limit, Math.max(MIN_WIDTH, startWidth + (startX - moveEvent.clientX))));
        };
        const up = () => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            try {
                localStorage.setItem(WIDTH_KEY, String(width));
            } catch {
                // Sin almacenamiento: el ancho vuelve al de siempre al reabrir.
            }
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    }

    onMount(() => {
        void api.onAgentChatData((requestId, text) => {
            if (titleRequest && titleRequest.id === requestId) {
                titleRequest.text += stripAnsi(text);
                return;
            }
            const target = messages.find((message) => message.requestId === requestId);
            if (!target) return;
            target.text += stripAnsi(text);
            // Ya contesta: el reintento, si lo hubo, salió bien.
            target.retry = null;
            void scrollToEnd();
        }).then((stopListening) => unlisten.push(stopListening));
        // Mientras contesta: cada reintento por saturación, en cuanto pasa, y
        // el modelo si la CLI lo dice (16-11).
        void api.onAgentChatStatus((requestId, status) => {
            const target = messages.find((message) => message.requestId === requestId);
            if (!target || !target.pending) return;
            if (status.retry) target.retry = status.retry;
            if (status.model) target.reportedModel = status.model;
            if (status.session) target.nativeSession = status.session;
        }).then((stopListening) => unlisten.push(stopListening));
        void api.onAgentChatDone((requestId, code, error, detail) => {
            if (titleRequest && titleRequest.id === requestId) {
                const proposed = error ? '' : cleanAgentTitle(titleRequest.text);
                titleRequest = null;
                if (proposed && !titleEdited) {
                    title = proposed;
                    titleEdited = true;
                    persistNow();
                }
                return;
            }
            const target = messages.find((message) => message.requestId === requestId);
            if (!target) return;
            // La sesión ya no está (Claude Code las guarda por carpeta): la
            // misma pregunta en una sesión nueva, con la conversación entera.
            if (error === 'session-missing' && target.ask) {
                native = null;
                const request = target.ask;
                void replaceAnswer(target, { ...request, prompt: request.fullPrompt ?? request.prompt, session: freshSession(request.agentId) });
                return;
            }
            target.pending = false;
            target.finishedAt = Date.now();
            if (!error && target.text.trim() && target.ask?.session) {
                native = nativeAfterAnswer(target.ask.session, target.nativeSession, target.ask.agentId, messages.length);
            }
            // Lo que escribió por la salida de error, aunque no haya fallado
            // (15-11: Amp acababa bien sin contestar y no se veía por qué).
            const said = detail ? stripAnsi(detail).trim().slice(-4000) : '';
            // Lo que lo arregla: la clave, su pestaña o el aviso de Python.
            // Sin nada que lo explique, al menos su pestaña, donde se ve todo.
            const offerHelp = (output: string, fallbackToTab: boolean) => {
                const envId = target.ask?.agentId;
                if (!envId) return;
                void api.agentChatFailureHelp(envId, output).then((help) => {
                    const current = messages.find((message) => message.id === target.id);
                    if (!current) return;
                    if (help.apiKey || help.openTab || help.pythonModule) current.help = help;
                    else if (fallbackToTab) current.help = { apiKey: null, openTab: 'setup', pythonModule: false };
                }).catch(() => {});
            };
            if (error === 'cancelled') target.error = app.t('agentChat.cancelled', 'Cortado.');
            else if (error === 'timeout') {
                target.error = app.t('agentChat.timeout', 'El agente tardó más de 5 minutos y se cortó.');
                if (said) target.errorDetail = said;
            } else if (error?.startsWith('busy:')) {
                // Gemini CLI y Qwen Code reintentan en silencio con el modelo
                // saturado (503) o sin cupo (429): al tercero se corta (15-11).
                const status = error.slice('busy:'.length);
                target.error = (status === '429'
                    ? app.t('agentChat.busyQuota', 'Sin cupo para ese modelo ahora mismo (error 429): lo reintentó {n} veces y se cortó. Prueba más tarde o elige otro modelo.')
                    : app.t('agentChat.busyOverloaded', 'El modelo está saturado ahora mismo (error {status} del servicio): lo reintentó {n} veces y se cortó. Prueba más tarde o elige otro modelo.'))
                    .replace('{status}', status)
                    .replace('{n}', String(target.retry?.max ?? 3));
                if (said) target.errorDetail = said;
            } else if (error) {
                const output = stripAnsi(error);
                const headline = errorHeadline(output);
                target.error = app.t('agentChat.failed', 'El agente acabó con error (código {code}).').replace('{code}', String(code ?? '?'))
                    + (headline ? ` ${headline}` : '');
                target.errorDetail = output.trim().slice(-4000);
                offerHelp(output, false);
            } else if (!target.text.trim()) {
                const headline = said ? errorHeadline(said) : '';
                target.error = app.t('agentChat.emptyAnswer', 'El agente terminó sin contestar nada.') + (headline ? ` ${headline}` : '');
                if (said) target.errorDetail = said;
                offerHelp(said, true);
            }
            persistSoon();
            void scrollToEnd();
        }).then((stopListening) => unlisten.push(stopListening));
        clock = setInterval(() => {
            if (pending) now = Date.now();
        }, 500);
    });

    onDestroy(() => {
        // Lo último, sin esperar: una respuesta a medias queda como cortada.
        persistNow();
        destroyed = true;
        for (const stopListening of unlisten) stopListening();
        if (clock) clearInterval(clock);
        if (pending?.requestId != null) void api.agentChatCancel(pending.requestId);
    });
</script>

{#snippet inlines(pieces: { kind: string; text: string }[])}{#each pieces as piece, pieceIndex (pieceIndex)}{#if piece.kind === 'bold'}<strong>{piece.text}</strong>{:else if piece.kind === 'italic'}<em>{piece.text}</em>{:else if piece.kind === 'code'}<code>{piece.text}</code>{:else}{piece.text}{/if}{/each}{/snippet}

<aside class="agent-chat" class:embedded data-testid="agent-chat" aria-label={app.t('toolbar.agentChat', 'Chat IA')} style:width={embedded ? null : `${width}px`}>
    {#if !embedded}
        <div
            class="resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={app.t('agentChat.resize', 'Cambiar el ancho del chat')}
            title={app.t('agentChat.resize', 'Cambiar el ancho del chat')}
            data-testid="agent-chat-resize"
            onpointerdown={startResize}
        ></div>
    {/if}

    <header>
        <!-- Dentro de AgentChats el título y el cierre los lleva el contenedor. -->
        {#if !embedded}
            <div class="bar">
                <span class="name">{app.t('toolbar.agentChat', 'Chat IA')}</span>
                <span class="spacer"></span>
                <button
                    type="button"
                    class="icon"
                    data-testid="agent-chat-close"
                    title={app.t('common.close', 'Cerrar')}
                    aria-label={app.t('common.close', 'Cerrar')}
                    onclick={() => { app.agentChatVisible = false; }}
                >
                    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
                </button>
            </div>
        {/if}

        <div class="agent-row">
            <select
                class="agent-select"
                data-testid="agent-chat-agent"
                aria-label={app.t('agentChat.agent', 'Agente')}
                bind:this={agentSelect}
                bind:value={() => agentId, chooseAgent}
                disabled={(loading && agents.length === 0) || pending !== null}
            >
                {#if chatAgents.length === 0}
                    <option value="">{detecting || loading ? app.t('agentChat.searching', 'Buscando agentes…') : app.t('agentChat.noAgentsShort', 'Ningún agente')}</option>
                {/if}
                {#each chatAgents as item (item.id)}
                    <option value={item.id}>{item.label}</option>
                {/each}
                {#if tabOnlyAgents.length > 0}
                    <optgroup label={app.t('agentChat.openInTabGroup', 'Solo en su pestaña (se abre aparte)')} data-testid="agent-chat-tab-only">
                        {#each tabOnlyAgents as item (item.id)}
                            <option value={`${TAB_AGENT}${item.id}`} title={unavailableReason(item.unavailable)}>{item.label} ↗</option>
                        {/each}
                    </optgroup>
                {/if}
            </select>
            <button
                type="button"
                class="icon"
                data-testid="agent-chat-open-agent-tab"
                title={app.t('agentChat.openAgentTabHint', 'Abrir {agent} en una pestaña: para iniciar sesión, configurarlo o usarlo con su pantalla').replace('{agent}', agentLabel || '…')}
                aria-label={app.t('agentChat.openInTab', 'Abrir {agent} en una pestaña').replace('{agent}', agentLabel || '…')}
                disabled={!agent}
                onclick={() => openAgentTab(agentId)}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5h3v3M12.5 3.5 7.5 8.5M11 9.5v3h-7.5v-7.5h3" /></svg>
            </button>
            <!-- Volver a empezar ESTA conversación (el «+» de las pestañas abre
                 otro chat en paralelo). -->
            <button
                type="button"
                class="icon"
                data-testid="agent-chat-new"
                title={app.t('agentChat.newConversation', 'Nueva conversación')}
                aria-label={app.t('agentChat.newConversation', 'Nueva conversación')}
                disabled={messages.length === 0 || pending !== null}
                onclick={newConversation}
            >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 8.5a4.5 4.5 0 1 0 1.5-4M3.4 2.6v2.6H6" /></svg>
            </button>
        </div>
        {#if agent && EDITING_MODES.includes(effectiveMode)}
            <p class="mode-line"><span class="mode" class:danger={effectiveMode === 'bypass'} data-testid="agent-chat-mode-badge" title={modeHint(effectiveMode)}>{modeLabel(effectiveMode)}</span></p>
        {/if}

        <div class="pickers">
            {#if agent?.modelChoice}
                <label class="picker">
                    <span>{app.t('agentChat.model', 'Modelo')}</span>
                    <select
                        data-testid="agent-chat-model"
                        value={modelValue}
                        disabled={pending !== null}
                        title={models?.source && models.defaultModel ? app.t('agentChat.modelSource', 'El de fábrica sale de {source}').replace('{source}', models.source) : ''}
                        onchange={(event) => chooseModel((event.currentTarget as HTMLSelectElement).value)}
                    >
                        <option value="">
                            {models?.defaultModel
                                ? app.t('agentChat.modelIsDefault', '{model} · el que usa').replace('{model}', models.defaultModel)
                                : app.t('agentChat.modelAgentDecides', 'El que decida {agent}').replace('{agent}', agentLabel)}
                        </option>
                        {#each otherModels as option (option)}
                            <option value={option}>{option}</option>
                        {/each}
                        {#if models?.custom !== false}
                            <option value={OTHER_MODEL}>{app.t('agentChat.modelOther', 'Otro…')}</option>
                        {/if}
                    </select>
                </label>
            {/if}
            {#if agent && effortLevels.length > 0}
                <label class="picker">
                    <span>{app.t('agentChat.effort', 'Intensidad')}</span>
                    <select
                        data-testid="agent-chat-effort"
                        bind:value={effort}
                        disabled={pending !== null}
                        title={effort === 'ultracode'
                            ? app.t('agentChat.ultracodeHint', 'Ultracode: Claude Code reparte el trabajo en varios agentes. Tarda y gasta más; el plazo sube de 5 a 30 minutos.')
                            : app.t('agentChat.effortDefaultHint', 'La que use el agente de serie')}
                        onchange={saveChoice}
                    >
                        <option value="">{app.t('agentChat.effortDefault', 'Por defecto')}</option>
                        {#each effortLevels as level (level)}
                            <option value={level}>{effortLabel(level)}</option>
                        {/each}
                    </select>
                </label>
            {/if}
            {#if agent && modes.length > 0}
                <label class="picker">
                    <span>{app.t('agentChat.mode', 'Permisos')}</span>
                    <select
                        data-testid="agent-chat-mode"
                        value={effectiveMode}
                        disabled={pending !== null}
                        title={modeHint(effectiveMode)}
                        onchange={(event) => chooseMode((event.currentTarget as HTMLSelectElement).value)}
                    >
                        {#each modes as id (id)}
                            <option value={id} disabled={!modeAllowed(id)}>
                                {modeAllowed(id) ? modeLabel(id) : app.t('agentChat.modeLocked', '{mode} · actívalo en Ajustes').replace('{mode}', modeLabel(id))}
                            </option>
                        {/each}
                    </select>
                </label>
            {/if}
        </div>
        {#if customModel}
            <input
                class="custom-model"
                data-testid="agent-chat-model-custom"
                bind:this={customInput}
                bind:value={model}
                placeholder={app.t('agentChat.modelCustomPlaceholder', 'Nombre exacto del modelo')}
                spellcheck="false"
                autocomplete="off"
                disabled={pending !== null}
                onchange={saveChoice}
                onkeydown={(event) => event.stopPropagation()}
            />
        {/if}
        {#if fastAvailable}
            <label class="fast" title={app.t('agentChat.fastHint', 'Responde más rápido y gasta más de tu cuenta: el modo Fast del modelo en Codex y el modo rápido de Claude Code (con créditos de uso).')}>
                <input type="checkbox" data-testid="agent-chat-fast" bind:checked={fast} disabled={pending !== null} onchange={saveChoice} />
                <span>{app.t('agentChat.fast', 'Modo rápido')}</span>
                <small>{app.t('agentChat.fastCost', 'gasta más')}</small>
            </label>
        {/if}
        {#if effectiveMode === 'bypass'}
            <p class="mode-warning" data-testid="agent-chat-bypass-warning">{modeHint('bypass')}</p>
        {/if}
    </header>

    <div class="log" bind:this={list} onscroll={onScroll} data-testid="agent-chat-messages">
        {#if chatAgents.length === 0 && (loading || detecting)}
            <p class="empty" data-testid="agent-chat-searching">{app.t('agentChat.searchingHint', 'Buscando los agentes instalados: la detección de entornos sigue en marcha y la lista se pone sola al acabar.')}</p>
        {:else if chatAgents.length === 0}
            <p class="empty" data-testid="agent-chat-empty">{app.t('agentChat.noAgents', 'No hay ningún agente con modo de una pregunta instalado (Claude Code, Codex, Gemini, Qwen, Copilot, Crush, llm, ShellGPT, mods, AIChat u Ollama). Instálalo en Entorno y dependencias.')}</p>
        {:else if messages.length === 0}
            <div class="start">
                <p>{app.t('agentChat.intro', 'Pregunta lo que quieras sin salir de la terminal. Con «contexto», el agente ve la última orden de la pestaña y su salida. Nada se ejecuta solo.')}</p>
                <ul>
                    <li><button type="button" data-testid="agent-chat-suggestion" disabled={chatAgents.length === 0}
                        onclick={() => useSuggestion(app.t('agentChat.suggestWhyFailed', '¿Por qué ha fallado la última orden y cómo lo arreglo?'), true)}>{app.t('agentChat.suggestWhyFailed', '¿Por qué ha fallado la última orden y cómo lo arreglo?')}</button></li>
                    <li><button type="button" data-testid="agent-chat-suggestion" disabled={chatAgents.length === 0}
                        onclick={() => useSuggestion(app.t('agentChat.suggestExplain', 'Explícame la salida de la última orden.'), true)}>{app.t('agentChat.suggestExplain', 'Explícame la salida de la última orden.')}</button></li>
                    <li><button type="button" data-testid="agent-chat-suggestion" disabled={chatAgents.length === 0}
                        onclick={() => useSuggestion(app.t('agentChat.suggestCommand', 'Dame la orden para '), false)}>{app.t('agentChat.suggestCommandLabel', 'Dame la orden para…')}</button></li>
                    <li><button type="button" data-testid="agent-chat-suggestion" disabled={chatAgents.length === 0}
                        onclick={() => { useSuggestion(app.t('agentChat.suggestReview', 'Revisa este archivo y dime qué mejorarías.'), false); void attachFiles(); }}>{app.t('agentChat.suggestReviewLabel', 'Revisar un archivo…')}</button></li>
                </ul>
            </div>
        {/if}

        {#each messages as message (message.id)}
            {#if message.role === 'user'}
                <div class="turn user" data-testid="agent-chat-message" data-role="user" data-pending="false">
                    <p class="question"><span class="prompt" aria-hidden="true">›</span><span>{message.text}</span></p>
                    {#if message.attachments?.length}
                        <p class="sent">
                            {#each message.attachments as file, fileIndex (`${file.name}-${fileIndex}`)}
                                <span title={file.truncated ? app.t('agentChat.promptTruncated', 'solo el principio') : ''}>+ {file.name} ({formatBytes(file.bytes, app.catalog.language)}{file.truncated ? ', …' : ''})</span>
                            {/each}
                        </p>
                    {/if}
                    {#if message.context}
                        <details class="sent-context">
                            <summary>{app.t('agentChat.contextSent', 'Con la última orden de la terminal')}</summary>
                            <pre>{message.context}</pre>
                        </details>
                    {/if}
                </div>
            {:else}
                {@const shownModel = answerModel(message.reportedModel, message.ask)}
                <div class="turn agent" class:failed={message.error !== null} data-testid="agent-chat-message" data-role="agent" data-pending={message.pending}>
                    <p class="meta">
                        <span class="who">{message.agent}</span>
                        <!-- Qué modelo contestó (16-11): el que dice la CLI, el
                             elegido o, sin elegir, el suyo por defecto. Ollama
                             lleva el modelo en el nombre. -->
                        {#if shownModel?.kind === 'reported'}
                            <span data-testid="agent-chat-answer-model" title={app.t('agentChat.modelReported', 'El modelo que dice estar usando {agent}.').replace('{agent}', message.agent)}>{shownModel.name}</span>
                        {:else if shownModel?.kind === 'chosen'}
                            <span data-testid="agent-chat-answer-model">{shownModel.name}</span>
                        {:else if shownModel?.kind === 'default'}
                            <span class="default-model" data-testid="agent-chat-answer-model" title={app.t('agentChat.modelDefaultHint', 'No se eligió modelo: contesta el que {agent} use por defecto.').replace('{agent}', message.agent)}>{app.t('agentChat.modelDefault', 'modelo por defecto')}</span>
                        {/if}
                        {#if message.ask?.effort}<span>{effortLabel(message.ask.effort)}</span>{/if}
                        {#if message.ask?.mode && EDITING_MODES.includes(message.ask.mode)}<span>{modeLabel(message.ask.mode)}</span>{/if}
                        {#if message.ask?.fast}<span>{app.t('agentChat.fast', 'Modo rápido')}</span>{/if}
                        {#if message.resumed && app.preferences?.agentChatShowResumed !== false}<span class="resumed" data-testid="agent-chat-resumed" title={app.t('agentChat.resumedHint', 'Se retomó la sesión propia del agente: solo se mandó lo nuevo.')}>{app.t('agentChat.resumed', 'sesión retomada')}</span>{/if}
                        <span class="elapsed" data-testid="agent-chat-elapsed">{elapsed(message)}</span>
                    </p>
                    <div class="answer">
                        {#each splitAgentAnswer(message.text) as part, index (index)}
                            {#if part.kind === 'code'}
                                <div class="code">
                                    <div class="code-bar">
                                        <span>{part.lang ?? ''}</span>
                                        <span class="code-actions">
                                            <button
                                                type="button"
                                                data-testid="agent-chat-insert"
                                                disabled={part.text.trim().includes('\n')}
                                                title={part.text.trim().includes('\n')
                                                    ? app.t('agentChat.insertMultiline', 'Varias líneas: cópialo y revísalo antes de pegarlo.')
                                                    : app.t('agentChat.insertHint', 'Se escribe en la terminal sin pulsar Intro.')}
                                                onclick={() => insertIntoTerminal(part.text)}
                                            >{app.t('agentChat.insert', 'Insertar en la terminal')}</button>
                                            <button type="button" data-testid="agent-chat-copy" onclick={() => void copy(part.text)}>{app.t('agentChat.copy', 'Copiar')}</button>
                                        </span>
                                    </div>
                                    <pre data-testid="agent-chat-code">{part.text}</pre>
                                </div>
                            {:else}
                                {#each parseTextBlocks(part.text) as block, blockIndex (blockIndex)}
                                    {#if block.kind === 'heading'}
                                        <p class="heading">{@render inlines(block.inlines)}</p>
                                    {:else if block.kind === 'list'}
                                        {#if block.ordered}
                                            <ol>{#each block.items as item, itemIndex (itemIndex)}<li>{@render inlines(item)}</li>{/each}</ol>
                                        {:else}
                                            <ul>{#each block.items as item, itemIndex (itemIndex)}<li>{@render inlines(item)}</li>{/each}</ul>
                                        {/if}
                                    {:else if block.kind === 'quote'}
                                        <blockquote>{@render inlines(block.inlines)}</blockquote>
                                    {:else}
                                        <p>{@render inlines(block.inlines)}</p>
                                    {/if}
                                {/each}
                            {/if}
                        {/each}
                        {#if message.pending}
                            <p class="working" class:retrying={!!message.retry} aria-live="polite" data-testid="agent-chat-working">{message.retry ? retryText(message.retry) : app.t('agentChat.thinking', 'Pensando…')}<span class="cursor" aria-hidden="true"></span></p>
                        {/if}
                        {#if message.error}<p class="error" data-testid="agent-chat-error">{message.error}</p>{/if}
                        {#if message.errorDetail}
                            <details class="error-detail">
                                <summary>{app.t('agentChat.errorDetail', 'Ver lo que dijo el agente')}</summary>
                                <pre data-testid="agent-chat-error-detail">{message.errorDetail}</pre>
                            </details>
                        {/if}
                    </div>
                    {#if message.help}
                        <div class="help" data-testid="agent-chat-help">
                            {#if message.help.pythonModule}
                                <p>{app.t('agentChat.helpPython', 'A {agent} le falta su módulo de Python: pip lo instaló en la carpeta propia y Python no la ve (falta PYTHONUSERBASE). Revisa la carpeta en Ajustes › Entornos y descargas.').replace('{agent}', message.agent)}</p>
                                <button type="button" data-testid="agent-chat-open-settings" onclick={() => panels.show('settings')}>{app.t('agentChat.openSettings', 'Abrir Ajustes')}</button>
                            {/if}
                            {#if message.help.openTab && message.ask}
                                <p>{(message.help.openTab === 'setup'
                                    ? app.t('agentChat.helpSetup', '{agent} tiene que configurarse la primera vez. Hazlo en su pestaña y vuelve a preguntar.')
                                    : app.t('agentChat.helpLogin', '{agent} necesita que inicies sesión. Hazlo en su pestaña y vuelve a preguntar.')).replace('{agent}', message.agent)}</p>
                                <button type="button" data-testid="agent-chat-open-tab" onclick={() => openAgentTab(message.ask?.agentId ?? '')}>{app.t('agentChat.openInTab', 'Abrir {agent} en una pestaña').replace('{agent}', message.agent)}</button>
                            {/if}
                            {#if message.help.apiKey}
                                <form class="key" onsubmit={(event) => { event.preventDefault(); void saveKeyAndRetry(message); }}>
                                    <label for={`agent-chat-key-${message.id}`}>{(message.help.apiKey.stored
                                        ? app.t('agentChat.helpKeyRejected', '{agent} rechazó la clave guardada ({envVar}). Pon otra:')
                                        : app.t('agentChat.helpKeyMissing', '{agent} necesita su clave de API ({envVar}). Se guarda cifrada para tu usuario de Windows:'))
                                        .replace('{agent}', message.agent)
                                        .replace('{envVar}', message.help.apiKey.envVar)}</label>
                                    <span class="key-row">
                                        <input
                                            id={`agent-chat-key-${message.id}`}
                                            type="password"
                                            data-testid="agent-chat-key"
                                            autocomplete="off"
                                            spellcheck="false"
                                            placeholder={message.help.apiKey.envVar}
                                            bind:value={message.keyDraft}
                                            onkeydown={(event) => event.stopPropagation()}
                                        />
                                        <button type="submit" data-testid="agent-chat-key-save" disabled={pending !== null}>{app.t('agentChat.saveKeyRetry', 'Guardar y repetir')}</button>
                                    </span>
                                    {#if message.keyError}<small class="key-error">{message.keyError}</small>{/if}
                                </form>
                            {/if}
                        </div>
                    {/if}
                    {#if !message.pending}
                        <p class="actions">
                            {#if message.text.trim()}
                                <button type="button" data-testid="agent-chat-copy-answer" onclick={() => void copy(message.text.trim())}>{app.t('agentChat.copyAnswer', 'Copiar respuesta')}</button>
                            {/if}
                            {#if message.ask}
                                <button type="button" data-testid="agent-chat-retry" disabled={pending !== null} onclick={() => void retry(message)}>{app.t('agentChat.retry', 'Repetir')}</button>
                            {/if}
                        </p>
                    {/if}
                </div>
            {/if}
        {/each}
    </div>

    {#if !atBottom}
        <button type="button" class="to-bottom" title={app.t('agentChat.toBottom', 'Ir al final')} aria-label={app.t('agentChat.toBottom', 'Ir al final')} onclick={() => void scrollToEnd(true)}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /></svg>
        </button>
    {/if}

    {#if notice}<p class="notice" role="status" data-testid="agent-chat-notice">{notice}</p>{/if}

    <footer>
        {#if attachments.length}
            <p class="attachments">
                {#each attachments as file, index (`${file.name}-${index}`)}
                    <span class="file" data-testid="agent-chat-attachment" class:warn={file.truncated}
                        title={file.truncated ? app.t('agentChat.fileTruncated', '«{name}» es grande: se manda solo el principio.').replace('{name}', file.name) : file.name}>
                        + {file.name} <small>{formatBytes(file.bytes, app.catalog.language)}</small>
                        <button type="button" aria-label={app.t('agentChat.removeFile', 'Quitar el adjunto')} onclick={() => removeAttachment(index)}>×</button>
                    </span>
                {/each}
            </p>
        {/if}
        <div class="composer" class:busy={pending !== null}>
            <span class="prompt" aria-hidden="true">›</span>
            <textarea
                data-testid="agent-chat-input"
                bind:this={input}
                bind:value={draft}
                rows="1"
                placeholder={app.t('agentChat.placeholder', 'Pregunta a {agent}…').replace('{agent}', agentLabel || '…')}
                title={app.t('agentChat.inputHint', 'Intro envía, Mayús+Intro salta de línea')}
                disabled={chatAgents.length === 0}
                oninput={autoGrow}
                onkeydown={onKeydown}
            ></textarea>
        </div>
        <div class="footer-bar">
            <button type="button" class="icon clip" data-testid="agent-chat-attach"
                title={app.t('agentChat.attach', 'Adjuntar archivos de texto')}
                aria-label={app.t('agentChat.attach', 'Adjuntar archivos de texto')}
                disabled={chatAgents.length === 0 || attachments.length >= MAX_ATTACHMENTS}
                onclick={() => void attachFiles()}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 4.6 5.9 9.3a1.4 1.4 0 0 0 2 2l4.9-4.9a2.9 2.9 0 0 0-4.1-4.1L3.8 7.2a4.3 4.3 0 0 0 6.1 6.1l3.4-3.4" /></svg>
            </button>
            <label class="toggle" title={app.t('agentChat.withContextHint', 'Manda también la última orden de la pestaña activa y su salida (sin claves ni contraseñas).')}>
                <input type="checkbox" data-testid="agent-chat-context" bind:checked={withContext} />
                {app.t('agentChat.contextShort', 'contexto')}
            </label>
            {#if remember && messages.length > 0}
                <span class="memory" title={app.t('agentChat.rememberOnHint', 'El agente ve lo hablado en esta conversación. «Nueva conversación» lo borra.')}>{app.t('agentChat.rememberShort', 'memoria')}</span>
            {/if}
            <span class="spacer"></span>
            {#if pending}
                <button type="button" class="primary" data-testid="agent-chat-stop" onclick={() => void stop()}>{app.t('agentChat.stop', 'Cortar')}</button>
            {:else}
                <button type="button" class="primary" data-testid="agent-chat-send"
                    disabled={!draft.trim() || !agentId}
                    onclick={() => void send()}>{app.t('agentChat.send', 'Enviar')} ⏎</button>
            {/if}
        </div>
    </footer>
</aside>

<style>
    /* Aspecto de terminal: la misma letra y los mismos colores que la
       pestaña, bordes finos, sin burbujas ni sombras. */
    .agent-chat {
        position: relative;
        display: flex;
        min-width: 0;
        max-width: 70vw;
        flex: 0 0 auto;
        flex-direction: column;
        margin-left: 4px;
        border: 1px solid var(--border);
        border-radius: 3px;
        background: var(--terminal-bg);
        color: var(--terminal-fg);
        font-family: var(--terminal-font);
        font-size: 12px;
        line-height: 1.45;
        overflow: hidden;
    }

    /* Dentro de AgentChats: ocupa su hueco; el borde y el ancho son del
       contenedor. */
    .agent-chat.embedded {
        flex: 1 1 auto;
        min-height: 0;
        max-width: none;
        margin: 0;
        border: 0;
        border-radius: 0;
    }

    .mode-line {
        margin: 0;
    }

    .resize {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 2;
        width: 5px;
        cursor: col-resize;
    }

    .resize:hover {
        background: var(--accent-soft);
    }

    button {
        font: inherit;
    }

    header {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 8px 8px 10px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        color: var(--text);
    }

    .bar {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 22px;
    }

    .name {
        color: var(--muted);
        font-size: 10.5px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
    }

    .mode {
        padding: 0 5px;
        border: 1px solid var(--warning);
        border-radius: 2px;
        color: var(--warning);
        font-size: 10.5px;
    }

    .mode.danger,
    .mode-warning {
        border-color: var(--danger);
        color: var(--danger);
    }

    .mode-warning {
        margin: 0;
        padding: 3px 6px;
        border: 1px solid var(--danger);
        border-radius: 2px;
        font-size: 11px;
    }

    .fast {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--terminal-fg);
        font-size: 11.5px;
        cursor: pointer;
    }

    .fast input {
        margin: 0;
        accent-color: var(--accent);
    }

    .fast small {
        color: var(--muted);
        font-size: 10.5px;
    }

    .spacer {
        flex: 1 1 auto;
    }

    .icon {
        display: inline-grid;
        width: 22px;
        height: 22px;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
    }

    .icon:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
    }

    .icon:disabled {
        opacity: 0.35;
        cursor: default;
    }

    .icon svg {
        width: 13px;
        height: 13px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
    }

    .agent-row {
        display: flex;
        align-items: center;
        gap: 4px;
    }

    .agent-row select {
        min-width: 0;
        height: 26px;
        flex: 1 1 auto;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--terminal-bg);
        color: var(--terminal-fg);
        font: inherit;
        font-weight: 600;
    }

    .agent-row select:focus-visible {
        border-color: var(--accent);
        outline: none;
    }

    .pickers {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
        gap: 6px;
    }

    .pickers:empty {
        display: none;
    }

    .picker {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 2px;
    }

    .picker > span {
        color: var(--muted);
        font-size: 10.5px;
    }

    .picker select,
    .custom-model {
        width: 100%;
        min-width: 0;
        height: 24px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--terminal-bg);
        color: var(--terminal-fg);
        font: inherit;
    }

    .picker select:focus-visible,
    .custom-model:focus-visible {
        border-color: var(--accent);
        outline: none;
    }

    .log {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        padding: 10px 10px 4px 12px;
    }

    .empty,
    .start p {
        margin: 0 0 8px;
        color: var(--muted);
    }

    .start ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }

    .start button {
        width: 100%;
        padding: 3px 0;
        border: 0;
        background: none;
        color: var(--terminal-fg);
        text-align: left;
        cursor: pointer;
    }

    .start button::before {
        content: '› ';
        color: var(--accent);
    }

    .start button:hover:not(:disabled) {
        color: var(--accent);
    }

    .turn {
        margin-bottom: 12px;
    }

    .question {
        display: flex;
        gap: 6px;
        margin: 0;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }

    .prompt {
        color: var(--accent);
        user-select: none;
    }

    .sent {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 10px;
        margin: 2px 0 0 14px;
        color: var(--muted);
        font-size: 11px;
    }

    .sent-context {
        margin: 2px 0 0 14px;
        color: var(--muted);
        font-size: 11px;
    }

    .sent-context summary {
        cursor: pointer;
    }

    .sent-context pre {
        max-height: 160px;
        margin: 4px 0 0;
        padding: 6px 8px;
        border-left: 2px solid var(--border);
        overflow: auto;
        white-space: pre-wrap;
    }

    .agent {
        padding-left: 10px;
        border-left: 2px solid var(--border);
    }

    .agent.failed {
        border-left-color: var(--danger);
    }

    .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0 8px;
        margin: 0 0 4px;
        color: var(--muted);
        font-size: 11px;
    }

    .meta .who {
        color: var(--text);
    }

    .meta .elapsed {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
    }

    .answer {
        overflow-wrap: anywhere;
    }

    .answer p,
    .answer ul,
    .answer ol,
    .answer blockquote {
        margin: 0 0 6px;
    }

    .answer ul,
    .answer ol {
        padding-left: 18px;
    }

    .answer .heading {
        color: var(--text);
        font-weight: 700;
    }

    .answer blockquote {
        padding-left: 8px;
        border-left: 2px solid var(--border);
        color: var(--muted);
    }

    .answer code {
        padding: 0 3px;
        border-radius: 2px;
        background: var(--surface-alt);
    }

    .code {
        margin: 4px 0 8px;
        border: 1px solid var(--border);
        border-radius: 2px;
    }

    .code-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 4px 2px 8px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        color: var(--muted);
        font-size: 10.5px;
    }

    .code-actions {
        display: inline-flex;
        gap: 2px;
    }

    .code-actions button,
    .actions button,
    .footer-bar button:not(.primary) {
        padding: 1px 6px;
        border: 0;
        border-radius: 2px;
        background: none;
        color: var(--muted);
        cursor: pointer;
    }

    .code-actions button:hover:not(:disabled),
    .actions button:hover:not(:disabled),
    .footer-bar button:not(.primary):hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
    }

    .code-actions button:disabled,
    .actions button:disabled,
    .footer-bar button:disabled {
        opacity: 0.4;
        cursor: default;
    }

    /* El clip de adjuntar (14-11, Romen: «me gustaba más con un clip»). */
    .footer-bar button.clip {
        width: 24px;
        height: 22px;
        padding: 0;
    }

    .footer-bar button.clip svg {
        width: 15px;
        height: 15px;
    }

    /* Lo que dijo el agente al fallar, plegado bajo la línea que lo explica. */
    .error-detail {
        margin-top: 2px;
        color: var(--muted);
        font-size: 11px;
    }

    .error-detail summary {
        cursor: pointer;
    }

    .error-detail pre {
        max-height: 180px;
        margin: 4px 0 0;
        padding: 4px 6px;
        overflow: auto;
        border-left: 2px solid var(--danger);
        color: var(--terminal-fg);
        font: inherit;
        white-space: pre-wrap;
        word-break: break-word;
    }

    .code pre {
        margin: 0;
        padding: 6px 8px;
        overflow-x: auto;
        white-space: pre;
    }

    .working {
        color: var(--muted);
    }

    /* Un reintento por saturación: se ve que espera al servicio, no que piense. */
    .working.retrying {
        color: var(--warning);
    }

    /* «modelo por defecto»: no es un nombre, se distingue de uno elegido. */
    .meta .default-model {
        font-style: italic;
    }

    /* «sesión retomada» (24-11): discreta, como el modelo por defecto. */
    .meta .resumed {
        font-style: italic;
        opacity: 0.8;
    }

    .cursor {
        display: inline-block;
        width: 7px;
        height: 12px;
        margin-left: 4px;
        vertical-align: -2px;
        background: var(--terminal-cursor);
        animation: blink 1s steps(1) infinite;
    }

    @keyframes blink {
        50% {
            opacity: 0;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .cursor {
            animation: none;
        }
    }

    .error {
        margin: 0;
        color: var(--danger);
        font: inherit;
        white-space: pre-wrap;
    }

    .help {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 6px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--surface);
        color: var(--text);
    }

    .help p,
    .help label {
        margin: 0;
    }

    .help > button,
    .key-row button {
        align-self: flex-start;
        padding: 2px 8px;
        border: 1px solid var(--accent);
        border-radius: 2px;
        background: transparent;
        color: var(--accent);
        cursor: pointer;
    }

    .help > button:hover,
    .key-row button:hover:not(:disabled) {
        background: var(--accent);
        color: var(--terminal-bg);
    }

    .key {
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .key-row {
        display: flex;
        gap: 6px;
    }

    .key-row input {
        min-width: 0;
        flex: 1 1 auto;
        height: 24px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--terminal-bg);
        color: var(--terminal-fg);
        font: inherit;
    }

    .key-error {
        color: var(--danger);
    }

    .actions {
        display: flex;
        gap: 2px;
        margin: 2px 0 0 -6px;
        font-size: 11px;
    }

    .to-bottom {
        position: absolute;
        right: 12px;
        bottom: 84px;
        display: grid;
        width: 24px;
        height: 24px;
        place-items: center;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--surface);
        color: var(--muted);
        cursor: pointer;
    }

    .to-bottom svg {
        width: 12px;
        height: 12px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
    }

    /* Los avisos (no se pudo insertar, contexto, adjuntos…) se veían poco en
       gris (14-11, Romen): ahora con el color de aviso, un filete y fondo. */
    .notice {
        margin: 0;
        padding: 5px 10px 5px 8px;
        border-top: 1px solid var(--border);
        border-left: 3px solid var(--warning);
        background: color-mix(in srgb, var(--warning) 12%, var(--surface));
        color: var(--text);
        font-size: 11.5px;
    }

    footer {
        border-top: 1px solid var(--border);
        background: var(--surface);
    }

    .attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 10px;
        margin: 0;
        padding: 6px 10px 0;
        color: var(--muted);
        font-size: 11px;
    }

    .file.warn {
        color: var(--warning);
    }

    .file button {
        padding: 0 2px;
        border: 0;
        background: none;
        color: inherit;
        cursor: pointer;
    }

    .composer {
        display: flex;
        gap: 6px;
        margin: 6px 8px 0;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 2px;
        background: var(--terminal-bg);
    }

    .composer:focus-within {
        border-color: var(--accent);
    }

    .composer.busy {
        opacity: 0.75;
    }

    .composer textarea {
        min-width: 0;
        flex: 1 1 auto;
        min-height: 18px;
        max-height: 220px;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--terminal-fg);
        font: inherit;
        line-height: 1.45;
        outline: none;
        resize: none;
    }

    /* El texto de ayuda cabe en una fila: corto (las teclas van en `title`)
       y, si el panel es muy estrecho, acaba en «…» en vez de partirse y
       quedar cortado por la mitad (16-11). */
    .composer textarea:placeholder-shown {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .footer-bar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px 6px 4px;
        color: var(--muted);
        font-size: 11px;
    }

    .toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 6px;
        cursor: pointer;
    }

    .toggle input {
        margin: 0;
        accent-color: var(--accent);
    }

    .memory {
        padding: 1px 6px;
    }

    .primary {
        padding: 2px 10px;
        border: 1px solid var(--accent);
        border-radius: 2px;
        background: transparent;
        color: var(--accent);
        cursor: pointer;
    }

    .primary:hover:not(:disabled) {
        background: var(--accent);
        color: var(--terminal-bg);
    }

    .primary:disabled {
        border-color: var(--border);
        color: var(--muted);
        cursor: default;
    }
</style>
