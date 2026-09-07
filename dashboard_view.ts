// dashboard_view.ts — Panel "Dashboard OKF" (Fase 2: tarjetas KPI + Fase 3: capas
// + Fase 4: pestaña Conceptos — tabla clicable con estados)
// Lee dashboard.json de la raíz del vault (generado por el CLI del ecosistema)
// y los últimos 30 snapshots diarios de sistema/dashboard-snapshots/ para los
// sparklines. No llama a ningún MCP/CLI: solo lee archivos del vault.
// Las capas (Heat/Cyber/Stale/Session Diff) son vistas del grafo: el panel
// convierte el snapshot en slug→color y se lo entrega a GraphAnimator.applyLayer.
import * as fs from "fs";
import * as path from "path";
import { ItemView, WorkspaceLeaf } from "obsidian";

export const DASHBOARD_VIEW_TYPE = "cognitive-trace-dashboard";

export type DashboardLayer = "live" | "heat" | "cyber" | "stale" | "session_diff";
export type DashboardTab = "resumen" | "conceptos";

export interface LayerNodeColor {
    slug: string;
    color: string;
}

// Colores de capa (plan Fase 3)
export const LAYER_COLORS = {
    heatRead: "#FF4136",      // 🔥 leído
    heatTraversed: "#FFDC00", // 🟡 atravesado, nunca leído
    heatCold: "#4FC3F7",      // ❄️ no visitado 14d+
    heatStale: "#7F7F7F",     // 💀 STALE
    cyberSuccess: "#2ECC40",  // 🟢 outcome success
    cyberPending: "#FFDC00",  // 🟡 outcome pending
    cyberExpired: "#FF4136",  // 🔴 review_on vencido
    cyberFailure: "#FF4136",  // 🔴 outcome failure
    staleFresh: "#FF851B",    // naranja (recientemente descuidado)
    staleDead: "#7F7F7F",     // gris (máximo stale)
    diffA: "#4FC3F7",         // solo en sesión A
    diffB: "#FF851B",         // solo en sesión B
    diffBoth: "#9E9E9E",      // en ambas sesiones
} as const;

interface TopVisitedEntry {
    slug?: string;
    traverses?: number;
    reads?: number;
    read_ratio?: number;
}

interface TopNeglectedEntry {
    slug?: string;
    days_since_last_visit?: number;
    stale_score?: number;
}

/** Un nodo de la sección conceptos[] del snapshot (generada por el CLI).
 *  Lectura tolerante: cualquier campo puede faltar o ser null. */
export interface ConceptoEntry {
    file?: string;
    type?: string;
    title?: string;
    status?: string;
    timestamp?: string;
    stale?: {
        level?: string; // "FRESCO" | "ATENCION" | "STALE"
        signal_count?: number;
        signals?: string[];
    };
    cyber?: {
        outcome?: string; // "pending" | "success" | "failure" | "deprecated" | ...
        review_on?: string | null;
        vencido?: boolean;
        target_metric?: string | null;
    } | null;
}

/** Snapshot del CLI (Fase 1 del plan). Lectura tolerante: cualquier campo
 *  puede faltar — se muestra "—" y las capas quedan vacías, nunca un crash. */
export interface DashboardSnapshot {
    generated_at?: string;
    generated_by?: string;
    source?: string;
    health?: {
        score?: number;
        max_score?: number;
        errors?: number;
        warnings?: number;
        warnings_detail?: string[];
        trend_7d?: string | null;
    };
    graph?: {
        total_nodes?: number;
        total_edges?: number;
        orphans?: number;
        hubs_top5?: string[];
        density?: number;
        trend_7d?: string | null;
    };
    cibernetica?: {
        total_blocks?: number;
        loops_cerrados?: number;
        loops_abiertos?: number;
        review_on_vencidos?: number;
        review_on_proximos_7d?: number;
        outcome_pending?: number;
        outcome_success?: number;
        outcome_failure?: number;
        trend_7d?: string | null;
        // Listas por nodo (opcionales — si el CLI las agrega, la capa Cyber las usa)
        review_on_vencidos_nodes?: string[];
        outcome_success_nodes?: string[];
        outcome_pending_nodes?: string[];
        outcome_failure_nodes?: string[];
    };
    actividad?: {
        sesiones_7d?: number;
        eventos_7d?: number;
        eventos_24h?: number;
        tools_usadas?: Record<string, number>;
        read_ratio_promedio?: number;
        infracciones_mcp_7d?: number;
        entry_points_top3?: string[];
        trend_7d?: string | null;
    };
    calor_estructural?: {
        top_visited?: TopVisitedEntry[];
        top_neglected?: TopNeglectedEntry[];
        stale_distribution?: Record<string, number>;
    };
    conceptos?: ConceptoEntry[]; // Fase 4: detalle por nodo (tabla de Conceptos)
    negocio?: unknown; // null en Fase 2 — placeholder
    // Diff de sesiones (opcional — requiere 2 session_ids). El CLI lo genera:
    // default = 2 sesiones de agente más recientes, o flags --session-a/-b.
    // session_a/session_b son metadata para mostrar qué se comparó.
    session_diff?: {
        session_a?: { id?: string; nodos?: number };
        session_b?: { id?: string; nodos?: number };
        solo_a?: string[];
        solo_b?: string[];
        ambas?: string[];
    };
}

const LAYER_DEFS: Array<{ key: DashboardLayer; label: string }> = [
    { key: "live", label: "Live" },
    { key: "heat", label: "Heat" },
    { key: "cyber", label: "Cyber" },
    { key: "stale", label: "Stale" },
    { key: "session_diff", label: "Session Diff" },
];

const TAB_DEFS: Array<{ key: DashboardTab; label: string }> = [
    { key: "resumen", label: "Resumen" },
    { key: "conceptos", label: "Conceptos" },
];

type ConceptStateFilter = "todos" | "atencion" | "cyber" | "stale" | "fresco";

const STATE_FILTER_DEFS: Array<{ value: ConceptStateFilter; label: string }> = [
    { value: "todos", label: "Todos" },
    { value: "atencion", label: "Solo atención" },
    { value: "cyber", label: "Con cyber" },
    { value: "stale", label: "Solo stale" },
    { value: "fresco", label: "Solo fresco" },
];

/** Chips de resumen sobre la tabla de Conceptos: conteos por nivel de stale y
 *  por bloque cyber, calculados sobre conceptos[] completo (no sobre lo
 *  filtrado) — los mismos conteos que usa la barra apilada del Resumen. */
