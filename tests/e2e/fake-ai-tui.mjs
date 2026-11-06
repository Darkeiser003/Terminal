#!/usr/bin/env node
// Simulador de una IA de terminal para los E2E (Claude Code, Amp, Gemini,
// Codex…), igual que `gh.cmd` simula GitHub: no necesita cuenta ni red.
//
// Dibuja como ellas: una caja que ocupa el ancho que anuncia la terminal
// (Ink, el motor de Claude Code y Gemini, usa `stdout.columns`), un spinner
// que se redibuja unas 20 veces por segundo dentro de una actualización
// sincronizada (`ESC[?2026h … ESC[?2026l`) y el cursor oculto. Con `--alt`
// usa la pantalla alternativa, como Amp u OpenCode; sin él redibuja en línea
// subiendo el cursor, como Ink.
//
// Lo que escribe la persona aparece en la caja; Intro lo «envía» y la
// respuesta llega carácter a carácter. `/exit` o Ctrl+C restauran la pantalla;
// `/pause` deja de redibujar.
//
// Con `FAKE_AI_REPORT=<archivo>` anota una línea JSON por evento (arranque,
// cada cambio de tamaño, cada mensaje y la salida) con las columnas y filas
// que vio: así el E2E comprueba que la IA recibió el ancho VISIBLE de la
// casilla y no la reserva interna de la terminal.

import { appendFileSync } from 'node:fs';

const alt = process.argv.includes('--alt');
const name = process.env.FAKE_AI_NAME || 'FAKE-AI';
const report = process.env.FAKE_AI_REPORT;
const out = process.stdout;
const CSI = '\x1b[';
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_MS = 50;

let frame = 0;
let input = '';
let pendingReply = '';
let lastHeight = 0;
let closing = false;
const messages = [];

function size() {
    return { cols: out.columns || 80, rows: out.rows || 24 };
}

function log(event, extra = {}) {
    if (!report) return;
    try {
        appendFileSync(report, `${JSON.stringify({ at: Date.now(), event, ...size(), frame, ...extra })}\n`);
    } catch {
        // Un informe inaccesible no puede tumbar la simulación.
    }
}

/** Recorta o rellena a `width` columnas (el simulador solo usa texto de una
 *  columna por carácter, salvo el spinner, que también ocupa una). */
function fit(text, width) {
    const chars = [...text];
    return chars.length > width ? chars.slice(0, width).join('') : text + ' '.repeat(width - chars.length);
}

function render() {
    const { cols, rows } = size();
    const inner = Math.max(10, cols - 4);
    const spinner = SPINNER[frame % SPINNER.length];
    const visibleMessages = messages.slice(-Math.max(1, rows - 9));
    const lines = [
        `╭${'─'.repeat(inner + 2)}╮`,
        `│ ${fit(`${name} · ${alt ? 'pantalla alternativa' : 'en línea'} · cols=${cols} rows=${rows}`, inner)} │`,
        `├${'─'.repeat(inner + 2)}┤`,
        ...visibleMessages.map((message) => `│ ${fit(message, inner)} │`),
        `│ ${fit(pendingReply ? `${spinner} respondiendo…` : `${spinner} listo · frame ${frame}`, inner)} │`,
        `│ ${fit(`> ${input}`, inner)} │`,
        `╰${'─'.repeat(inner + 2)}╯`,
    ];
    let chunk = `${CSI}?2026h${CSI}?25l`;
    if (alt) {
        chunk += `${CSI}H`;
    } else if (lastHeight > 0) {
        chunk += `${CSI}${lastHeight}A\r`;
    }
    for (const line of lines) chunk += `${CSI}2K${line}\r\n`;
    // En línea, si la caja encoge quedan filas viejas debajo: se borran.
    if (!alt) chunk += `${CSI}J`;
    chunk += `${CSI}?2026l`;
    out.write(chunk);
    lastHeight = lines.length;
    frame += 1;
}

function finish(reason) {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    log('exit', { reason, messages: messages.length });
    out.write(`${CSI}?25h${alt ? `${CSI}?1049l` : ''}`);
    if (!alt) out.write(`${name}: sesión terminada (${reason})\r\n`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
}

function send() {
    const text = input.trim();
    input = '';
    if (!text) return;
    if (text === '/exit') {
        finish('exit');
        return;
    }
    // Deja de redibujar: sin salida, la terminal llega a su reposo con la caja
    // en pantalla. Con el spinner cada 50 ms ese reposo era cuestión de suerte.
    if (text === '/pause') {
        clearInterval(timer);
        log('pause');
        return;
    }
    messages.push(`> ${text}`);
    log('message', { text });
    pendingReply = `${name} responde: ${text.split('').reverse().join('')} (eco invertido)`;
    let shown = 0;
    messages.push('');
    const typing = setInterval(() => {
        shown += 3;
        messages[messages.length - 1] = pendingReply.slice(0, shown);
        if (shown >= pendingReply.length) {
            clearInterval(typing);
            log('reply', { text: pendingReply });
            pendingReply = '';
        }
    }, 30);
}

if (alt) out.write(`${CSI}?1049h${CSI}2J`);
log('start', { alt });
render();
const timer = setInterval(render, FRAME_MS);
out.on('resize', () => {
    log('resize');
    render();
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
    for (const char of data) {
        if (char === '\u0003') {
            finish('ctrl-c');
            return;
        }
        if (char === '\r' || char === '\n') {
            send();
        } else if (char === '\u007f' || char === '\b') {
            input = [...input].slice(0, -1).join('');
        } else if (char >= ' ') {
            input += char;
        }
    }
});
process.on('SIGINT', () => finish('sigint'));
// La terminal se cerró (pestaña cerrada o PTY muerta): salir sin más ruido.
out.on('error', () => {
    closing = true;
    clearInterval(timer);
    log('exit', { reason: 'stdout-closed', messages: messages.length });
    process.exit(0);
});
