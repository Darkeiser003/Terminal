// Pestañas ocupadas (26-11, Romen): una orden que tarda le pone su nombre y un
// color a la pestaña mientras corre, avisa al terminar diciendo de qué
// pestaña viene y, si se pide, junta en una vista las que siguen en marcha.
//
// Aquí solo está la parte pura (qué nombre, qué tipo de orden, qué color, qué
// casillas): se prueba en Node con `scripts/test-frontend-logic.mjs`. El
// nombre y el color puestos a mano siempre mandan; eso lo decide `appState`.

/** Los colores de pestaña (los mismos que `TAB_COLORS` de `appState`). */
export const BUSY_TAB_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'] as const;
export type BusyTabColor = (typeof BUSY_TAB_COLORS)[number];

export const BUSY_CATEGORIES = ['logs', 'server', 'build', 'install', 'network'] as const;
export type BusyCategory = (typeof BUSY_CATEGORIES)[number];

/** De fábrica: registros en azul, servidores en verde, compilaciones en
 *  naranja, instalaciones en morado y red en cian. */
export const DEFAULT_BUSY_TAB_COLORS = 'logs=blue,server=green,build=orange,install=purple,network=cyan';

/** Lo que dura pero se está usando: editores, paginadores, monitores, otras
 *  shells y sesiones remotas. Solo cambian el nombre: sin color, sin aviso y
 *  sin agrupar. */
export const DEFAULT_BUSY_TAB_EXCLUDE = 'vim,nvim,vi,nano,micro,emacs,hx,less,more,man,htop,top,btop,glances,'
    + 'ssh,mosh,telnet,tmux,screen,zellij,wsl,cmd,powershell,pwsh,bash,zsh,fish,sh,'
    + 'claude,codex,gemini,qwen,opencode,aider,copilot,ollama';

/** Cuando no hay tipo ni regla: por turno, sin el rojo (es el de los fallos). */
const ROTATION: readonly BusyTabColor[] = ['yellow', 'pink', 'cyan', 'blue', 'green', 'purple', 'orange'];

/** Un nombre de pestaña cabe de un vistazo. */
const MAX_LABEL = 32;

/** Lo que va delante de la orden de verdad y no la nombra. */
const WRAPPERS = new Set(['sudo', 'doas', 'gsudo', 'runas', 'time', 'nohup', 'nice', 'exec', 'env', 'call', 'start', '&', 'command', 'builtin', 'stdbuf', 'unbuffer']);

/** Programas cuyo nombre solo no dice nada: se añade la subórden. */
const WITH_SUBCOMMAND = new Set([
    'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'docker', 'podman', 'kubectl', 'helm', 'git', 'gh', 'dotnet', 'go',
    'python', 'python3', 'py', 'node', 'deno', 'gradle', 'gradlew', 'mvn', 'pip', 'pip3', 'winget', 'choco', 'scoop',
    'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'brew', 'systemctl', 'flatpak', 'snap', 'composer', 'php',
    'rails', 'flask', 'ng', 'next', 'nuxt', 'hugo', 'jekyll', 'adb', 'terraform', 'ansible-playbook', 'make', 'cmake',
    'tauri', 'rustup', 'gem', 'bundle', 'uv', 'poetry', 'pdm', 'conda', 'mamba', 'wsl',
]);

/** Separa una línea en palabras respetando las comillas simples y dobles. */
export function splitCommand(command: string): string[] {
    const words: string[] = [];
    let current = '';
    let quote: string | null = null;
    let started = false;
    for (const character of command.trim()) {
        if (quote) {
            if (character === quote) quote = null;
            else current += character;
        } else if (character === '"' || character === "'") {
            quote = character;
            started = true;
        } else if (/\s/u.test(character)) {
            if (started || current) words.push(current);
            current = '';
            started = false;
        } else {
            current += character;
            started = true;
        }
    }
    if (started || current) words.push(current);
    return words;
}