const CONCEPT_CHIP_DEFS: Array<{
    value: ConceptStateFilter;
    label: string;
    count: (e: ConceptoEntry) => boolean;
    cls: string;
}> = [
    { value: "fresco", label: "FRESCO", count: (e) => e.stale?.level === "FRESCO", cls: "dashboard-chip-fresco" },
    { value: "atencion", label: "ATENCION", count: (e) => e.stale?.level === "ATENCION", cls: "dashboard-chip-atencion" },
    { value: "stale", label: "STALE", count: (e) => e.stale?.level === "STALE", cls: "dashboard-chip-stale" },
    { value: "cyber", label: "Con cyber", count: (e) => e.cyber != null, cls: "dashboard-chip-cyber" },
];

type ConceptDateFilter = "todos" | "hoy" | "7d" | "30d";

const DATE_FILTER_DEFS: Array<{ value: ConceptDateFilter; label: string }> = [
    { value: "todos", label: "Cualquier fecha" },
    { value: "hoy", label: "Hoy" },
    { value: "7d", label: "Últimos 7 días" },
    { value: "30d", label: "Últimos 30 días" },
];

type ConceptSortKey = "name" | "type" | "status" | "updated";
interface ConceptSortState { key: ConceptSortKey; dir: "asc" | "desc"; }

/** Columnas de la tabla: las que tienen key son ordenables (header clickeable). */
const CONCEPT_HEADER_DEFS: Array<{ key: ConceptSortKey | null; label: string }> = [
    { key: "name", label: "Concepto" },
    { key: "type", label: "Tipo" },
    { key: "status", label: "Status" },
    { key: "updated", label: "Actualizado" },
    { key: null, label: "Cyber" },
    { key: null, label: "Stale" },
];

const CONCEPT_PAGE_SIZE = 50;

const LAYER_LEGENDS: Record<DashboardLayer, Array<[string, string]>> = {
    live: [["traza en vivo", "#FFD700"]],
    heat: [
        ["leído", LAYER_COLORS.heatRead],
        ["atravesado", LAYER_COLORS.heatTraversed],
        ["no visitado 14d+", LAYER_COLORS.heatCold],
        ["stale", LAYER_COLORS.heatStale],
    ],
    cyber: [
        ["success", LAYER_COLORS.cyberSuccess],
        ["pending", LAYER_COLORS.cyberPending],
        ["vencido/fallido", LAYER_COLORS.cyberExpired],
        ["sin bloque", "#9E9E9E"],
    ],
    stale: [
        ["fresco", LAYER_COLORS.staleFresh],
        ["máx. stale", LAYER_COLORS.staleDead],
    ],
    session_diff: [
        ["solo A", LAYER_COLORS.diffA],
        ["solo B", LAYER_COLORS.diffB],
        ["ambas", LAYER_COLORS.diffBoth],
    ],
};

/** Interpola naranja (#FF851B) → gris (#7F7F7F) según stale_score 0-7 (si el
 *  snapshot lo trae) o días sin visita (14d = naranja, 45d+ = gris). */
function staleGradient(n: TopNeglectedEntry): string {
    let t: number;
    if (n.stale_score != null) {
        t = Math.max(0, Math.min(1, n.stale_score / 7));
    } else {
        const days = n.days_since_last_visit ?? 0;
        t = Math.max(0, Math.min(1, (days - 14) / 31));
    }
    return lerpColor(0xff851b, 0x7f7f7f, t);
}

function lerpColor(from: number, to: number, t: number): string {
    const ch = (shift: number): number => {
        const f = (from >> shift) & 0xff;
        const tt = (to >> shift) & 0xff;
        return Math.round(f + (tt - f) * t);
    };
    const rgb = (ch(16) << 16) | (ch(8) << 8) | ch(0);
    return "#" + rgb.toString(16).padStart(6, "0").toUpperCase();
}

function buildHeatNodes(data: DashboardSnapshot): LayerNodeColor[] {
    const nodes: LayerNodeColor[] = [];
    for (const n of data.calor_estructural?.top_visited ?? []) {
        if (!n.slug) continue;
        const reads = n.reads ?? 0;
        const ratio = n.read_ratio ?? (n.traverses ? reads / n.traverses : 0);
        nodes.push({
            slug: n.slug,
            color: reads > 0 || ratio > 0 ? LAYER_COLORS.heatRead : LAYER_COLORS.heatTraversed,
        });
    }
    for (const n of data.calor_estructural?.top_neglected ?? []) {
        if (!n.slug) continue;
        if (n.stale_score != null && n.stale_score >= 5) {
            nodes.push({ slug: n.slug, color: LAYER_COLORS.heatStale });
            continue;
        }
        const days = n.days_since_last_visit ?? 0;
        nodes.push({ slug: n.slug, color: days >= 14 ? LAYER_COLORS.heatCold : LAYER_COLORS.heatStale });
    }
    return nodes;
}

function buildCyberNodes(data: DashboardSnapshot): LayerNodeColor[] {
    const nodes: LayerNodeColor[] = [];
    const c = data.cibernetica;
    if (!c) return nodes;
    // Listas por nodo: opcionales en el schema — si el CLI las produce, la capa
    // las colorea; si no, la capa queda vacía (los contadores viven en la tarjeta).
    for (const slug of c.review_on_vencidos_nodes ?? []) nodes.push({ slug, color: LAYER_COLORS.cyberExpired });
    for (const slug of c.outcome_success_nodes ?? []) nodes.push({ slug, color: LAYER_COLORS.cyberSuccess });
    for (const slug of c.outcome_pending_nodes ?? []) nodes.push({ slug, color: LAYER_COLORS.cyberPending });
    for (const slug of c.outcome_failure_nodes ?? []) nodes.push({ slug, color: LAYER_COLORS.cyberFailure });
    return nodes;
}

function buildStaleNodes(data: DashboardSnapshot): LayerNodeColor[] {
    const nodes: LayerNodeColor[] = [];
    for (const n of data.calor_estructural?.top_neglected ?? []) {
        if (!n.slug) continue;
        nodes.push({ slug: n.slug, color: staleGradient(n) });
    }
    return nodes;
}

function buildSessionDiffNodes(data: DashboardSnapshot): LayerNodeColor[] {
    const sd = data.session_diff;
    if (!sd) return [];
    const nodes: LayerNodeColor[] = [];
    for (const slug of sd.solo_a ?? []) nodes.push({ slug, color: LAYER_COLORS.diffA });
    for (const slug of sd.solo_b ?? []) nodes.push({ slug, color: LAYER_COLORS.diffB });
    for (const slug of sd.ambas ?? []) nodes.push({ slug, color: LAYER_COLORS.diffBoth });
    return nodes;
}

