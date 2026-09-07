import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildLayerNodes, DashboardView, DASHBOARD_VIEW_TYPE } from "../dashboard_view";

// ── Fake DOM mínimo (mismo patrón que timeline_view.test.ts) ──

class FakeClassList {
    private values = new Set<string>();

    add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
    remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
    contains(name: string): boolean { return this.values.has(name); }
    toggle(name: string, force?: boolean): void {
        const shouldAdd = force ?? !this.values.has(name);
        if (shouldAdd) this.values.add(name);
        else this.values.delete(name);
    }
}

class FakeElement {
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    classList = new FakeClassList();
    style: Record<string, any> = { setProperty: vi.fn() };
    textContent = "";
    title = "";
    width = 0;
    height = 0;
    value = "";
    attributes = new Map<string, string>();
    private listeners = new Map<string, (event: any) => void>();

    createEl(_tag: string, options: { cls?: string; text?: string } = {}): FakeElement {
        const child = new FakeElement();
        if (options.cls) child.classList.add(...options.cls.split(" ").filter(Boolean));
        if (options.text) child.textContent = options.text;
        child.parent = this;
        this.children.push(child);
        return child;
    }

    addClass(name: string): void { this.classList.add(name); }
    empty(): void { this.children = []; }
    setText(text: string): void { this.textContent = text; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
    addEventListener(name: string, listener: (event: any) => void): void { this.listeners.set(name, listener); }
    click(): void { this.listeners.get("click")?.({ stopPropagation: vi.fn() }); }
    /** Dispara un evento arbitrario (input/change) como lo haría el navegador. */
    dispatch(name: string, event: any = {}): void { this.listeners.get(name)?.(event); }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        const matches: FakeElement[] = [];
        const visit = (element: FakeElement) => {
            if (selector.split(".").filter(Boolean).every((name) => element.classList.contains(name))) {
                matches.push(element);
            }
            element.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }
}

function makeRoot(): FakeElement {
    const root = new FakeElement();
    root.children = [new FakeElement(), new FakeElement()];
    root.children.forEach((child) => { child.parent = root; });
    return root;
}

// ── Vault temporal de prueba ──

const tempDirs: string[] = [];

function makeVault(files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-dash-"));
    tempDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}

function snapshotJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        generated_at: new Date(Date.now() - 12 * 60_000).toISOString(),
        generated_by: "test",
        source: "manual",
        health: { score: 8, max_score: 9, errors: 0, warnings: 2, warnings_detail: ["2 broken links"], trend_7d: "up" },
        graph: { total_nodes: 232, total_edges: 758, orphans: 3, hubs_top5: [], density: 0.014, trend_7d: null },
        cibernetica: {
            total_blocks: 53, loops_cerrados: 8, loops_abiertos: 31,
            review_on_vencidos: 5, review_on_proximos_7d: 12,
            outcome_pending: 28, outcome_success: 15, outcome_failure: 2,
            trend_7d: "down",
        },
        actividad: {
            sesiones_7d: 14, eventos_7d: 892, eventos_24h: 127,
            tools_usadas: { traverse: 342, read: 198, search: 89 },
            read_ratio_promedio: 0.12, infracciones_mcp_7d: 3,
            entry_points_top3: ["traverse", "graph stats", "search"],
            trend_7d: "up",
        },
        calor_estructural: {
            top_visited: [
                { slug: "frameworks/tp3-cibernetico", traverses: 26, reads: 0, read_ratio: 0.0 },
                { slug: "specs/cognitive-trace", traverses: 22, reads: 8, read_ratio: 0.36 },
            ],
            top_neglected: [
                { slug: "decisions/antigua", days_since_last_visit: 45, stale_score: 4 },
            ],
            stale_distribution: { FRESCO: 180, ATENCION: 42, STALE: 10 },
        },
        negocio: null,
        ...overrides,
    }, null, 2);
}

function makeView(vaultPath: string, onLayerApply = vi.fn(), app?: any) {
    const root = makeRoot();
    const leaf: any = { containerEl: root };
    if (app) leaf.app = app;
    const view = new DashboardView(leaf, vaultPath, onLayerApply);
    return { root, view, onLayerApply };
}

/** Abre la pestaña Conceptos (chip index 1) tras el onOpen. */
function openConceptosTab(root: FakeElement): void {
    root.querySelectorAll(".dashboard-tab-chip")[1].click();
}

