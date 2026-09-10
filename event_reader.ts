// event_reader.ts — Lee event_log.jsonl con fs.watch + polling fallback
import * as fs from "fs";
import * as path from "path";

export interface TraceEvent {
    type: "tool" | "command";
    session: string;
    ts: string;
    tool?: string;
    params?: Record<string, any>;
    exit_code?: number;
    duration_ms?: number;
    result_nodes?: string[];  // paths del subgrafo resultado (traverse/search)
    // command fields
    action?: string;
    nodes?: string[];
    tag?: string;
    color?: string;
    session_id?: string;
}

export type EventCallback = (events: TraceEvent[]) => void;
export type ReaderErrorCallback = (message: string) => void;

/** Tools que registran la visita a un nodo.
 *  El server MCP guarda el nodo en `params.slug`; el CLI (`traverse`/`read` con
 *  argumento posicional) y el harness dsh lo guardan en `params.target`. Misma
 *  normalización que `v_node_events` del server (mcp-okf#13). */
const NODE_VISIT_TOOLS = new Set(["okf_traverse", "traverse", "okf_read", "read"]);

/** Slug del nodo visitado por un evento traverse/read, o undefined si el evento
 *  no visita ningún nodo. Acepta las dos formas de `params` (slug y target). */
export function eventNodeSlug(event: TraceEvent): string | undefined {
    if (!event || event.type === "command" || !event.tool) return undefined;
    if (!NODE_VISIT_TOOLS.has(event.tool)) return undefined;
    const node = event.params?.slug ?? event.params?.target;
    return typeof node === "string" && node.length > 0 ? node : undefined;
}

/** Pipe del nodo visitado: "read" para las tools de lectura, "traverse" para el resto. */
export function eventNodePipe(event: TraceEvent): "read" | "traverse" {
    return event.tool === "okf_read" || event.tool === "read" ? "read" : "traverse";
}

/** Ventana inicial de readAll: ~600 eventos de ~420 bytes. Si no alcanza para
 *  maxEvents (eventos con muchas aristas pesan más), se duplica. */
const READ_ALL_WINDOW = 256 * 1024;

export class EventReader {
    private filePath: string;
    private lastSize = 0;
    private partialLine = "";
    private watcher: fs.FSWatcher | null = null;
    private listeners: EventCallback[] = [];
    private errorListeners: ReaderErrorCallback[] = [];
    private pollInterval: ReturnType<typeof setInterval> | null = null;
    /** Bytes que leyó la última llamada a readAll (diagnóstico y tests). */
    private readAllBytes = 0;

    constructor(vaultPath: string) {
        this.filePath = path.join(
            vaultPath, ".obsidian", "plugins", "cognitive-trace", "event_log.jsonl"
        );
        if (fs.existsSync(this.filePath)) {
            this.lastSize = fs.statSync(this.filePath).size;
        }
    }

    onEvents(cb: EventCallback): void {
        this.listeners.push(cb);
    }

    onError(cb: ReaderErrorCallback): void {
        this.errorListeners.push(cb);
    }

    private reportMalformedLines(count: number): void {
        if (!count) return;
        const suffix = count === 1 ? "line" : "lines";
        const message = `Ignored ${count} malformed event-log ${suffix}`;
        for (const cb of this.errorListeners) cb(message);
    }

    /** Leer los últimos eventos históricos del JSONL (para carga inicial).
     *  Lee desde el final en ventanas que se duplican hasta juntar maxEvents:
     *  el costo depende de los eventos pedidos, no del tamaño del archivo. */
    readAll(maxEvents = Infinity, initialWindow = READ_ALL_WINDOW): TraceEvent[] {
        if (!fs.existsSync(this.filePath)) return [];
        const fd = fs.openSync(this.filePath, "r");
        try {
            const size = fs.fstatSync(fd).size;
            // El tail sigue exactamente desde lo que se leyó acá: sin hueco
            // entre la carga inicial y el primer poll().
            this.lastSize = size;
            let window = Number.isFinite(maxEvents) ? Math.min(Math.max(initialWindow, 1), size) : size;
            this.readAllBytes = 0;
            for (;;) {
                const start = size - window;
                const buf = Buffer.alloc(window);
                if (window > 0) fs.readSync(fd, buf, 0, window, start);
                this.readAllBytes += window;
                const lines = buf.toString("utf-8").split("\n");
                // Una ventana que no arranca en el byte 0 corta la primera línea.
                if (start > 0) lines.shift();
                const newestFirst: TraceEvent[] = [];
                let malformed = 0;
                for (let i = lines.length - 1; i >= 0 && newestFirst.length < maxEvents; i--) {
                    const line = lines[i];
                    if (!line.trim()) continue;
                    try { newestFirst.push(JSON.parse(line)); } catch { malformed++; }
                }
                if (newestFirst.length >= maxEvents || start === 0) {
                    this.reportMalformedLines(malformed);
                    return newestFirst.reverse();
                }
                window = Math.min(window * 2, size);
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    start(): void {
        // Intentar fs.watch
        try {
            this.watcher = fs.watch(this.filePath, (eventType) => {
                if (eventType === "change") {
                    this.poll();
                }
            });
        } catch {
            // fs.watch no disponible — solo polling
        }

        // Polling fallback cada 500ms
        this.pollInterval = setInterval(() => this.poll(), 500);
    }

    stop(): void {
        if (this.watcher) { this.watcher.close(); this.watcher = null; }
        if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    }

    private poll(): void {
        if (!fs.existsSync(this.filePath)) return;

        const currentSize = fs.statSync(this.filePath).size;
        // Una rotación/truncamiento invalida el offset anterior.
        if (currentSize < this.lastSize) {
            this.lastSize = 0;
            this.partialLine = "";
        }
        if (currentSize === this.lastSize && !this.partialLine) return;

        const fd = fs.openSync(this.filePath, "r");
        const buf = Buffer.alloc(currentSize - this.lastSize);
        if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, this.lastSize);
        fs.closeSync(fd);
        this.lastSize = currentSize;

        const content = this.partialLine + buf.toString("utf-8");
        const hasFinalNewline = content.endsWith("\n");
        const lines = content.split("\n");
        this.partialLine = hasFinalNewline ? "" : (lines.pop() || "");
        const events: TraceEvent[] = [];
        let malformed = 0;

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                events.push(JSON.parse(line));
            } catch {
                malformed++;
            }
        }

        this.reportMalformedLines(malformed);

        if (events.length > 0) {
            for (const cb of this.listeners) cb(events);
        }
    }
}