/** Convierte el snapshot en colores por nodo para una capa. Tolerante:
 *  cualquier campo ausente produce una lista vacía, nunca un error. */
export function buildLayerNodes(layer: DashboardLayer, data: DashboardSnapshot | null): LayerNodeColor[] {
    if (!data) return [];
    switch (layer) {
        case "heat": return buildHeatNodes(data);
        case "cyber": return buildCyberNodes(data);
        case "stale": return buildStaleNodes(data);
        case "session_diff": return buildSessionDiffNodes(data);
        default: return [];
    }
}

interface CardOpts {
    title: string;
    icon: string;
    kpi: string;
    trend?: string | null;
    spark: Array<number | null> | null;
    sparkColor: string;
    details: Array<{ label: string; value: string }>;
    /** Umbral de salud del KPI: colorea el valor (F4). Ausente = color neutro. */
    valueClass?: "ok" | "warn" | "bad";
    /** Preset de filtro de estado al clickear la tarjeta (F1). Ausente = la
     *  tarjeta no navega (placeholder Negocio). */
    preset?: ConceptStateFilter;
}

export class DashboardView extends ItemView {
    private vaultPath: string;
    private onLayerApply: (layer: DashboardLayer, nodes: LayerNodeColor[]) => void;
    private data: DashboardSnapshot | null = null;
    private loadError = false;
    private activeLayer: DashboardLayer = "live";
    // Pestaña activa: estado de instancia (no settings). Un panel recién abierto
    // arranca en Resumen — el KPI es la vista principal y evita sorpresas de
    // estado heredado de una sesión anterior del panel.
    private activeTab: DashboardTab = "resumen";
    // Estado de la tabla de Conceptos
    private conceptSearch = "";
    private conceptTypeFilter = "todos";
    private conceptStateFilter: ConceptStateFilter = "todos";
    private conceptDateFilter: ConceptDateFilter = "todos";
    private conceptSort: ConceptSortState | null = null;
    private conceptPage = 0;
    // Preset de filtro pendiente (F1): lo setea el click en una tarjeta KPI y
    // se consume al renderizar la pestaña Conceptos (queda en conceptStateFilter).
    private conceptPreset: ConceptStateFilter | null = null;
    // Referencia al select de estado del toolbar para sincronizarlo con los chips.
    private conceptStateSelect: HTMLSelectElement | null = null;
    // Series diarias para sparklines: una por tarjeta, punto por snapshot
    private series: {
        health: Array<number | null>;
        cyber: Array<number | null>;
        actividad: Array<number | null>;
    } = { health: [], cyber: [], actividad: [] };

    constructor(
        leaf: WorkspaceLeaf,
        vaultPath: string,
        onLayerApply: (layer: DashboardLayer, nodes: LayerNodeColor[]) => void,
    ) {
        super(leaf);
        this.vaultPath = vaultPath;
        this.onLayerApply = onLayerApply;
    }

    getViewType(): string { return DASHBOARD_VIEW_TYPE; }
    getDisplayText(): string { return "Dashboard OKF"; }
    getIcon(): string { return "gauge"; }

    async onOpen(): Promise<void> {
        this.reload();
        this.render();
    }

    /** Re-leer dashboard.json + snapshots diarios desde el vault. */
    private reload(): void {
        this.loadError = false;
        const file = path.join(this.vaultPath, "dashboard.json");
        try {
            if (!fs.existsSync(file)) {
                this.data = null;
                return;
            }
            const raw = fs.readFileSync(file, "utf-8");
            this.data = JSON.parse(raw) as DashboardSnapshot;
        } catch (e) {
            console.warn("[CognitiveTrace] dashboard.json ilegible:", e);
            this.data = null;
            this.loadError = true;
        }
        this.loadSeries();
        // Re-aplicar la capa activa con los datos frescos
        this.applyActiveLayer();
    }

    private loadSeries(): void {
        this.series = { health: [], cyber: [], actividad: [] };
        const dir = path.join(this.vaultPath, "sistema", "dashboard-snapshots");
        let files: string[] = [];
        try {
            // YYYY-MM-DD.json ordena cronológicamente como string
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
        } catch (_) { /* sin directorio de snapshots */ }
        const push = (arr: Array<number | null>, v: unknown): void => {
            arr.push(typeof v === "number" ? v : null);
        };
        for (const file of files.slice(-30)) {
            try {
                const raw = fs.readFileSync(path.join(dir, file), "utf-8");
                const snap = JSON.parse(raw) as DashboardSnapshot;
                push(this.series.health, snap.health?.score);
                push(this.series.cyber, snap.cibernetica?.loops_abiertos);
                push(this.series.actividad, snap.actividad?.eventos_24h);
            } catch (_) {
                this.series.health.push(null);
                this.series.cyber.push(null);
                this.series.actividad.push(null);
            }
        }
    }

    private applyActiveLayer(): void {
        this.onLayerApply(this.activeLayer, buildLayerNodes(this.activeLayer, this.data));
    }

    private selectLayer(layer: DashboardLayer): void {
        this.activeLayer = layer;
        this.applyActiveLayer();
        this.render();
    }

    private layerDisabled(layer: DashboardLayer): boolean {
        if (layer === "live") return false;
        if (!this.data) return true;
        if (layer === "session_diff") return !this.data.session_diff;
        return false;
    }

    private layerTooltip(layer: DashboardLayer): string {
        if (layer === "session_diff" && !this.data?.session_diff) return "requiere 2 sesiones";
        if (!this.data) return "requiere snapshot del vault";
        return "";
    }