describe("DashboardView", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("tiene el viewType y título del plan", () => {
        const { view } = makeView(makeVault());
        expect(DASHBOARD_VIEW_TYPE).toBe("cognitive-trace-dashboard");
        expect(view.getViewType()).toBe(DASHBOARD_VIEW_TYPE);
        expect(view.getDisplayText()).toBe("Dashboard OKF");
        expect(view.getIcon()).toBe("gauge");
    });

    it("renderiza las 4 tarjetas con sus KPIs desde dashboard.json", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view, onLayerApply } = makeView(vault);

        await view.onOpen();

        expect(root.querySelectorAll(".dashboard-card")).toHaveLength(4);
        const kpis = root.querySelectorAll(".kpi-value").map((el) => el.textContent);
        expect(kpis).toEqual(["8/9", "31", "892", "Fase 2"]);

        // Flechas de tendencia: salud ▲, cibernética ▼, actividad ▲, negocio —
        const trends = root.querySelectorAll(".kpi-trend").map((el) => el.textContent);
        expect(trends).toEqual(["▲", "▼", "▲", "—"]);

        // Timestamp relativo
        expect(root.querySelector(".dashboard-status-label")?.textContent).toContain("hace 12 min");

        // Al abrir, la capa activa es live (vacía)
        expect(onLayerApply).toHaveBeenCalledWith("live", []);
    });

    it("tolera dashboard.json ausente con estado vacío amigable", async () => {
        const { root, view, onLayerApply } = makeView(makeVault());

        await view.onOpen();

        expect(root.querySelector(".dashboard-card")).toBeNull();
        const empty = root.querySelector(".dashboard-empty");
        expect(empty).not.toBeNull();
        expect(empty!.children.map((c) => c.textContent)).toContain("Snapshot no generado aún — se regenera en cada commit");
        // Las capas sin snapshot están deshabilitadas
        const chips = root.querySelectorAll(".dashboard-layer-chip");
        expect(chips).toHaveLength(5);
        expect(chips[1].title).toBe("requiere snapshot del vault");
        chips[1].click();
        expect(onLayerApply).not.toHaveBeenCalledWith("heat", expect.any(Array));
    });

    it("tolera dashboard.json corrupto sin crashear", async () => {
        const vault = makeVault({ "dashboard.json": "{no es json" });
        const { root, view } = makeView(vault);

        await view.onOpen();

        expect(root.querySelector(".dashboard-empty")).not.toBeNull();
        expect(root.querySelector(".dashboard-empty-detail")).not.toBeNull();
    });

    it("aplica la capa Heat al animator con los colores del snapshot", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view, onLayerApply } = makeView(vault);
        await view.onOpen();

        onLayerApply.mockClear();
        root.querySelectorAll(".dashboard-layer-chip")[1].click(); // Heat

        expect(onLayerApply).toHaveBeenCalledWith("heat", expect.any(Array));
        const nodes = onLayerApply.mock.calls[0][1];
        // 🔥 leído, 🟡 atravesado nunca leído, ❄️ no visitado 14d+
        expect(nodes).toContainEqual({ slug: "frameworks/tp3-cibernetico", color: "#FFDC00" });
        expect(nodes).toContainEqual({ slug: "specs/cognitive-trace", color: "#FF4136" });
        expect(nodes).toContainEqual({ slug: "decisions/antigua", color: "#4FC3F7" });
    });

    it("deshabilita Session Diff con tooltip cuando no hay 2 sesiones en el snapshot", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view, onLayerApply } = makeView(vault);
        await view.onOpen();

        onLayerApply.mockClear();
        const chip = root.querySelectorAll(".dashboard-layer-chip")[4];
        expect(chip.title).toBe("requiere 2 sesiones");
        chip.click();
        expect(onLayerApply).not.toHaveBeenCalledWith("session_diff", expect.any(Array));
    });

    it("habilita Session Diff cuando el snapshot trae el diff de sesiones", async () => {
        const vault = makeVault({
            "dashboard.json": snapshotJson({
                session_diff: { solo_a: ["Notes/a"], solo_b: ["Notes/b"], ambas: ["Notes/c"] },
            }),
        });
        const { root, view, onLayerApply } = makeView(vault);
        await view.onOpen();

        onLayerApply.mockClear();
        const chip = root.querySelectorAll(".dashboard-layer-chip")[4];
        expect(chip.title).toBe("");
        chip.click();

        expect(onLayerApply).toHaveBeenCalledWith("session_diff", expect.any(Array));
        const nodes = onLayerApply.mock.calls[0][1];
        expect(nodes).toContainEqual({ slug: "Notes/a", color: "#4FC3F7" });
        expect(nodes).toContainEqual({ slug: "Notes/b", color: "#FF851B" });
        expect(nodes).toContainEqual({ slug: "Notes/c", color: "#9E9E9E" });
    });

    it("dibuja sparklines desde los últimos snapshots diarios (canvas sin contexto en tests)", async () => {
        const vault = makeVault({
            "dashboard.json": snapshotJson(),
            "sistema/dashboard-snapshots/2026-09-04.json": snapshotJson({
                health: { score: 6, max_score: 9 },
                cibernetica: { loops_abiertos: 40 },
                actividad: { eventos_24h: 90 },
            }),
            "sistema/dashboard-snapshots/2026-09-05.json": snapshotJson(),
        });
        const { root, view } = makeView(vault);

        await view.onOpen();

        // Un canvas por tarjeta con serie (salud, cibernética, actividad); negocio no tiene
        expect(root.querySelectorAll(".kpi-sparkline")).toHaveLength(3);
    });

    it("omite sparklines cuando no hay snapshots diarios", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view } = makeView(vault);

        await view.onOpen();

        expect(root.querySelector(".kpi-sparkline")).toBeNull();
    });

    it("el botón ↻ re-lee dashboard.json del disco", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view } = makeView(vault);
        await view.onOpen();
        expect(root.querySelectorAll(".kpi-value").map((el) => el.textContent)).toContain("31");

        // El snapshot cambia en disco → el refresh manual lo refleja
        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({
            cibernetica: {
                total_blocks: 53, loops_cerrados: 12, loops_abiertos: 7,
                review_on_vencidos: 0, review_on_proximos_7d: 1,
                outcome_pending: 3, outcome_success: 2, outcome_failure: 0,
                trend_7d: "up",
            },
        }));
        root.querySelector(".dashboard-refresh-btn")?.click();

        expect(root.querySelectorAll(".kpi-value").map((el) => el.textContent)).toContain("7");
    });
});

