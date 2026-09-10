import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EventReader, eventNodePipe, eventNodeSlug } from "../event_reader";

const tempDirs: string[] = [];

function makeEvent(tool: string) {
    return JSON.stringify({
        type: "tool",
        session: "test",
        ts: "2026-07-19T04:00:00.000Z",
        tool,
    });
}

function makeReader(initial = "") {
    const vault = mkdtempSync(join(tmpdir(), "cognitive-trace-test-"));
    tempDirs.push(vault);
    const dir = join(vault, ".obsidian", "plugins", "cognitive-trace");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "event_log.jsonl"), initial);
    return { reader: new EventReader(vault), path: join(dir, "event_log.jsonl") };
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EventReader", () => {
    it("conserva una línea JSON parcialmente escrita hasta completarla", () => {
        const { reader, path } = makeReader();
        const received: unknown[] = [];
        reader.onEvents((events) => received.push(...events));
        const line = makeEvent("traverse");
        const split = Math.floor(line.length / 2);

        appendFileSync(path, line.slice(0, split));
        (reader as any).poll();
        expect(received).toHaveLength(0);

        appendFileSync(path, line.slice(split) + "\n");
        (reader as any).poll();
        expect(received).toHaveLength(1);
    });

    it("reinicia el offset después de una truncación del JSONL", () => {
        const first = makeEvent("traverse") + "\n";
        const { reader, path } = makeReader(first + " ".repeat(100));
        const received: any[] = [];
        reader.onEvents((events) => received.push(...events));

        writeFileSync(path, makeEvent("new") + "\n");
        (reader as any).poll();

        expect(received).toHaveLength(1);
        expect(received[0].tool).toBe("new");
    });

    it("puede cargar solo los eventos históricos más recientes", () => {
        const initial = ["traverse", "read", "search"]
            .map(makeEvent)
            .join("\n") + "\n";
        const { reader } = makeReader(initial);

        expect(reader.readAll(2).map((event) => event.tool)).toEqual(["read", "search"]);
    });

    it("notifica líneas JSON malformadas sin notificar una línea parcial", () => {
        const { reader, path } = makeReader("{malformed}\n");
        const errors: string[] = [];
        reader.onError((message) => errors.push(message));

        expect(reader.readAll()).toEqual([]);
        expect(errors).toEqual(["Ignored 1 malformed event-log line"]);

        appendFileSync(path, "{partial");
        (reader as any).poll();
        expect(errors).toHaveLength(1);
    });
});

describe("eventNodeSlug / eventNodePipe", () => {
    const base = { type: "tool" as const, session: "s", ts: "2026-09-10T15:00:00.000Z" };

    it("lee el nodo del server (params.slug)", () => {
        expect(eventNodeSlug({ ...base, tool: "okf_traverse", params: { slug: "frameworks/x" } }))
            .toBe("frameworks/x");
    });

    it("lee el nodo del CLI (params.target)", () => {
        expect(eventNodeSlug({ ...base, tool: "okf_traverse", params: { target: "decisions/implantacion-okf", depth: 1 } }))
            .toBe("decisions/implantacion-okf");
        expect(eventNodeSlug({ ...base, tool: "okf_read", params: { target: "decisions/implantacion-okf" } }))
            .toBe("decisions/implantacion-okf");
    });

    it("acepta el tool name legacy del harness dsh (traverse/read sin prefijo)", () => {
        expect(eventNodeSlug({ ...base, tool: "traverse", params: { target: "Notes/a" } })).toBe("Notes/a");
        expect(eventNodeSlug({ ...base, tool: "read", params: { target: "Notes/a" } })).toBe("Notes/a");
    });

    it("prefiere slug sobre target cuando vienen los dos", () => {
        expect(eventNodeSlug({ ...base, tool: "okf_traverse", params: { slug: "a/b", target: "c/d" } })).toBe("a/b");
    });

    it("ignora tools donde target no es un nodo (validate: ruta de archivo)", () => {
        expect(eventNodeSlug({ ...base, tool: "okf_validate", params: { target: "decisions/x.md" } })).toBeUndefined();
        expect(eventNodeSlug({ ...base, tool: "okf_touch", params: { target: "decisions/x" } })).toBeUndefined();
    });

    it("ignora comandos, eventos sin nodo y nodos vacíos", () => {
        expect(eventNodeSlug({ ...base, type: "command", tool: "okf_read", params: { target: "a/b" } })).toBeUndefined();
        expect(eventNodeSlug({ ...base, tool: "okf_traverse", params: { depth: 1 } })).toBeUndefined();
        expect(eventNodeSlug({ ...base, tool: "okf_traverse", params: { target: "" } })).toBeUndefined();
        expect(eventNodeSlug({ ...base, tool: "okf_traverse" })).toBeUndefined();
    });

    it("el pipe distingue read de traverse con los dos nombres de tool", () => {
        expect(eventNodePipe({ ...base, tool: "okf_read" })).toBe("read");
        expect(eventNodePipe({ ...base, tool: "read" })).toBe("read");
        expect(eventNodePipe({ ...base, tool: "okf_traverse" })).toBe("traverse");
        expect(eventNodePipe({ ...base, tool: "traverse" })).toBe("traverse");
    });
});

// El JSONL crece con cada evento (hasta que mcp-okf lo rota) y el plugin solo
// necesita los últimos MAX_BUFFER_EVENTS al abrir: readAll lee desde el final.
describe("EventReader.readAll lee solo el final del archivo", () => {
    const eventos = (n: number) => Array.from({ length: n }, (_, i) => makeEvent(`t${i}`)).join("\n") + "\n";

    it("devuelve los últimos N en orden aunque la ventana inicial sea chica", () => {
        const { reader } = makeReader(eventos(50));
        expect(reader.readAll(5, 64).map((e) => e.tool)).toEqual(["t45", "t46", "t47", "t48", "t49"]);
    });

    it("para pocos eventos no lee el archivo entero", () => {
        const { reader, path } = makeReader(eventos(2000));
        reader.readAll(3, 1024);
        expect((reader as any).readAllBytes).toBeLessThan(statSync(path).size / 10);
    });

    it("descarta la primera línea cortada sin reportarla como malformada", () => {
        const { reader } = makeReader(eventos(50));
        const errors: string[] = [];
        reader.onError((message) => errors.push(message));
        reader.readAll(5, 100);
        expect(errors).toEqual([]);
    });

    it("el tail sigue desde donde terminó la carga inicial", () => {
        const { reader, path } = makeReader(eventos(10));
        reader.readAll(3, 64);
        const received: unknown[] = [];
        reader.onEvents((events) => received.push(...events.map((e) => e.tool)));
        appendFileSync(path, makeEvent("nuevo") + "\n");
        (reader as any).poll();
        expect(received).toEqual(["nuevo"]);
    });

    it("sin límite de eventos sigue leyendo todo", () => {
        const { reader } = makeReader(eventos(50));
        expect(reader.readAll()).toHaveLength(50);
    });
});