    private render(): void {
        const container = this.containerEl.children[1] as HTMLElement;
        if (!container) { requestAnimationFrame(() => this.render()); return; }
        container.empty();
        container.addClass("cognitive-trace-dashboard");

        // ── Header ──
        const header = container.createEl("div", { cls: "dashboard-header" });
        const hLeft = header.createEl("div", { cls: "dashboard-header-left" });
        hLeft.createEl("span", { cls: "dashboard-header-title", text: "Dashboard OKF" });
        const status = header.createEl("span", {
            cls: "dashboard-status-label",
            text: this.data ? `actualizado ${this.relativeTime(this.data.generated_at)}` : "sin snapshot",
        });
        status.title = this.data?.generated_at ?? "";
        const refreshBtn = header.createEl("button", { cls: "dashboard-refresh-btn", text: "↻" });
        refreshBtn.title = "Re-leer dashboard.json";
        refreshBtn.setAttribute("aria-label", "Re-leer dashboard.json");
        refreshBtn.addEventListener("click", () => {
            this.reload();
            this.render();
        });

        // ── Pestañas (Fase 4): Resumen | Conceptos ──
        const tabs = container.createEl("div", { cls: "dashboard-tabs" });
        for (const def of TAB_DEFS) {
            const tab = tabs.createEl("button", {
                cls: "dashboard-tab-chip"
                    + (this.activeTab === def.key ? " dashboard-tab-active" : ""),
            });
            tab.setText(def.label);
            tab.addEventListener("click", () => {
                if (this.activeTab === def.key) return;
                this.activeTab = def.key;
                this.render();
            });
        }

        if (this.activeTab === "conceptos") {
            this.renderConceptosTab(container);
            return;
        }

        // ── Selector de capas sobre el grafo (Fase 3) ──
        const layersBar = container.createEl("div", { cls: "dashboard-layers" });
        for (const def of LAYER_DEFS) {
            const disabled = this.layerDisabled(def.key);
            const active = this.activeLayer === def.key;
            const btn = layersBar.createEl("button", {
                cls: "dashboard-layer-chip"
                    + (active ? " dashboard-layer-active" : "")
                    + (disabled ? " dashboard-layer-disabled" : ""),
            });
            btn.setText(def.label);
            const tooltip = this.layerTooltip(def.key);
            if (tooltip) { btn.title = tooltip; btn.setAttribute("aria-label", tooltip); }
            btn.addEventListener("click", () => {
                if (this.layerDisabled(def.key)) return;
                this.selectLayer(def.key);
            });
        }
        this.renderLegend(container, this.activeLayer);

        // ── Tarjetas ──
        if (!this.data) {
            const empty = container.createEl("div", { cls: "dashboard-empty" });
            empty.createEl("div", { text: "Snapshot no generado aún — se regenera en cada commit" });
            if (this.loadError) {
                empty.createEl("div", { cls: "dashboard-empty-detail", text: "dashboard.json existe pero no se pudo leer" });
            }
            return;
        }
        this.renderHealthBar(container);
        const grid = container.createEl("div", { cls: "dashboard-grid" });
        this.renderSaludCard(grid);
        this.renderCiberneticaCard(grid);
        this.renderActividadCard(grid);
        this.renderNegocioCard(grid);
    }

    private renderLegend(container: HTMLElement, layer: DashboardLayer): void {
        const entries = LAYER_LEGENDS[layer];
        if (!entries || entries.length === 0) return;
        const legend = container.createEl("div", { cls: "dashboard-legend" });
        // Session Diff: mostrar qué sesiones se comparan (metadata del CLI)
        if (layer === "session_diff" && this.data?.session_diff) {
            const sd = this.data.session_diff;
            const a = sd.session_a?.id ? this.shortenSessionId(sd.session_a.id) : "?";
            const b = sd.session_b?.id ? this.shortenSessionId(sd.session_b.id) : "?";
            const aN = sd.session_a?.nodos ?? 0;
            const bN = sd.session_b?.nodos ?? 0;
            const cmp = legend.createEl("span", { cls: "dashboard-legend-item dashboard-sessiondiff-cmp" });
            cmp.createEl("span", { text: `A: ${a} (${aN}) · B: ${b} (${bN})` });
        }
        for (const [label, color] of entries) {
            const item = legend.createEl("span", { cls: "dashboard-legend-item" });
            const dot = item.createEl("span", { cls: "dashboard-legend-dot" });
            dot.style.backgroundColor = color;
            item.createEl("span", { text: label });
        }
    }

    /** Trunca un session_id largo para la leyenda (mantiene el inicio). */
    private shortenSessionId(id: string): string {
        return id.length > 28 ? `${id.slice(0, 28)}…` : id;
    }

    /** Barra apilada de salud del vault (F3): segmentos FRESCO/ATENCION/STALE
     *  con ancho proporcional a los conteos de conceptos[]. Los porcentajes de
     *  cada segmento son sobre la suma de los tres niveles (coherentes con el
     *  ancho de la barra). Sin conceptos o sin niveles de stale no se muestra. */
    private renderHealthBar(container: HTMLElement): void {
        const conceptos = this.data?.conceptos ?? [];
        if (conceptos.length === 0) return;
        const levels = [
            { level: "FRESCO", cls: "dashboard-healthbar-fresco" },
            { level: "ATENCION", cls: "dashboard-healthbar-atencion" },
            { level: "STALE", cls: "dashboard-healthbar-stale" },
        ] as const;
        const counts: Record<string, number> = { FRESCO: 0, ATENCION: 0, STALE: 0 };
        for (const e of conceptos) {
            const lv = e.stale?.level;
            if (lv === "FRESCO" || lv === "ATENCION" || lv === "STALE") counts[lv]++;
        }
        const sum = counts.FRESCO + counts.ATENCION + counts.STALE;
        if (sum === 0) return;

        const bar = container.createEl("div", { cls: "dashboard-healthbar" });
        const track = bar.createEl("div", { cls: "dashboard-healthbar-track" });
        for (const { level, cls } of levels) {
            const seg = track.createEl("div", { cls: `dashboard-healthbar-seg ${cls}` });
            seg.style.flex = String(counts[level]);
            seg.title = `${level} ${counts[level]} (${Math.round((counts[level] / sum) * 100)}%)`;
        }
        bar.createEl("div", { cls: "dashboard-healthbar-label", text: `${conceptos.length} conceptos` });
    }

    /** F1: click en una tarjeta KPI → pestaña Conceptos con el filtro de estado
     *  coherente con la tarjeta. El preset se consume al renderizar la pestaña:
     *  queda como filtro normal de estado y el usuario puede cambiarlo. */
    private navigateToConceptos(preset: ConceptStateFilter): void {
        this.conceptPreset = preset;
        this.conceptPage = 0;
        this.activeTab = "conceptos";
        this.render();
    }

    // ── Pestaña Conceptos (Fase 4) ──