// ── Fixture de conceptos (Fase 4) ──

const CONCEPTOS_FIXTURE = [
    {
        file: "insights/cibernetica-y-review",
        type: "Insight",
        title: "Cibernética y revisiones",
        status: "activo",
        timestamp: "2026-09-01T10:00:00-05:00",
        stale: { level: "FRESCO", signal_count: 0, signals: [] },
        cyber: null,
    },
    {
        file: "decisions/loop-cibernetico",
        type: "Decision",
        title: "Loop cibernético",
        status: "propuesta",
        timestamp: "2026-09-02T10:00:00-05:00",
        stale: { level: "ATENCION", signal_count: 1, signals: ["no backlinks"] },
        cyber: { outcome: "pending", review_on: "2026-09-10", vencido: false, target_metric: "loop_closure" },
    },
    {
        file: "planes/plan-q3",
        type: "Plan",
        title: "Plan Q3",
        status: "aplicada",
        timestamp: "2026-09-03T10:00:00-05:00",
        stale: { level: "FRESCO", signal_count: 0, signals: [] },
        cyber: { outcome: "success", review_on: "2026-09-20", vencido: true, target_metric: null },
    },
    {
        file: "research/grafo-okf",
        type: "Research",
        title: "Grafo OKF",
        status: "",
        timestamp: "2026-09-04T10:00:00-05:00",
        stale: { level: "STALE", signal_count: 2, signals: ["30d sin visita", "no backlinks"] },
        cyber: null,
    },
];

// ── Fixture con fechas relativas (columna Actualizado / filtro temporal) ──
// Mediodía local para que el formateo YYYY-MM-DD no se desplace con la zona
// horaria del runner ni con cambios de DST.

/** Timestamp ISO de la fecha local de hace `daysAgo` días, al mediodía. */
function localIso(daysAgo: number): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString();
}

/** YYYY-MM-DD local de hace `daysAgo` días (esperado en la celda Actualizado). */
function localDate(daysAgo: number): string {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - daysAgo);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Orden del snapshot: Beta (10d), Alfa (hoy), Zeta (60d), Sin fecha (null). */
const FECHA_FIXTURE = [
    {
        file: "notas/beta",
        type: "Insight",
        title: "Beta",
        status: "activo",
        timestamp: localIso(10),
        stale: { level: "FRESCO", signal_count: 0, signals: [] },
        cyber: null,
    },
    {
        file: "notas/alfa",
        type: "Decision",
        title: "Alfa",
        status: "aplicada",
        timestamp: localIso(0),
        stale: { level: "ATENCION", signal_count: 1, signals: ["no backlinks"] },
        cyber: { outcome: "pending", review_on: "2026-09-10", vencido: false, target_metric: null },
    },
    {
        file: "notas/zeta",
        type: "Plan",
        title: "Zeta",
        status: "propuesta",
        timestamp: localIso(60),
        stale: { level: "STALE", signal_count: 2, signals: ["60d sin visita"] },
        cyber: null,
    },
    {
        file: "notas/sin-fecha",
        type: "Research",
        title: "Sin fecha",
        status: "",
        stale: { level: "FRESCO", signal_count: 0, signals: [] },
        cyber: null,
    },
];

