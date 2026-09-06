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

function makeView(vaultPath: string, onLayerApply = vi.fn()) {
    const root = makeRoot();
    const view = new DashboardView({ containerEl: root } as any, vaultPath, onLayerApply);
    return { root, view, onLayerApply };
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