    /** Toolbar (buscador + filtros) fijo + contenido paginado. El toolbar no se
     *  re-renderiza al filtrar: solo se reconstruye el contenido, para no perder
     *  el foco del input de búsqueda mientras se escribe. */
    private renderConceptosTab(container: HTMLElement): void {
        // Consume el preset de una tarjeta KPI (F1): se aplica una sola vez y
        // persiste como filtro normal de estado (el flujo manual no cambia).
        if (this.conceptPreset != null) {
            this.conceptStateFilter = this.conceptPreset;
            this.conceptPreset = null;
        }
        const toolbar = container.createEl("div", { cls: "dashboard-concept-toolbar" });

        const search = toolbar.createEl("input", { cls: "dashboard-concept-search" }) as HTMLInputElement;
        search.setAttribute("type", "text");
        search.setAttribute("placeholder", "Buscar por título o archivo…");
        search.setAttribute("aria-label", "Buscar concepto");
        search.value = this.conceptSearch;

        // Filtro por tipo: "Todos" + los tipos presentes en el snapshot
        const types = this.conceptTypes();
        if (this.conceptTypeFilter !== "todos" && !types.includes(this.conceptTypeFilter)) {
            this.conceptTypeFilter = "todos"; // el tipo dejó de existir tras un refresh
        }
        const typeSelect = toolbar.createEl("select", { cls: "dashboard-concept-type-filter" }) as HTMLSelectElement;
        typeSelect.setAttribute("aria-label", "Filtrar por tipo");
        const typeAll = typeSelect.createEl("option", { text: "Todos" });
        typeAll.setAttribute("value", "todos");
        for (const t of types) {
            const opt = typeSelect.createEl("option", { text: t });
            opt.setAttribute("value", t);
        }
        typeSelect.value = this.conceptTypeFilter;

        const stateSelect = toolbar.createEl("select", { cls: "dashboard-concept-state-filter" }) as HTMLSelectElement;
        stateSelect.setAttribute("aria-label", "Filtrar por estado");
        for (const def of STATE_FILTER_DEFS) {
            const opt = stateSelect.createEl("option", { text: def.label });
            opt.setAttribute("value", def.value);
        }
        stateSelect.value = this.conceptStateFilter;
        this.conceptStateSelect = stateSelect;

        const dateSelect = toolbar.createEl("select", { cls: "dashboard-concept-date-filter" }) as HTMLSelectElement;
        dateSelect.setAttribute("aria-label", "Filtrar por fecha");
        for (const def of DATE_FILTER_DEFS) {
            const opt = dateSelect.createEl("option", { text: def.label });
            opt.setAttribute("value", def.value);
        }
        dateSelect.value = this.conceptDateFilter;

        const content = container.createEl("div", { cls: "dashboard-concept-content" });
        this.renderConceptosContent(content);

        search.addEventListener("input", (ev) => {
            this.conceptSearch = (ev.target as HTMLInputElement).value;
            this.conceptPage = 0;
            this.renderConceptosContent(content);
        });
        typeSelect.addEventListener("change", (ev) => {
            this.conceptTypeFilter = (ev.target as HTMLSelectElement).value;
            this.conceptPage = 0;
            this.renderConceptosContent(content);
        });
        stateSelect.addEventListener("change", (ev) => {
            this.conceptStateFilter = (ev.target as HTMLSelectElement).value as ConceptStateFilter;
            this.conceptPage = 0;
            this.renderConceptosContent(content);
        });
        dateSelect.addEventListener("change", (ev) => {
            this.conceptDateFilter = (ev.target as HTMLSelectElement).value as ConceptDateFilter;
            this.conceptPage = 0;
            this.renderConceptosContent(content);
        });
    }

    /** Chips de conteos por estado (F2). Click = atajo al filtro de estado,
     *  sincronizado con el select: el chip activo se marca y el select refleja
     *  el valor. Click en el chip ya activo vuelve a "todos". */
    private renderConceptChips(container: HTMLElement, conceptos: ConceptoEntry[]): void {
        const chips = container.createEl("div", { cls: "dashboard-concept-chips" });
        for (const def of CONCEPT_CHIP_DEFS) {
            const count = conceptos.filter(def.count).length;
            const active = this.conceptStateFilter === def.value;
            const chip = chips.createEl("button", {
                cls: "dashboard-concept-chip " + def.cls + (active ? " dashboard-chip-active" : ""),
            });
            chip.setText(def.label);
            chip.createEl("span", { cls: "dashboard-chip-count", text: String(count) });
            chip.setAttribute("aria-label", `${def.label} (${count})`);
            chip.addEventListener("click", () => {
                this.conceptStateFilter = active ? "todos" : def.value;
                this.conceptPage = 0;
                if (this.conceptStateSelect) this.conceptStateSelect.value = this.conceptStateFilter;
                this.renderConceptosContent(container);
            });
        }
    }

    /** Tabla paginada (o mensaje de snapshot viejo). Reconstruye el contenido
     *  desde el estado actual de filtros/búsqueda/página. */
    private renderConceptosContent(container: HTMLElement): void {
        container.empty();
        const conceptos = this.data?.conceptos ?? [];

        if (conceptos.length === 0) {
            const empty = container.createEl("div", { cls: "dashboard-empty" });
            empty.createEl("div", { text: "El snapshot no trae la sección conceptos — ejecutá el snapshot actualizado" });
            empty.createEl("div", { cls: "dashboard-empty-detail", text: "python3 -m cli dashboard-snapshot" });
            return;
        }

        // Chips de conteos por estado (F2): van dentro del contenido para que
        // el chip activo se re-renderice en cada cambio de filtro y quede
        // sincronizado con el select del toolbar.
        this.renderConceptChips(container, conceptos);

        // Filtros → orden (si hay uno activo) → paginación
        const filtered = this.filterConceptos(conceptos);
        const sorted = this.sortConceptos(filtered);
        const total = sorted.length;
        const totalPages = Math.max(1, Math.ceil(total / CONCEPT_PAGE_SIZE));
        const page = Math.min(this.conceptPage, totalPages - 1);

        if (total === 0) {
            const empty = container.createEl("div", { cls: "dashboard-empty" });
            empty.createEl("div", { text: "Ningún concepto coincide con los filtros" });
            return;
        }

        const start = page * CONCEPT_PAGE_SIZE;
        const slice = sorted.slice(start, start + CONCEPT_PAGE_SIZE);

        const wrap = container.createEl("div", { cls: "dashboard-concept-table-wrap" });
        const table = wrap.createEl("table", { cls: "dashboard-concept-table" });
        const thead = table.createEl("thead");
        const headRow = thead.createEl("tr", { cls: "dashboard-concept-head" });
        for (const col of CONCEPT_HEADER_DEFS) {
            const th = headRow.createEl("th");
            if (!col.key) { th.setText(col.label); continue; }
            th.addClass("dashboard-concept-sortable");
            const sort = this.conceptSort;
            const active = sort?.key === col.key;
            const btn = th.createEl("button", {
                cls: "dashboard-concept-sort-btn" + (active ? " dashboard-sort-active" : ""),
            });
            const arrow = active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕";
            btn.setText(`${col.label} ${arrow}`);
            btn.setAttribute("aria-label", `Ordenar por ${col.label}`);
            btn.addEventListener("click", () => {
                this.cycleSort(col.key!);
                this.conceptPage = 0;
                this.renderConceptosContent(container);
            });
        }
        const tbody = table.createEl("tbody");
        for (const entry of slice) {
            this.renderConceptRow(tbody, entry);
        }

        // Paginación
        const pager = container.createEl("div", { cls: "dashboard-pager" });
        const prev = pager.createEl("button", { cls: "dashboard-pager-btn", text: "‹" });
        prev.setAttribute("aria-label", "Página anterior");
        if (page === 0) prev.addClass("dashboard-pager-disabled");
        const next = pager.createEl("button", { cls: "dashboard-pager-btn", text: "›" });
        next.setAttribute("aria-label", "Página siguiente");
        if (page >= totalPages - 1) next.addClass("dashboard-pager-disabled");
        pager.createEl("span", {
            cls: "dashboard-pager-label",
            text: `${start + 1}–${Math.min(start + CONCEPT_PAGE_SIZE, total)} de ${total}`,
        });
        prev.addEventListener("click", () => {
            if (page > 0) { this.conceptPage = page - 1; this.renderConceptosContent(container); }
        });
        next.addEventListener("click", () => {
            if (page < totalPages - 1) { this.conceptPage = page + 1; this.renderConceptosContent(container); }
        });
    }