describe("DashboardView — pestaña Conceptos", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("la tabla renderiza las filas del fixture con sus estados", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const rows = root.querySelectorAll(".dashboard-concept-row");
        expect(rows).toHaveLength(4);

        // Fila 1: FRESCO sin cyber — columnas en orden Concepto/Tipo/Status/Actualizado/Cyber/Stale
        const [name, type, status, updated, cyber, stale] = rows[0].children;
        expect(name.textContent).toBe("Cibernética y revisiones");
        expect(type.textContent).toBe("Insight");
        expect(status.textContent).toBe("activo");
        expect(updated.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(updated.classList.contains("dashboard-concept-updated")).toBe(true);
        expect(cyber.children[0].textContent).toBe("—");
        expect(stale.children[0].textContent).toBe("FRESCO");
        expect(stale.children[0].classList.contains("dashboard-stale-fresco")).toBe(true);

        // Fila 2: ATENCION + cyber pending, tooltip con review y métrica
        const row2 = rows[1].children;
        expect(row2[4].children[0].textContent).toBe("⏳");
        expect(row2[4].children[0].classList.contains("dashboard-cyber-pending")).toBe(true);
        expect(row2[4].title).toContain("review 2026-09-10");
        expect(row2[4].title).toContain("loop_closure");
        expect(row2[5].children[0].classList.contains("dashboard-stale-atencion")).toBe(true);

        // Fila 3: vencido tiene prioridad sobre outcome success
        const row3 = rows[2].children;
        expect(row3[4].children[0].textContent).toBe("!");
        expect(row3[4].children[0].classList.contains("dashboard-cyber-expired")).toBe(true);

        // Fila 4: STALE con señal principal como tooltip, status vacío → "—"
        const row4 = rows[3].children;
        expect(row4[2].textContent).toBe("—");
        expect(row4[5].children[0].textContent).toBe("STALE");
        expect(row4[5].children[0].classList.contains("dashboard-stale-stale")).toBe(true);
        expect(row4[5].title).toBe("30d sin visita");
    });

    it("el buscador filtra por título y por file (case-insensitive)", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const search = root.querySelector(".dashboard-concept-search")!;
        const names = () => root.querySelectorAll(".dashboard-concept-name").map((el) => el.textContent);

        search.value = "plan";
        search.dispatch("input", { target: search });
        expect(names()).toEqual(["Plan Q3"]);

        search.value = "grafo-okf";
        search.dispatch("input", { target: search });
        expect(names()).toEqual(["Grafo OKF"]);

        search.value = "CIBER";
        search.dispatch("input", { target: search });
        expect(names()).toEqual(["Cibernética y revisiones", "Loop cibernético"]);
    });

    it("el filtro por tipo deja solo los conceptos del tipo elegido", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const select = root.querySelector(".dashboard-concept-type-filter")!;
        select.value = "Decision";
        select.dispatch("change", { target: select });

        expect(root.querySelectorAll(".dashboard-concept-row")).toHaveLength(1);
        expect(root.querySelector(".dashboard-concept-name")!.textContent).toBe("Loop cibernético");
    });

    it("'Solo atención' incluye pending/vencido/stale y excluye FRESCO sin cyber", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const select = root.querySelector(".dashboard-concept-state-filter")!;
        const names = () => root.querySelectorAll(".dashboard-concept-name").map((el) => el.textContent);

        select.value = "atencion";
        select.dispatch("change", { target: select });
        expect(names()).toEqual(["Loop cibernético", "Plan Q3", "Grafo OKF"]);

        select.value = "cyber";
        select.dispatch("change", { target: select });
        expect(names()).toEqual(["Loop cibernético", "Plan Q3"]);

        select.value = "stale";
        select.dispatch("change", { target: select });
        expect(names()).toEqual(["Grafo OKF"]);
    });

    it("click en una fila llama a openLinkText con el path correcto", async () => {
        const openLinkText = vi.fn();
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault, vi.fn(), { workspace: { openLinkText } });
        await view.onOpen();
        openConceptosTab(root);

        root.querySelectorAll(".dashboard-concept-row")[1].click();
        expect(openLinkText).toHaveBeenCalledWith("decisions/loop-cibernetico", "", false);
    });

    it("sin sección conceptos (snapshot viejo) muestra el mensaje y el resto del panel funciona", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const empty = root.querySelector(".dashboard-empty");
        expect(empty).not.toBeNull();
        expect(empty!.children.map((c) => c.textContent)).toContain("python3 -m cli dashboard-snapshot");

        // La pestaña Resumen sigue funcionando igual
        root.querySelectorAll(".dashboard-tab-chip")[0].click();
        expect(root.querySelectorAll(".dashboard-card")).toHaveLength(4);
    });

    it("con conceptos vacío también muestra el mensaje de snapshot viejo", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: [] }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const empty = root.querySelector(".dashboard-empty");
        expect(empty).not.toBeNull();
        expect(empty!.children.map((c) => c.textContent)).toContain("python3 -m cli dashboard-snapshot");
    });

    it("la pestaña activa persiste en la instancia (incluso tras ↻) y el default es Resumen", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();

        // Default: Resumen activa, sin filas de conceptos
        expect(root.querySelector(".dashboard-tab-chip.dashboard-tab-active")!.textContent).toBe("Resumen");
        expect(root.querySelector(".dashboard-concept-row")).toBeNull();

        openConceptosTab(root);
        expect(root.querySelector(".dashboard-tab-chip.dashboard-tab-active")!.textContent).toBe("Conceptos");

        // El ↻ recarga datos pero mantiene la pestaña
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(root.querySelector(".dashboard-tab-chip.dashboard-tab-active")!.textContent).toBe("Conceptos");
        expect(root.querySelectorAll(".dashboard-concept-row")).toHaveLength(4);
    });

    it("pagina de a 50 filas y los controles avanzan/retroceden", async () => {
        const muchos = Array.from({ length: 120 }, (_, i) => ({
            file: `notas/concepto-${String(i + 1).padStart(3, "0")}`,
            type: "Insight",
            title: `Concepto ${String(i + 1).padStart(3, "0")}`,
            status: "",
            timestamp: "2026-09-01T10:00:00-05:00",
            stale: { level: "FRESCO", signal_count: 0, signals: [] },
            cyber: null,
        }));
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: muchos }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);

        const pagerBtns = () => root.querySelectorAll(".dashboard-pager-btn");
        const firstRow = () => root.querySelector(".dashboard-concept-name")!.textContent;

        expect(root.querySelectorAll(".dashboard-concept-row")).toHaveLength(50);
        expect(root.querySelector(".dashboard-pager-label")!.textContent).toBe("1–50 de 120");
        expect(firstRow()).toBe("Concepto 001");

        pagerBtns()[1].click(); // ›
        expect(root.querySelectorAll(".dashboard-concept-row")).toHaveLength(50);
        expect(root.querySelector(".dashboard-pager-label")!.textContent).toBe("51–100 de 120");
        expect(firstRow()).toBe("Concepto 051");

        pagerBtns()[1].click(); // › (última página)
        expect(root.querySelectorAll(".dashboard-concept-row")).toHaveLength(20);
        expect(root.querySelector(".dashboard-pager-label")!.textContent).toBe("101–120 de 120");
        expect(firstRow()).toBe("Concepto 101");
        expect(pagerBtns()[1].classList.contains("dashboard-pager-disabled")).toBe(true);

        pagerBtns()[0].click(); // ‹
        expect(root.querySelector(".dashboard-pager-label")!.textContent).toBe("51–100 de 120");
        expect(firstRow()).toBe("Concepto 051");
    });
});

