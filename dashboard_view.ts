// dashboard_view.ts — Panel "Dashboard OKF" (Fase 2: tarjetas KPI + Fase 3: capas)
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
    negocio?: unknown; // null en Fase 2 — placeholder
    // Diff de sesiones (opcional — requiere 2 session_ids)
    session_diff?: { solo_a?: string[]; solo_b?: string[]; ambas?: string[] };
}

const LAYER_DEFS: Array<{ key: DashboardLayer; label: string }> = [
    { key: "live", label: "Live" },
    { key: "heat", label: "Heat" },
    { key: "cyber", label: "Cyber" },
    { key: "stale", label: "Stale" },
    { key: "session_diff", label: "Session Diff" },
];

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
}

export class DashboardView extends ItemView {
    private vaultPath: string;
    private onLayerApply: (layer: DashboardLayer, nodes: LayerNodeColor[]) => void;
    private data: DashboardSnapshot | null = null;
    private loadError = false;
    private activeLayer: DashboardLayer = "live";
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
        for (const [label, color] of entries) {
            const item = legend.createEl("span", { cls: "dashboard-legend-item" });
            const dot = item.createEl("span", { cls: "dashboard-legend-dot" });
            dot.style.backgroundColor = color;
            item.createEl("span", { text: label });
        }
    }

    private renderCard(grid: HTMLElement, opts: CardOpts): void {
        const card = grid.createEl("div", { cls: "dashboard-card" });

        const head = card.createEl("div", { cls: "dashboard-card-head" });
        head.createEl("span", { cls: "dashboard-card-icon", text: opts.icon });
        head.createEl("span", { cls: "dashboard-card-title", text: opts.title });
        const trend = this.trendArrow(opts.trend);
        const trendEl = head.createEl("span", { cls: `kpi-trend ${trend.cls}`, text: trend.glyph });
        trendEl.title = trend.glyph === "—" ? "tendencia 7d sin datos" : `tendencia 7d: ${opts.trend}`;

        card.createEl("div", { cls: "kpi-value", text: opts.kpi });

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