/** `C:\tools\Journalctl.EXE` → `journalctl`; `./run.sh` → `run.sh`. */
export function programName(word: string): string {
    const base = word.replace(/^\.[\\/]/u, '').split(/[\\/]/u).pop() ?? word;
    return base.replace(/\.(exe|cmd|bat|com|ps1)$/iu, '');
}

/** La orden sin lo que va delante (sudo, time, variables `X=1`…): palabras
 *  desde el programa. Lo que sigue a `|`, `&&` o `;` no cuenta. */
function commandWords(command: string): string[] {
    const first = command.split(/\s*(?:\|\||&&|\||;)\s*/u)[0] ?? '';
    const words = splitCommand(first);
    let index = 0;
    while (index < words.length) {
        const word = words[index];
        const lower = word.toLowerCase();
        if (WRAPPERS.has(lower) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
            index += 1;
            // `sudo -u x`, `nice -n 10`: sus opciones tampoco nombran nada.
            while (index < words.length && words[index].startsWith('-')) {
                const option = words[index];
                index += 1;
                if (/^-(u|n|g)$/u.test(option) && index < words.length) index += 1;
            }
            continue;
        }
        break;
    }
    return words.slice(index);
}

function firstArgument(words: string[], from = 1): string | undefined {
    for (let index = from; index < words.length; index += 1) {
        const word = words[index];
        if (!word || word.startsWith('-') || word.startsWith('/')) continue;
        return word;
    }
    return undefined;
}

/** El nombre para la pestaña: el programa y, si su nombre solo no dice nada,
 *  lo que hace («npm dev», «docker logs», «python manage.py»). */
export function commandLabel(command: string): string {
    const words = commandWords(command);
    if (words.length === 0) return '';
    const program = programName(words[0]);
    const lower = program.toLowerCase();
    let label = program;
    if (WITH_SUBCOMMAND.has(lower)) {
        let sub = firstArgument(words);
        // `npm run dev` se lee mejor como «npm dev».
        if (sub && /^(npm|pnpm|yarn|bun)$/u.test(lower) && sub === 'run') sub = firstArgument(words, words.indexOf(sub) + 1);
        // `python -m http.server`: el módulo es lo que corre.
        const module = words.indexOf('-m');
        if (/^(python3?|py)$/u.test(lower) && module > 0 && words[module + 1]) sub = words[module + 1];
        if (sub) label = `${program} ${programName(sub)}`;
    }
    return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
}

const has = (words: string[], ...wanted: string[]) => words.some((word) => wanted.includes(word));