describe("DashboardView — Conceptos: columna Actualizado, orden y filtro de fecha", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Vista abierta en la pestaña Conceptos con el fixture de fechas. */
    async function open(): Promise<{ root: FakeElement }> {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: FECHA_FIXTURE }) });
        const { root, view } = makeView(vault);
        await view.onOpen();
        openConceptosTab(root);
        return { root };
    }

    const names = (root: FakeElement): string[] =>
        root.querySelectorAll(".dashboard-concept-name").map((el) => el.textContent);
    const sortBtns = (root: FakeElement): FakeElement[] =>
        root.querySelectorAll(".dashboard-concept-sort-btn");

    it("la columna Actualizado renderiza YYYY-MM-DD y — para el sin timestamp", async () => {
        const { root } = await open();

        // 6 columnas: Concepto, Tipo, Status, Actualizado, Cyber, Stale
        const head = root.querySelector(".dashboard-concept-head")!.children;
        expect(head).toHaveLength(6);
        expect(head.map((th) => (th.children[0] ? th.children[0].textContent : th.textContent)))
            .toEqual(["Concepto ↕", "Tipo ↕", "Status ↕", "Actualizado ↕", "Cyber", "Stale"]);

        const updated = root.querySelectorAll(".dashboard-concept-row")
            .map((row) => row.children[3].textContent);
        expect(updated).toEqual([localDate(10), localDate(0), localDate(60), "—"]);
    });

    it("click en Actualizado ordena desc (lo más nuevo primero) y otro click asc (sin fecha al final)", async () => {
        const { root } = await open();

        // Primer click: desc
        sortBtns(root)[3].click();
        expect(names(root)).toEqual(["Alfa", "Beta", "Zeta", "Sin fecha"]);
        let btn = sortBtns(root)[3];
        expect(btn.textContent).toContain("▼");
        expect(btn.classList.contains("dashboard-sort-active")).toBe(true);

        // Segundo click: asc — el más viejo primero y el sin fecha sigue al final
        sortBtns(root)[3].click();
        expect(names(root)).toEqual(["Zeta", "Beta", "Alfa", "Sin fecha"]);
        btn = sortBtns(root)[3];
        expect(btn.textContent).toContain("▲");
    });

    it("click en Concepto ordena alfabético y otro click lo invierte", async () => {
        const { root } = await open();

        sortBtns(root)[0].click(); // asc alfabético
        expect(names(root)).toEqual(["Alfa", "Beta", "Sin fecha", "Zeta"]);

        sortBtns(root)[0].click(); // desc
        expect(names(root)).toEqual(["Zeta", "Sin fecha", "Beta", "Alfa"]);
    });

    it("el tercer click en el header activo vuelve al orden del snapshot", async () => {
        const { root } = await open();

        sortBtns(root)[0].click(); // asc
        sortBtns(root)[0].click(); // desc
        sortBtns(root)[0].click(); // → sin orden

        expect(names(root)).toEqual(["Beta", "Alfa", "Zeta", "Sin fecha"]);
        expect(sortBtns(root)[0].textContent).toContain("↕");
        expect(sortBtns(root)[0].classList.contains("dashboard-sort-active")).toBe(false);
    });

    it("el filtro de fecha incluye solo los timestamp dentro del rango", async () => {
        const { root } = await open();
        const dateSelect = root.querySelector(".dashboard-concept-date-filter")!;

        dateSelect.value = "hoy";
        dateSelect.dispatch("change", { target: dateSelect });
        expect(names(root)).toEqual(["Alfa"]);

        dateSelect.value = "7d";
        dateSelect.dispatch("change", { target: dateSelect });
        expect(names(root)).toEqual(["Alfa"]); // excluye 10d, 60d y sin fecha

        dateSelect.value = "30d";
        dateSelect.dispatch("change", { target: dateSelect });
        expect(names(root)).toEqual(["Beta", "Alfa"]); // excluye 60d y sin fecha

        dateSelect.value = "todos";
        dateSelect.dispatch("change", { target: dateSelect });
        expect(names(root)).toEqual(["Beta", "Alfa", "Zeta", "Sin fecha"]);
    });

    it("búsqueda/tipo/estado siguen funcionando con el orden aplicado y persiste al filtrar", async () => {
        const { root } = await open();

        // Orden alfabético activo
        sortBtns(root)[0].click();
        expect(names(root)).toEqual(["Alfa", "Beta", "Sin fecha", "Zeta"]);

        const search = root.querySelector(".dashboard-concept-search")!;
        search.value = "zeta";
        search.dispatch("input", { target: search });
        expect(names(root)).toEqual(["Zeta"]);
        search.value = "";
        search.dispatch("input", { target: search });
        expect(names(root)).toEqual(["Alfa", "Beta", "Sin fecha", "Zeta"]); // el orden persiste

        const typeSelect = root.querySelector(".dashboard-concept-type-filter")!;
        typeSelect.value = "Plan";
        typeSelect.dispatch("change", { target: typeSelect });
        expect(names(root)).toEqual(["Zeta"]);
        typeSelect.value = "todos";
        typeSelect.dispatch("change", { target: typeSelect });

        const stateSelect = root.querySelector(".dashboard-concept-state-filter")!;
        stateSelect.value = "atencion";
        stateSelect.dispatch("change", { target: stateSelect });
        expect(names(root)).toEqual(["Alfa", "Zeta"]); // alfabético sobre el resultado filtrado
    });
});