    private renderConceptRow(tbody: HTMLElement, entry: ConceptoEntry): void {
        const file = entry.file ?? "";
        const row = tbody.createEl("tr", { cls: "dashboard-concept-row" });
        if (file) row.setAttribute("data-file", file);

        // Concepto: title (o file) — clic abre la nota en Obsidian
        const name = row.createEl("td", { cls: "dashboard-concept-name" });
        name.setText(entry.title || file || "—");
        name.title = file ? `${file}.md — abrir nota` : "";
        row.addEventListener("click", () => {
            if (!file) return;
            this.app.workspace.openLinkText(file, "", false);
        });

        // Tipo: texto con color sutil por categoría
        const type = row.createEl("td", { cls: "dashboard-concept-type" });
        type.setText(entry.type || "—");
        if (entry.type) type.style.color = this.typeColor(entry.type);

        // Status del frontmatter
        const status = row.createEl("td", { cls: "dashboard-concept-status" });
        status.setText(entry.status || "—");

        // Actualizado: fecha local del último cambio (timestamp del frontmatter OKF)
        const updated = row.createEl("td", { cls: "dashboard-concept-updated" });
        updated.setText(this.formatTimestamp(entry.timestamp));

        // Cyber: ícono + color por estado, tooltip con detalle
        const cyber = this.cyberBadge(entry.cyber);
        const cyberTd = row.createEl("td", { cls: "dashboard-concept-cyber" });
        cyberTd.createEl("span", { cls: `dashboard-cyber-badge ${cyber.cls}`, text: cyber.glyph });
        if (cyber.title) cyberTd.title = cyber.title;

        // Stale: nivel coloreado, tooltip con la señal principal
        const stale = this.staleBadge(entry.stale);
        const staleTd = row.createEl("td", { cls: "dashboard-concept-stale" });
        staleTd.createEl("span", { cls: `dashboard-stale-badge ${stale.cls}`, text: stale.label });
        if (stale.title) staleTd.title = stale.title;
    }

    /** "Requiere atención": stale no FRESCO, review vencido, u outcome pending/failure. */
    private requiresAttention(entry: ConceptoEntry): boolean {
        const level = entry.stale?.level;
        if (level && level !== "FRESCO") return true;
        if (entry.cyber?.vencido) return true;
        const outcome = entry.cyber?.outcome;
        return outcome === "failure" || outcome === "pending";
    }

    private filterConceptos(list: ConceptoEntry[]): ConceptoEntry[] {
        const q = this.conceptSearch.trim().toLowerCase();
        return list.filter((e) => {
            if (q) {
                const hay = (e.title ?? "").toLowerCase().includes(q)
                    || (e.file ?? "").toLowerCase().includes(q);
                if (!hay) return false;
            }
            if (this.conceptTypeFilter !== "todos" && e.type !== this.conceptTypeFilter) return false;
            switch (this.conceptStateFilter) {
                case "cyber": if (!e.cyber) return false; break;
                case "stale": if (e.stale?.level !== "STALE") return false; break;
                case "fresco": if (e.stale?.level !== "FRESCO") return false; break;
                case "atencion": if (!this.requiresAttention(e)) return false; break;
            }
            if (this.conceptDateFilter !== "todos" && !this.matchesDateRange(e.timestamp)) return false;
            return true;
        });
    }

    /** Orden estable sobre la lista ya filtrada. Sin orden activo devuelve la
     *  lista tal cual (orden base del snapshot). */
    private sortConceptos(list: ConceptoEntry[]): ConceptoEntry[] {
        const sort = this.conceptSort;
        if (!sort) return list;
        const dir = sort.dir === "asc" ? 1 : -1;
        return [...list].sort((a, b) => this.compareConceptos(a, b, sort.key, dir));
    }

    private compareConceptos(a: ConceptoEntry, b: ConceptoEntry, key: ConceptSortKey, dir: 1 | -1): number {
        switch (key) {
            case "name": return dir * (a.title || a.file || "").localeCompare(b.title || b.file || "");
            case "type": return dir * (a.type || "").localeCompare(b.type || "");
            case "status": return dir * (a.status || "").localeCompare(b.status || "");
            case "updated": {
                // Sin fecha al final en ambas direcciones
                const ta = this.timestampMs(a.timestamp);
                const tb = this.timestampMs(b.timestamp);
                if (ta == null && tb == null) return 0;
                if (ta == null) return 1;
                if (tb == null) return -1;
                return dir * (ta - tb);
            }
        }
    }

    /** Ciclo del header: lo activa (fechas desc = lo más nuevo arriba, texto
     *  asc = alfabético), el segundo click invierte y el tercero vuelve al
     *  orden base del snapshot. */
    private cycleSort(key: ConceptSortKey): void {
        const firstDir: "asc" | "desc" = key === "updated" ? "desc" : "asc";
        if (!this.conceptSort || this.conceptSort.key !== key) {
            this.conceptSort = { key, dir: firstDir };
        } else if (this.conceptSort.dir === firstDir) {
            this.conceptSort = { key, dir: firstDir === "asc" ? "desc" : "asc" };
        } else {
            this.conceptSort = null;
        }
    }