/** El tipo de orden, para su color; `null` si no se reconoce. */
export function classifyCommand(command: string): BusyCategory | null {
    const words = commandWords(command).map((word) => word.toLowerCase());
    if (words.length === 0) return null;
    const program = programName(words[0]);
    const sub = firstArgument(words) ?? '';
    const rest = words.slice(1);

    // Registros que no paran.
    if (program === 'journalctl' || program === 'logcat' || (program === 'adb' && sub === 'logcat')) return 'logs';
    if ((program === 'tail' || program === 'less') && has(rest, '-f', '-F', '--follow', '+f')) return 'logs';
    if (/^(docker|podman|kubectl|stern)$/u.test(program) && (sub === 'logs' || program === 'stern')) return 'logs';
    if (/^(get-content|gc|cat|type)$/u.test(program) && has(rest, '-wait', '-tail')) return 'logs';
    if (program === 'dmesg' && has(rest, '-w', '--follow')) return 'logs';

    // Instalaciones y actualizaciones (antes que compilar: `npm install`).
    if (/^(winget|choco|scoop|apt|apt-get|dnf|yum|pacman|zypper|brew|flatpak|snap|dism|sfc|apk|emerge|port)$/u.test(program)) return 'install';
    if (/^(pip|pip3|uv|poetry|pdm|conda|mamba|gem|composer|rustup|bundle)$/u.test(program)
        && /^(install|update|upgrade|add|sync|lock|self)$/u.test(sub)) return 'install';
    if (/^(npm|pnpm|yarn|bun)$/u.test(program) && (/^(install|i|ci|add|update|upgrade|up)$/u.test(sub) || (program === 'yarn' && !sub))) return 'install';
    if (/^(cargo|go|dotnet)$/u.test(program) && (sub === 'install' || (program === 'dotnet' && sub === 'tool'))) return 'install';
    if (/^(install-module|update-module|install-package|update-help)$/u.test(program)) return 'install';
    if (program === 'wsl' && has(rest, '--install', '--update')) return 'install';

    // Servidores y modo desarrollo.
    if (/^(npm|pnpm|yarn|bun)$/u.test(program)) {
        const script = sub === 'run' ? firstArgument(words, words.indexOf('run') + 1) ?? '' : sub;
        if (/^(dev|start|serve|preview|watch)(:|$)/u.test(script)) return 'server';
        if (/^(build|test|lint|check|compile|tauri)(:|$)/u.test(script)) return 'build';
    }
    if (/^(vite|next|nuxt|astro|remix|webpack-dev-server|live-server|http-server|serve|uvicorn|gunicorn|hypercorn|nodemon|ng|hugo|jekyll|caddy|nginx|httpd)$/u.test(program)
        && !(program === 'ng' && sub !== 'serve') && !(/^(next|nuxt|astro|hugo)$/u.test(program) && sub === 'build')) return 'server';
    if (/^(python3?|py)$/u.test(program) && has(rest, 'http.server', 'runserver')) return 'server';
    if (program === 'flask' && sub === 'run') return 'server';
    if (program === 'rails' && /^(s|server)$/u.test(sub)) return 'server';
    if (program === 'php' && (sub === 'artisan' ? has(rest, 'serve') : has(rest, '-s'))) return 'server';
    if (program === 'dotnet' && /^(watch|run)$/u.test(sub)) return 'server';
    if (program === 'cargo' && sub === 'watch') return 'server';

    // Compilaciones y pruebas.
    if (program === 'cargo' && /^(build|test|check|clippy|bench|doc|tauri|nextest)$/u.test(sub)) return 'build';
    if (/^(make|ninja|msbuild|gradle|gradlew|mvn|tsc|javac|gcc|g\+\+|clang|clang\+\+|rustc|pytest|jest|vitest|ctest|bazel|meson|scons|xcodebuild)$/u.test(program)) return 'build';
    if (program === 'cmake' && has(rest, '--build')) return 'build';
    if (/^(dotnet|go)$/u.test(program) && /^(build|test|publish|pack)$/u.test(sub)) return 'build';
    if (/^(docker|podman)$/u.test(program) && /^(build|compose)$/u.test(sub) && (sub === 'build' || has(rest, 'build'))) return 'build';
    if (/^(next|nuxt|astro|hugo)$/u.test(program) && sub === 'build') return 'build';

    // Red.
    if (/^(ping|tracert|traceroute|pathping|mtr|curl|wget|scp|sftp|rsync|nslookup|dig|nmap|iperf|iperf3|aria2c|ftp|test-netconnection|invoke-webrequest|iwr|invoke-restmethod|irm|speedtest)$/u.test(program)) return 'network';
    if (program === 'git' && /^(clone|pull|fetch|push)$/u.test(sub)) return 'network';
    return null;
}

/** «logs=blue,server=green» → su mapa; lo que no se entiende se ignora. */
export function parseCategoryColors(text: string): Partial<Record<BusyCategory, BusyTabColor>> {
    const colors: Partial<Record<BusyCategory, BusyTabColor>> = {};
    for (const pair of text.split(/[,;\n]/u)) {
        const [key, value] = pair.split('=').map((part) => part.trim().toLowerCase());
        if ((BUSY_CATEGORIES as readonly string[]).includes(key) && (BUSY_TAB_COLORS as readonly string[]).includes(value)) {
            colors[key as BusyCategory] = value as BusyTabColor;
        }
    }
    return colors;
}

/** El texto de vuelta, en el orden de las categorías; `none` deja un tipo sin
 *  color propio (va por turno). */