describe("DashboardView — UX del Resumen (F1–F4: navegación KPI, chips, barra, umbrales)", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Vista abierta con el fixture de conceptos (+ overrides de snapshot). */
    async function openWith(overrides: Record<string, unknown> = {}) {
        const vault = makeVault({ "dashboard.json": snapshotJson({ conceptos: CONCEPTOS_FIXTURE, ...overrides }) });
        const { root, view, onLayerApply } = makeView(vault);
        await view.onOpen();
        return { root, view, vault };
    }

    const stateSelect = (root: FakeElement) => root.querySelector(".dashboard-concept-state-filter")!;
    const names = (root: FakeElement): string[] =>
        root.querySelectorAll(".dashboard-concept-name").map((el) => el.textContent);

    // ── F1: tarjetas KPI navegables ──

    it("F1: click en la tarjeta Salud abre Conceptos con el filtro 'atencion'", async () => {
        const { root } = await openWith();
        const cards = root.querySelectorAll(".dashboard-card");

        // Afordance: las navegables tienen clase + aria-label, Negocio no
        expect(cards[0].classList.contains("dashboard-card-clickable")).toBe(true);
        expect(cards[0].attributes.get("aria-label")).toBe("Ver en Conceptos");
        expect(cards[0].querySelector(".dashboard-card-chevron")).not.toBeNull();
        expect(cards[3].classList.contains("dashboard-card-clickable")).toBe(false);
        expect(cards[3].querySelector(".dashboard-card-chevron")).toBeNull();

        cards[0].click();
        expect(root.querySelector(".dashboard-tab-chip.dashboard-tab-active")!.textContent).toBe("Conceptos");
        expect(stateSelect(root).value).toBe("atencion");
        expect(names(root)).toEqual(["Loop cibernético", "Plan Q3", "Grafo OKF"]);
    });

    it("F1: Cibernética → 'cyber', Actividad → 'todos' (limpia el filtro previo)", async () => {
        const { root } = await openWith();

        root.querySelectorAll(".dashboard-card")[1].click();
        expect(stateSelect(root).value).toBe("cyber");
        expect(names(root)).toEqual(["Loop cibernético", "Plan Q3"]);

        // Vuelta al Resumen y click en Actividad: muestra todo
        root.querySelectorAll(".dashboard-tab-chip")[0].click();
        root.querySelectorAll(".dashboard-card")[2].click();
        expect(stateSelect(root).value).toBe("todos");
        expect(names(root)).toEqual(["Cibernética y revisiones", "Loop cibernético", "Plan Q3", "Grafo OKF"]);
    });

    it("F1: Negocio es placeholder — click no navega", async () => {
        const { root } = await openWith();
        root.querySelectorAll(".dashboard-card")[3].click();
        expect(root.querySelector(".dashboard-tab-chip.dashboard-tab-active")!.textContent).toBe("Resumen");
        expect(root.querySelector(".dashboard-concept-row")).toBeNull();
    });

    // ── F2: chips de conteos ──

    it("F2: chips con los conteos del fixture; click filtra, click en activo vuelve a todos", async () => {
        const { root } = await openWith();
        openConceptosTab(root);

        const chips = root.querySelectorAll(".dashboard-concept-chip");
        expect(chips).toHaveLength(4);
        expect(chips.map((c) => c.textContent)).toEqual(["FRESCO", "ATENCION", "STALE", "Con cyber"]);
        expect(chips.map((c) => c.children[0].textContent)).toEqual(["2", "1", "1", "2"]);
        expect(chips[0].classList.contains("dashboard-chip-active")).toBe(false);

        // Click en ATENCION: filtra y sincroniza el select
        chips[1].click();
        expect(stateSelect(root).value).toBe("atencion");
        expect(names(root)).toEqual(["Loop cibernético", "Plan Q3", "Grafo OKF"]);
        const chipsAfter = root.querySelectorAll(".dashboard-concept-chip");
        expect(chipsAfter[1].classList.contains("dashboard-chip-active")).toBe(true);

        // Click en el chip ya activo → vuelve a "todos"
        chipsAfter[1].click();
        expect(stateSelect(root).value).toBe("todos");
        expect(names(root)).toEqual(["Cibernética y revisiones", "Loop cibernético", "Plan Q3", "Grafo OKF"]);
        expect(
            root.querySelectorAll(".dashboard-concept-chip")
                .some((c) => c.classList.contains("dashboard-chip-active")),
        ).toBe(false);
    });

    it("F2: el select de estado sincroniza el chip activo; 'fresco' filtra por nivel", async () => {
        const { root } = await openWith();
        openConceptosTab(root);

        const select = stateSelect(root);
        select.value = "stale";
        select.dispatch("change", { target: select });
        expect(names(root)).toEqual(["Grafo OKF"]);
        expect(root.querySelectorAll(".dashboard-concept-chip")[2].classList.contains("dashboard-chip-active")).toBe(true);

        // El nuevo valor "fresco" existe en el select y filtra stale.level FRESCO
        select.value = "fresco";
        select.dispatch("change", { target: select });
        expect(names(root)).toEqual(["Cibernética y revisiones", "Plan Q3"]);
        expect(root.querySelectorAll(".dashboard-concept-chip")[0].classList.contains("dashboard-chip-active")).toBe(true);
    });

    // ── F3: barra apilada de salud ──

    it("F3: barra con segmentos proporcionales al fixture y label de total", async () => {
        const { root } = await openWith();

        const segs = root.querySelectorAll(".dashboard-healthbar-seg");
        expect(segs).toHaveLength(3);
        expect(segs.map((s) => s.style.flex)).toEqual(["2", "1", "1"]);
        expect(segs[0].classList.contains("dashboard-healthbar-fresco")).toBe(true);
        expect(segs[1].classList.contains("dashboard-healthbar-atencion")).toBe(true);
        expect(segs[2].classList.contains("dashboard-healthbar-stale")).toBe(true);
        expect(segs[0].title).toBe("FRESCO 2 (50%)");
        expect(segs[1].title).toBe("ATENCION 1 (25%)");
        expect(segs[2].title).toBe("STALE 1 (25%)");
        expect(root.querySelector(".dashboard-healthbar-label")!.textContent).toBe("4 conceptos");
    });

    it("F3: sin conceptos[] (snapshot viejo) no hay barra y el Resumen no se rompe", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson() });
        const { root, view } = makeView(vault);
        await view.onOpen();

        expect(root.querySelector(".dashboard-healthbar")).toBeNull();
        expect(root.querySelectorAll(".dashboard-card")).toHaveLength(4);

        // conceptos: [] tampoco muestra barra
        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({ conceptos: [] }));
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(root.querySelector(".dashboard-healthbar")).toBeNull();
        expect(root.querySelectorAll(".dashboard-card")).toHaveLength(4);
    });

    // ── F4: KPI coloreado por umbral ──

    it("F4: fixture → Salud ok, Cibernética bad, Actividad ok, Negocio sin clase", async () => {
        const { root } = await openWith();
        const kpis = root.querySelectorAll(".kpi-value");
        expect(kpis[0].classList.contains("kpi-value-ok")).toBe(true);
        expect(kpis[1].classList.contains("kpi-value-bad")).toBe(true);
        expect(kpis[2].classList.contains("kpi-value-ok")).toBe(true);
        for (const cls of ["kpi-value-ok", "kpi-value-warn", "kpi-value-bad"]) {
            expect(kpis[3].classList.contains(cls)).toBe(false);
        }
    });

    it("F4: umbrales de Salud — ≥80% ok, ≥55% warn, <55% bad", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ health: { score: 7, max_score: 9 } }) });
        const { root, view } = makeView(vault);
        await view.onOpen();

        const saludKpi = () => root.querySelectorAll(".kpi-value")[0];
        expect(saludKpi().textContent).toBe("7/9");
        expect(saludKpi().classList.contains("kpi-value-warn")).toBe(true);

        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({ health: { score: 4, max_score: 9 } }));
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(saludKpi().classList.contains("kpi-value-bad")).toBe(true);

        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({ health: { score: 8, max_score: 10 } }));
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(saludKpi().classList.contains("kpi-value-ok")).toBe(true);
    });

    it("F4: umbrales de Cibernética — vencidos bad, loops abiertos warn, cerrado ok", async () => {
        const cyber = (loops: number, vencidos: number) => ({
            total_blocks: 53, loops_cerrados: 8, loops_abiertos: loops,
            review_on_vencidos: vencidos, review_on_proximos_7d: 0,
            outcome_pending: 0, outcome_success: 0, outcome_failure: 0, trend_7d: "flat",
        });
        const vault = makeVault({ "dashboard.json": snapshotJson({ cibernetica: cyber(4, 0) }) });
        const { root, view } = makeView(vault);
        await view.onOpen();

        const cyberKpi = () => root.querySelectorAll(".kpi-value")[1];
        expect(cyberKpi().classList.contains("kpi-value-warn")).toBe(true);

        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({ cibernetica: cyber(4, 1) }));
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(cyberKpi().classList.contains("kpi-value-bad")).toBe(true);

        fs.writeFileSync(path.join(vault, "dashboard.json"), snapshotJson({ cibernetica: cyber(0, 0) }));
        root.querySelector(".dashboard-refresh-btn")!.click();
        expect(cyberKpi().classList.contains("kpi-value-ok")).toBe(true);
    });

    it("F4: actividad con 0 eventos 7d → warn (vault inactivo)", async () => {
        const vault = makeVault({ "dashboard.json": snapshotJson({ actividad: { eventos_7d: 0 } }) });
        const { root, view } = makeView(vault);
        await view.onOpen();

        const actividadKpi = root.querySelectorAll(".kpi-value")[2];
        expect(actividadKpi.textContent).toBe("0");
        expect(actividadKpi.classList.contains("kpi-value-warn")).toBe(true);
    });
});