    /** YYYY-MM-DD en hora local; "—" si falta o no parsea. */
    private formatTimestamp(iso: string | undefined): string {
        const t = this.timestampMs(iso);
        if (t == null) return "—";
        const d = new Date(t);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${d.getFullYear()}-${mm}-${dd}`;
    }

    private timestampMs(iso: string | undefined): number | null {
        if (!iso) return null;
        const t = Date.parse(iso);
        return isNaN(t) ? null : t;
    }

    /** timestamp >= medianoche local del inicio del rango; sin fecha nunca matchea. */
    private matchesDateRange(iso: string | undefined): boolean {
        const t = this.timestampMs(iso);
        if (t == null) return false;
        return t >= this.dateRangeStart();
    }

    private dateRangeStart(): number {
        switch (this.conceptDateFilter) {
            case "hoy": return this.startOfLocalDay(0);
            case "7d": return this.startOfLocalDay(6);
            case "30d": return this.startOfLocalDay(29);
            default: return 0; // "todos" — no se consulta
        }
    }

    /** Medianoche local de hace `daysAgo` días (0 = hoy). */
    private startOfLocalDay(daysAgo: number): number {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - daysAgo);
        return d.getTime();
    }

    private conceptTypes(): string[] {
        const seen = new Set<string>();
        for (const e of this.data?.conceptos ?? []) {
            if (e.type) seen.add(e.type);
        }
        return Array.from(seen).sort((a, b) => a.localeCompare(b));
    }

    /** Color sutil estable por tipo (hash → paleta apagada, legible en ambos themes). */
    private typeColor(type: string): string {
        const palette = ["#7C9CBF", "#9CB57C", "#BF9C7C", "#B57C9C", "#7CBFB5", "#B5A87C"];
        let hash = 0;
        for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0;
        return palette[hash % palette.length];
    }

    private cyberBadge(cyber: ConceptoEntry["cyber"]): { glyph: string; cls: string; title: string } {
        if (!cyber) return { glyph: "—", cls: "dashboard-cyber-none", title: "sin bloque cibernético" };
        const parts: string[] = [];
        if (cyber.outcome) parts.push(`outcome ${cyber.outcome}`);
        if (cyber.vencido) parts.push("vencido");
        if (cyber.review_on) parts.push(`review ${cyber.review_on}`);
        if (cyber.target_metric) parts.push(`métrica ${cyber.target_metric}`);
        const title = parts.join(" · ");
        // vencido tiene prioridad sobre el outcome
        if (cyber.vencido) return { glyph: "!", cls: "dashboard-cyber-expired", title };
        switch (cyber.outcome) {
            case "success": return { glyph: "✓", cls: "dashboard-cyber-success", title };
            case "pending": return { glyph: "⏳", cls: "dashboard-cyber-pending", title };
            case "failure": return { glyph: "✗", cls: "dashboard-cyber-failure", title };
            default: return { glyph: "·", cls: "dashboard-cyber-none", title: title || "bloque sin outcome" };
        }
    }

    private staleBadge(stale: ConceptoEntry["stale"]): { label: string; cls: string; title: string } {
        if (!stale?.level) return { label: "—", cls: "dashboard-stale-none", title: "" };
        let cls: string;
        switch (stale.level) {
            case "FRESCO": cls = "dashboard-stale-fresco"; break;
            case "ATENCION": cls = "dashboard-stale-atencion"; break;
            case "STALE": cls = "dashboard-stale-stale"; break;
            default: cls = "dashboard-stale-none";
        }
        return { label: stale.level, cls, title: stale.signals?.[0] ?? "" };
    }

    private renderCard(grid: HTMLElement, opts: CardOpts): void {
        const card = grid.createEl("div", { cls: "dashboard-card" });
        if (opts.preset != null) {
            card.addClass("dashboard-card-clickable");
            card.setAttribute("aria-label", "Ver en Conceptos");
            card.addEventListener("click", () => this.navigateToConceptos(opts.preset!));
        }

        const head = card.createEl("div", { cls: "dashboard-card-head" });
        head.createEl("span", { cls: "dashboard-card-icon", text: opts.icon });
        head.createEl("span", { cls: "dashboard-card-title", text: opts.title });
        const trend = this.trendArrow(opts.trend);
        const trendEl = head.createEl("span", { cls: `kpi-trend ${trend.cls}`, text: trend.glyph });
        trendEl.title = trend.glyph === "—" ? "tendencia 7d sin datos" : `tendencia 7d: ${opts.trend}`;
        // Affordance sutil de navegación (solo tarjetas navegables)
        if (opts.preset != null) {
            head.createEl("span", { cls: "dashboard-card-chevron", text: "›" });
        }

        card.createEl("div", {
            cls: "kpi-value" + (opts.valueClass ? ` kpi-value-${opts.valueClass}` : ""),
            text: opts.kpi,
        });

        if (opts.spark && opts.spark.length > 0) {
            const canvas = card.createEl("canvas", { cls: "kpi-sparkline" }) as HTMLCanvasElement;
            canvas.width = 200;
            canvas.height = 40;
            this.drawSparkline(canvas, opts.spark, opts.sparkColor);
        }

        const details = card.createEl("div", { cls: "kpi-details" });
        for (const d of opts.details) {
            const row = details.createEl("div", { cls: "kpi-detail-row" });
            row.createEl("span", { cls: "kpi-detail-label", text: d.label });
            row.createEl("span", { cls: "kpi-detail-value", text: d.value });
        }
    }

    private renderSaludCard(grid: HTMLElement): void {
        const h = this.data?.health;
        const g = this.data?.graph;
        this.renderCard(grid, {
            title: "Salud", icon: "💚",
            kpi: h?.score != null && h?.max_score != null ? `${h.score}/${h.max_score}` : "—",
            trend: h?.trend_7d,
            spark: this.series.health,
            sparkColor: this.cssColor("--color-green", "#2ECC40"),
            valueClass: this.saludClass(),
            preset: "atencion",
            details: [
                { label: "errores", value: this.fmt(h?.errors) },
                { label: "advertencias", value: this.fmt(h?.warnings) },
                { label: "grafo", value: g?.total_nodes != null ? `${g.total_nodes} nodos · ${this.fmt(g.orphans)} huérfanos` : "—" },
            ],
        });
    }

    private renderCiberneticaCard(grid: HTMLElement): void {
        const c = this.data?.cibernetica;
        this.renderCard(grid, {
            title: "Cibernética", icon: "♻️",
            kpi: this.fmt(c?.loops_abiertos),
            trend: c?.trend_7d,
            spark: this.series.cyber,
            sparkColor: this.cssColor("--color-cyan", "#00B8D9"),
            valueClass: this.cyberClass(),
            preset: "cyber",
            details: [
                { label: "review_on vencidos", value: this.fmt(c?.review_on_vencidos) },
                { label: "próximos 7d", value: this.fmt(c?.review_on_proximos_7d) },
                { label: "outcome", value: `${this.fmt(c?.outcome_pending)} pend · ${this.fmt(c?.outcome_success)} ✓ · ${this.fmt(c?.outcome_failure)} ✗` },
            ],
        });
    }

    private renderActividadCard(grid: HTMLElement): void {
        const a = this.data?.actividad;
        const tools = a?.tools_usadas ?? {};
        const top = Object.entries(tools)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 4)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ");
        this.renderCard(grid, {
            title: "Actividad (7d)", icon: "⚡",
            kpi: this.fmt(a?.eventos_7d),
            trend: a?.trend_7d,
            spark: this.series.actividad,
            sparkColor: this.cssColor("--color-yellow", "#FFDC00"),
            valueClass: this.actividadClass(),
            preset: "todos",
            details: [
                { label: "sesiones 7d", value: this.fmt(a?.sesiones_7d) },
                { label: "eventos 24h", value: this.fmt(a?.eventos_24h) },
                { label: "read ratio", value: a?.read_ratio_promedio != null ? `${Math.round(a.read_ratio_promedio * 100)}%` : "—" },
                { label: "tools top", value: top || "—" },
            ],
        });
    }

    private renderNegocioCard(grid: HTMLElement): void {
        this.renderCard(grid, {
            title: "Negocio", icon: "📈",
            kpi: "Fase 2",
            trend: undefined,
            spark: null,
            sparkColor: "",
            details: [
                { label: "estado", value: "Umami API · D1 — plan pendiente" },
            ],
        });
    }

    /** F4: umbral de Salud — score/max_score ≥ 80% ok, ≥ 55% warn, < 55% bad.
     *  Sin score o max_score no colorea (el valor muestra "—"). */
    private saludClass(): "ok" | "warn" | "bad" | undefined {
        const h = this.data?.health;
        if (h?.score == null || h?.max_score == null || h.max_score <= 0) return undefined;
        const ratio = h.score / h.max_score;
        if (ratio >= 0.8) return "ok";
        if (ratio >= 0.55) return "warn";
        return "bad";
    }

    /** F4: umbral de Cibernética — reviews vencidos es lo más grave (bad);
     *  loops abiertos sin vencer son trabajo en curso (warn); todo cerrado y
     *  sin vencidos es ok. Sin datos no colorea. */
    private cyberClass(): "ok" | "warn" | "bad" | undefined {
        const c = this.data?.cibernetica;
        if (!c || c.review_on_vencidos == null || c.loops_abiertos == null) return undefined;
        if (c.review_on_vencidos > 0) return "bad";
        if (c.loops_abiertos > 0) return "warn";
        return "ok";
    }

    /** F4: umbral de Actividad — 0 eventos en 7d es warn (vault inactivo);
     *  cualquier actividad es ok. No hay estado bad: la inactividad es un
     *  síntoma, no un daño. Sin dato no colorea. */
    private actividadClass(): "ok" | "warn" | "bad" | undefined {
        const a = this.data?.actividad;
        if (a?.eventos_7d == null) return undefined;
        return a.eventos_7d > 0 ? "ok" : "warn";
    }

    private trendArrow(trend: string | null | undefined): { glyph: string; cls: string } {
        if (trend === "up") return { glyph: "▲", cls: "kpi-trend-up" };
        if (trend === "down") return { glyph: "▼", cls: "kpi-trend-down" };
        if (trend === "flat") return { glyph: "→", cls: "kpi-trend-flat" };
        return { glyph: "—", cls: "kpi-trend-flat" };
    }

    private fmt(v: number | null | undefined): string {
        return v == null ? "—" : String(v);
    }

    private relativeTime(iso: string | undefined): string {
        if (!iso) return "—";
        const t = Date.parse(iso);
        if (isNaN(t)) return "—";
        const diff = Date.now() - t;
        if (diff < 0) return "ahora";
        const s = Math.floor(diff / 1000);
        if (s < 60) return `hace ${s}s`;
        const m = Math.floor(s / 60);
        if (m < 60) return `hace ${m} min`;
        const h = Math.floor(m / 60);
        if (h < 24) return `hace ${h}h`;
        return `hace ${Math.floor(h / 24)}d`;
    }

    /** Lee una variable CSS del theme; fallback si no hay DOM (tests). */
    private cssColor(varName: string, fallback: string): string {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
            return v || fallback;
        } catch (_) {
            return fallback;
        }
    }

    /** Sparkline de hasta 30 puntos (uno por snapshot diario). Los huecos
     *  (dato faltante) rompen la línea; sin contexto 2D (tests) no dibuja. */
    private drawSparkline(canvas: HTMLCanvasElement, series: Array<number | null>, color: string): void {
        if (!series || series.length === 0) return;
        const ctx = canvas.getContext?.("2d");
        if (!ctx) return;
        const w = canvas.width || 200;
        const h = canvas.height || 40;
        const pad = 3;
        const values = series.filter((v): v is number => v != null);
        if (values.length === 0) return;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;
        const yOf = (v: number): number => h - pad - ((v - min) / range) * (h - pad * 2);
        const stepX = series.length > 1 ? (w - pad * 2) / (series.length - 1) : 0;

        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        let drawing = false;
        for (let i = 0; i < series.length; i++) {
            const v = series[i];
            if (v == null) { drawing = false; continue; }
            const x = pad + i * stepX;
            const y = yOf(v);
            if (!drawing) { ctx.moveTo(x, y); drawing = true; }
            else { ctx.lineTo(x, y); }
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Punto sobre el último valor
        let lastIdx = -1;
        for (let i = series.length - 1; i >= 0; i--) {
            if (series[i] != null) { lastIdx = i; break; }
        }
        if (lastIdx >= 0) {
            ctx.beginPath();
            ctx.arc(pad + lastIdx * stepX, yOf(series[lastIdx] as number), 2, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
        }
    }
}