export function formatCategoryColors(colors: Partial<Record<BusyCategory, BusyTabColor>>): string {
    return BUSY_CATEGORIES.filter((category) => colors[category]).map((category) => `${category}=${colors[category]}`).join(',');
}

export interface BusyRule {
    /** El principio de la orden, en minúsculas («kubectl logs», «ping»). */
    prefix: string;
    color: BusyTabColor;
}

/** Las reglas propias: «principio de la orden=color», separadas por `;`. */
export function parseBusyRules(text: string): BusyRule[] {
    const rules: BusyRule[] = [];
    for (const item of text.split(/[;\n]/u)) {
        const at = item.lastIndexOf('=');
        if (at <= 0) continue;
        const prefix = item.slice(0, at).trim().toLowerCase().replace(/\s+/gu, ' ');
        const color = item.slice(at + 1).trim().toLowerCase();
        if (prefix && (BUSY_TAB_COLORS as readonly string[]).includes(color)) rules.push({ prefix, color: color as BusyTabColor });
    }
    return rules;
}

/** La orden empieza por la regla, palabra a palabra («ping» no casa con
 *  «pingu»), contando el programa sin ruta ni `.exe`. */
function matchesPrefix(command: string, prefix: string): boolean {
    const words = commandWords(command).map((word) => word.toLowerCase());
    if (words.length === 0) return false;
    words[0] = programName(words[0]);
    const wanted = prefix.split(' ');
    return wanted.every((word, index) => words[index] === word);
}

/** Las órdenes que no cuentan como «cargando» (por su programa). */
export function isExcludedCommand(command: string, excludeText: string): boolean {
    const words = commandWords(command);
    if (words.length === 0) return false;
    const program = programName(words[0]).toLowerCase();
    return excludeText.split(/[,;\s]+/u).map((item) => item.trim().toLowerCase()).filter(Boolean).includes(program);
}

export interface BusyColorChoice {
    command: string;
    categoryColors: string;
    rules: string;
    /** Los colores que ya llevan otras pestañas ocupadas: el turno los salta
     *  mientras quede alguno libre. */
    inUse: readonly string[];
    /** Cuántas órdenes han ido por turno hasta ahora. */
    turn: number;
}

/** Regla propia, luego el color de su tipo y, si no, el siguiente del turno. */
export function chooseBusyColor(choice: BusyColorChoice): { color: BusyTabColor; category: BusyCategory | null; rotated: boolean } {
    const rule = parseBusyRules(choice.rules).find((candidate) => matchesPrefix(choice.command, candidate.prefix));
    const category = classifyCommand(choice.command);
    if (rule) return { color: rule.color, category, rotated: false };
    const byCategory = category ? parseCategoryColors(choice.categoryColors)[category] : undefined;
    if (byCategory) return { color: byCategory, category, rotated: false };
    const free = ROTATION.filter((color) => !choice.inUse.includes(color));
    const pool = free.length > 0 ? free : ROTATION;
    return { color: pool[Math.abs(choice.turn) % pool.length], category, rotated: true };
}

/** Cuánto espera, en ms, según el modo de bajo consumo (que va más lento y
 *  pide algo más de margen). */
export function busyDelayMs(seconds: number | undefined, lowPowerSeconds: number | undefined, lowPower: boolean, fallback: number): number {
    const chosen = lowPower ? lowPowerSeconds : seconds;
    const value = Number.isFinite(chosen) && (chosen as number) > 0 ? (chosen as number) : fallback;
    return Math.round(value * 1000);
}

/** Las casillas de la vista de vigilancia: la pestaña pedida y las demás en
 *  marcha, de la más reciente a la más antigua, hasta `max`. */
export function watchPanes(busy: ReadonlyArray<{ id: string; startedAt: number }>, wanted: string, max: number): string[] {
    const others = [...busy]
        .filter((entry) => entry.id !== wanted)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((entry) => entry.id);
    const ids = busy.some((entry) => entry.id === wanted) ? [wanted, ...others] : others;
    return ids.slice(0, Math.max(1, max));
}