describe("buildLayerNodes", () => {
    it("devuelve lista vacía para capas sin snapshot", () => {
        expect(buildLayerNodes("heat", null)).toEqual([]);
        expect(buildLayerNodes("cyber", null)).toEqual([]);
        expect(buildLayerNodes("stale", {})).toEqual([]);
        expect(buildLayerNodes("session_diff", {})).toEqual([]);
    });

    it("colorea Cyber desde las listas por nodo opcionales", () => {
        const data: any = {
            cibernetica: {
                review_on_vencidos_nodes: ["Notes/vencido"],
                outcome_success_nodes: ["Notes/ok"],
                outcome_pending_nodes: ["Notes/pend"],
                outcome_failure_nodes: ["Notes/fallo"],
            },
        };
        const nodes = buildLayerNodes("cyber", data);
        expect(nodes).toContainEqual({ slug: "Notes/vencido", color: "#FF4136" });
        expect(nodes).toContainEqual({ slug: "Notes/ok", color: "#2ECC40" });
        expect(nodes).toContainEqual({ slug: "Notes/pend", color: "#FFDC00" });
        expect(nodes).toContainEqual({ slug: "Notes/fallo", color: "#FF4136" });
    });

    it("gradúa Stale de naranja (14d) a gris (45d+)", () => {
        const data: any = {
            calor_estructural: {
                top_neglected: [
                    { slug: "Notes/fresco", days_since_last_visit: 14 },
                    { slug: "Notes/muerto", days_since_last_visit: 45 },
                ],
            },
        };
        const nodes = buildLayerNodes("stale", data);
        expect(nodes).toContainEqual({ slug: "Notes/fresco", color: "#FF851B" });
        expect(nodes).toContainEqual({ slug: "Notes/muerto", color: "#7F7F7F" });
    });
});
