/**
 * Yandex Fuel Prices Card — Lovelace card for the yandex_fuel_prices integration.
 * Plain web component, no build step.
 */
const CARD_VERSION = "0.1.0";
const DOMAIN = "yandex_fuel_prices";
const COLORS = ["#fc3f1d", "#2f80ed", "#27ae60", "#f2994a", "#9b51e0", "#00a3a3", "#eb5757", "#828282"];
const REFRESH_HISTORY_MS = 30 * 60 * 1000;

const I18N = {
  ru: {
    title: "Цены на топливо",
    cheapest: "дешевле всего",
    spread: "Разница",
    updated: "обновлено",
    no_entities: "Нет сенсоров Yandex Fuel Prices. Добавьте заправки в интеграции.",
    stale: "Не удалось обновить цену, показана последняя известная",
    open_map: "Открыть в Яндекс Картах",
    now: "сейчас",
    unavailable: "нет данных",
    loading: "Загрузка истории…",
    no_history: "История пока не накоплена",
    since: "с",
    ed_title: "Заголовок",
    ed_entities: "Сенсоры (пусто — все сенсоры интеграции)",
    ed_fuel: "Фильтр по топливу (например, Пропан)",
    ed_days: "Дней на графике",
    ed_show_chart: "Показывать график",
    ed_show_address: "Показывать адрес",
    ed_show_updated: "Показывать время обновления",
    ed_show_trend: "Показывать изменение цены",
    ed_sort: "Сортировать по цене",
  },
  en: {
    title: "Fuel prices",
    cheapest: "cheapest",
    spread: "Spread",
    updated: "updated",
    no_entities: "No Yandex Fuel Prices sensors found. Add stations in the integration.",
    stale: "Update failed, showing the last known price",
    open_map: "Open in Yandex Maps",
    now: "now",
    unavailable: "no data",
    loading: "Loading history…",
    no_history: "No history yet",
    since: "since",
    ed_title: "Title",
    ed_entities: "Sensors (empty — all integration sensors)",
    ed_fuel: "Fuel filter (e.g. Propane)",
    ed_days: "Days on chart",
    ed_show_chart: "Show chart",
    ed_show_address: "Show address",
    ed_show_updated: "Show update time",
    ed_show_trend: "Show price change",
    ed_sort: "Sort by price",
  },
};

const DEFAULTS = {
  days: 30,
  show_chart: true,
  show_address: true,
  show_updated: true,
  show_trend: true,
  sort: true,
};

const lang = (hass) => ((hass?.locale?.language || hass?.language || "ru").startsWith("ru") ? "ru" : "en");
const tr = (hass, key) => I18N[lang(hass)][key] ?? I18N.en[key] ?? key;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const normFuel = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const isNum = (v) => v !== null && v !== "" && !isNaN(Number(v));

function fmtNum(hass, v, digits = 2) {
  return new Intl.NumberFormat(hass?.locale?.language || "ru", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(v);
}

function fmtRelative(hass, date) {
  const rtf = new Intl.RelativeTimeFormat(hass?.locale?.language || "ru", { numeric: "auto" });
  const diff = (date.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return tr(hass, "now");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

function fmtDate(hass, ts) {
  return new Intl.DateTimeFormat(hass?.locale?.language || "ru", { day: "numeric", month: "short" }).format(new Date(ts));
}

/** All price sensors of the integration (price sensors carry the fuel_name attribute). */
function discoverEntities(hass) {
  return Object.keys(hass.states)
    .filter((eid) => eid.startsWith("sensor."))
    .filter((eid) => hass.states[eid].attributes.fuel_name !== undefined)
    .filter((eid) => {
      const reg = hass.entities?.[eid];
      return !reg || !reg.platform || reg.platform === DOMAIN;
    })
    .sort();
}

class YandexFuelPricesCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("yandex-fuel-prices-card-editor");
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    if (config.entities && !Array.isArray(config.entities)) throw new Error("entities must be a list");
    this._config = { ...DEFAULTS, ...config };
    this._history = null;
    this._historyKey = null;
    this._lastSig = null;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    }
    if (this._hass) this._update(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._update(false);
  }

  connectedCallback() {
    if (!this._ro && window.ResizeObserver) {
      this._ro = new ResizeObserver(() => {
        const w = Math.round(this.clientWidth);
        if (w && Math.abs(w - (this._width || 0)) > 4) {
          this._width = w;
          this._render();
        }
      });
    }
    this._ro?.observe(this);
  }

  disconnectedCallback() {
    this._ro?.disconnect();
  }

  getCardSize() {
    const n = this._entities().length || 1;
    return 1 + n + (this._config?.show_chart ? 3 : 0);
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, min_rows: 2 };
  }

  _entities() {
    if (!this._hass || !this._config) return [];
    let ids = this._config.entities?.length
      ? this._config.entities.map((e) => (typeof e === "string" ? e : e.entity)).filter(Boolean)
      : discoverEntities(this._hass);
    if (this._config.fuel) {
      const f = normFuel(this._config.fuel);
      ids = ids.filter((id) => normFuel(this._hass.states[id]?.attributes.fuel_name).includes(f));
    }
    return ids.filter((id) => this._hass.states[id]);
  }

  _update(force) {
    if (!this._config || !this._hass) return;
    const ids = this._entities();
    const sig = JSON.stringify(
      ids.map((id) => {
        const s = this._hass.states[id];
        return [id, s.state, s.attributes.price_updated, s.attributes.last_fetch_ok];
      })
    ) + lang(this._hass);
    const key = ids.join(",") + "|" + this._config.days;
    const historyStale =
      this._config.show_chart !== false || this._config.show_trend !== false
        ? key !== this._historyKey || Date.now() - (this._historyAt || 0) > REFRESH_HISTORY_MS || sig !== this._lastSig
        : false;
    if (historyStale && ids.length && !this._loading) this._loadHistory(ids, key);
    if (force || sig !== this._lastSig) {
      this._lastSig = sig;
      this._render();
    }
  }

  async _loadHistory(ids, key) {
    this._loading = true;
    const days = Math.max(1, Number(this._config.days) || DEFAULTS.days);
    const start = new Date(Date.now() - days * 86400000);
    const series = Object.fromEntries(ids.map((id) => [id, []]));
    const toMs = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v));
    try {
      // Long-term statistics (kept forever, hourly/daily means).
      const stats = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        statistic_ids: ids,
        period: days > 60 ? "day" : "hour",
        types: ["mean"],
      });
      for (const id of ids)
        for (const p of stats?.[id] || []) if (isNum(p.mean)) series[id].push([toMs(p.start), Number(p.mean)]);
    } catch (e) {
      /* statistics not available — fall back to history only */
    }
    try {
      // Raw state history (exact change moments for the recorder keep period).
      const hist = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      for (const id of ids) {
        const pts = (hist?.[id] || [])
          .map((p) => [toMs(p.lu ?? p.last_updated ?? p.last_changed), p.s ?? p.state])
          .filter(([t, v]) => isFinite(t) && isNum(v))
          .map(([t, v]) => [t, Number(v)]);
        if (pts.length) {
          const first = pts[0][0];
          series[id] = series[id].filter(([t]) => t < first).concat(pts);
        }
      }
    } catch (e) {
      /* ignore */
    }
    for (const id of ids) series[id].sort((a, b) => a[0] - b[0]);
    this._history = series;
    this._historyKey = key;
    this._historyAt = Date.now();
    this._historyStart = start.getTime();
    this._loading = false;
    this._render();
  }

  /** Last price change: {delta, at} comparing current value with the previous different one. */
  _trend(id, current) {
    const pts = this._history?.[id];
    if (!pts?.length || !isNum(current)) return null;
    const cur = Number(current);
    let changedAt = null;
    for (let i = pts.length - 1; i >= 0; i--) {
      const v = pts[i][1];
      if (Math.abs(v - cur) > 0.005) {
        return { delta: cur - v, at: changedAt ?? pts[Math.min(i + 1, pts.length - 1)][0] };
      }
      changedAt = pts[i][0];
    }
    return null;
  }

  _onClick(ev) {
    const link = ev.target.closest("a");
    if (link) return;
    const row = ev.target.closest("[data-entity]");
    if (!row) return;
    const e = new Event("hass-more-info", { bubbles: true, composed: true });
    e.detail = { entityId: row.dataset.entity };
    this.dispatchEvent(e);
  }

  _render() {
    if (!this.shadowRoot || !this._hass) return;
    const hass = this._hass;
    const cfg = this._config;
    const ids = this._entities();
    const colorOf = Object.fromEntries(ids.map((id, i) => [id, COLORS[i % COLORS.length]]));

    const rows = ids.map((id) => {
      const s = hass.states[id];
      const a = s.attributes;
      const price = isNum(s.state) ? Number(s.state) : null;
      return {
        id,
        price,
        name: a.station || a.friendly_name || id,
        fuel: a.fuel_name,
        address: a.address,
        unit: a.unit_of_measurement || "₽/л",
        updated: a.price_updated ? new Date(a.price_updated) : null,
        stale: a.last_fetch_ok === false,
        orgId: a.yandex_org_id,
        color: colorOf[id],
      };
    });

    // Cheapest per fuel (so mixed fuels are compared fairly).
    const minByFuel = {};
    for (const r of rows)
      if (r.price !== null) {
        const f = normFuel(r.fuel);
        minByFuel[f] = Math.min(minByFuel[f] ?? Infinity, r.price);
      }
    const fuels = Object.keys(minByFuel);
    const priced = rows.filter((r) => r.price !== null);
    if (cfg.sort !== false) rows.sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity));

    let spread = null;
    if (fuels.length === 1 && priced.length > 1) {
      const vals = priced.map((r) => r.price);
      spread = Math.max(...vals) - Math.min(...vals);
    }

    const title = cfg.title ?? (fuels.length === 1 && priced[0]?.fuel ? priced[0].fuel : tr(hass, "title"));

    const rowHtml = rows
      .map((r) => {
        const min = minByFuel[normFuel(r.fuel)];
        const cheapest = r.price !== null && priced.length > 1 && r.price === min;
        const diff = r.price !== null && !cheapest && priced.length > 1 ? r.price - min : null;
        const trend = cfg.show_trend !== false ? this._trend(r.id, r.price) : null;
        const sub = [];
        if (fuels.length > 1 && r.fuel) sub.push(esc(r.fuel));
        if (cfg.show_updated !== false && r.updated)
          sub.push(`<span title="${esc(r.updated.toLocaleString())}">${tr(hass, "updated")} ${esc(fmtRelative(hass, r.updated))}</span>`);
        if (cfg.show_address !== false && r.address) sub.push(`<span class="addr">${esc(r.address)}</span>`);
        return `
        <div class="row ${cheapest ? "cheapest" : ""} ${r.price === null ? "na" : ""}" data-entity="${esc(r.id)}" tabindex="0">
          <span class="dot" style="background:${r.color}"></span>
          <div class="info">
            <div class="name">
              <span class="name-text">${esc(r.name)}</span>
              ${cheapest ? `<span class="badge">${tr(hass, "cheapest")}</span>` : ""}
              ${r.stale ? `<span class="warn" title="${esc(tr(hass, "stale"))}">!</span>` : ""}
            </div>
            ${sub.length ? `<div class="sub">${sub.join('<span class="sep">·</span>')}</div>` : ""}
          </div>
          <div class="pricecol">
            <div class="price">${
              r.price !== null
                ? `${fmtNum(hass, r.price)}<span class="unit">${esc(r.unit)}</span>`
                : `<span class="unit">${tr(hass, "unavailable")}</span>`
            }</div>
            <div class="meta">
              ${diff !== null ? `<span class="diff">+${fmtNum(hass, diff)}</span>` : ""}
              ${
                trend
                  ? `<span class="trend ${trend.delta > 0 ? "up" : "down"}" title="${esc(tr(hass, "since"))} ${esc(
                      new Date(trend.at).toLocaleString()
                    )}">${trend.delta > 0 ? "▲" : "▼"} ${fmtNum(hass, Math.abs(trend.delta))} · ${esc(
                      fmtRelative(hass, new Date(trend.at))
                    )}</span>`
                  : ""
              }
            </div>
          </div>
          ${
            r.orgId
              ? `<a class="map" href="https://yandex.ru/maps/org/${encodeURIComponent(r.orgId)}/" target="_blank" rel="noopener noreferrer" title="${esc(
                  tr(hass, "open_map")
                )}"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7m0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5"/></svg></a>`
              : ""
          }
        </div>`;
      })
      .join("");

    const chart = cfg.show_chart !== false && ids.length ? this._chartHtml(ids, colorOf) : "";

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="header">
          <div class="title">${esc(title)}</div>
          ${
            spread !== null
              ? `<div class="spread">${tr(hass, "spread")} <b>${fmtNum(hass, spread)}</b> ${esc(priced[0].unit)}</div>`
              : ""
          }
        </div>
        ${ids.length ? `<div class="rows">${rowHtml}</div>` : `<div class="empty">${tr(hass, "no_entities")}</div>`}
        ${chart}
      </ha-card>`;
  }

  _chartHtml(ids, colorOf) {
    const hass = this._hass;
    if (!this._history) return `<div class="chart-msg">${tr(hass, "loading")}</div>`;
    const now = Date.now();
    const t0 = this._historyStart;
    const lines = ids
      .map((id) => {
        const raw = this._history[id] || [];
        // Keep the value in effect at the chart start: move the last earlier point to t0.
        const before = raw.filter(([t]) => t < t0).pop();
        const pts = (before ? [[t0, before[1]]] : []).concat(raw.filter(([t]) => t >= t0));
        const cur = hass.states[id]?.state;
        if (isNum(cur)) pts.push([now, Number(cur)]);
        return { id, pts };
      })
      .filter((l) => l.pts.length >= 2);
    if (!lines.length) return `<div class="chart-msg">${tr(hass, "no_history")}</div>`;

    // Draw in real pixels so text is not stretched.
    const W = Math.max(240, (this._width || this.clientWidth || 600) - 24), H = 150, L = 40, R = 8, T = 10, B = 22;
    const all = lines.flatMap((l) => l.pts.map((p) => p[1]));
    let lo = Math.min(...all), hi = Math.max(...all);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const tMin = t0;
    const x = (t) => L + ((Math.max(t, tMin) - tMin) / (now - tMin || 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    const paths = lines
      .map(({ id, pts }) => {
        let d = `M${x(pts[0][0]).toFixed(1)},${y(pts[0][1]).toFixed(1)}`;
        for (let i = 1; i < pts.length; i++) {
          d += `H${x(pts[i][0]).toFixed(1)}V${y(pts[i][1]).toFixed(1)}`;
        }
        const last = pts[pts.length - 1];
        return `<path d="${d}" fill="none" stroke="${colorOf[id]}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
                <circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.5" fill="${colorOf[id]}"/>`;
      })
      .join("");

    const ticks = [hi - pad, (hi + lo) / 2, lo + pad]
      .map(
        (v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>
                <text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="lbl">${fmtNum(hass, v, v % 1 ? 1 : 0)}</text>`
      )
      .join("");

    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
          ${ticks}
          ${paths}
          <text x="${L}" y="${H - 6}" class="lbl">${esc(fmtDate(hass, tMin))}</text>
          <text x="${W - R}" y="${H - 6}" text-anchor="end" class="lbl">${esc(tr(hass, "now"))}</text>
        </svg>
      </div>`;
  }
}

const STYLES = `
  :host { display: block; }
  ha-card { padding: 16px 0 12px; overflow: hidden; }
  .header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0 16px 8px; }
  .title { font-size: 1.25rem; font-weight: 500; color: var(--primary-text-color); }
  .spread { font-size: 0.9rem; color: var(--secondary-text-color); white-space: nowrap; }
  .spread b { color: var(--primary-text-color); font-weight: 600; }
  .rows { display: flex; flex-direction: column; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; cursor: pointer; position: relative; }
  .row:hover { background: var(--secondary-background-color, rgba(127,127,127,.08)); }
  .row:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .row.cheapest::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--success-color, #43a047); }
  .row.na { opacity: .6; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .info { flex: 1; min-width: 0; }
  .name { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name-text { font-weight: 500; color: var(--primary-text-color); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { flex: none; font-size: .7rem; font-weight: 600; letter-spacing: .02em; padding: 2px 8px; border-radius: 10px;
    color: var(--success-color, #43a047); background: color-mix(in srgb, var(--success-color, #43a047) 15%, transparent); }
  .warn { flex: none; width: 16px; height: 16px; border-radius: 50%; display: inline-grid; place-items: center;
    font-size: .7rem; font-weight: 700; color: #fff; background: var(--warning-color, #ffa600); }
  .sub { font-size: .8rem; color: var(--secondary-text-color); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sep { margin: 0 6px; opacity: .6; }
  .pricecol { text-align: right; flex: none; }
  .price { font-size: 1.35rem; font-weight: 600; color: var(--primary-text-color); font-variant-numeric: tabular-nums; line-height: 1.2; }
  .unit { font-size: .75rem; font-weight: 400; color: var(--secondary-text-color); margin-left: 3px; }
  .meta { display: flex; gap: 8px; justify-content: flex-end; font-size: .75rem; font-variant-numeric: tabular-nums; min-height: 1em; }
  .diff { color: var(--secondary-text-color); }
  .trend.up { color: var(--error-color, #db4437); }
  .trend.down { color: var(--success-color, #43a047); }
  .map { flex: none; color: var(--secondary-text-color); display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; }
  .map:hover { color: var(--primary-color); background: var(--secondary-background-color, rgba(127,127,127,.12)); }
  .empty, .chart-msg { padding: 8px 16px; color: var(--secondary-text-color); font-size: .9rem; }
  .chart { padding: 8px 12px 0; }
  .chart svg { width: 100%; height: auto; display: block; overflow: visible; }
  .chart .grid { stroke: var(--divider-color, rgba(127,127,127,.25)); stroke-width: 1; stroke-dasharray: 3 4; vector-effect: non-scaling-stroke; }
  .chart path { vector-effect: non-scaling-stroke; }
  .chart .lbl { fill: var(--secondary-text-color); font-size: 11px; }
  @media (max-width: 420px) { .addr { display: none; } }
`;

class YandexFuelPricesCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    else this._render();
  }

  _schema() {
    return [
      { name: "title", selector: { text: {} } },
      {
        name: "entities",
        selector: { entity: { multiple: true, filter: { integration: DOMAIN, domain: "sensor" } } },
      },
      { name: "fuel", selector: { text: {} } },
      { name: "days", selector: { number: { min: 1, max: 365, mode: "box" } } },
      {
        type: "grid",
        name: "",
        schema: [
          { name: "show_chart", selector: { boolean: {} } },
          { name: "show_trend", selector: { boolean: {} } },
          { name: "show_address", selector: { boolean: {} } },
          { name: "show_updated", selector: { boolean: {} } },
          { name: "sort", selector: { boolean: {} } },
        ],
      },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => tr(this._hass, "ed_" + s.name);
      this._form.addEventListener("value-changed", (ev) => {
        const config = { ...ev.detail.value };
        for (const k of Object.keys(config)) {
          if (config[k] === "" || (Array.isArray(config[k]) && !config[k].length)) delete config[k];
          else if (k in DEFAULTS && config[k] === DEFAULTS[k]) delete config[k];
        }
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = this._schema();
    this._form.data = { ...DEFAULTS, ...this._config };
  }
}

customElements.define("yandex-fuel-prices-card", YandexFuelPricesCard);
customElements.define("yandex-fuel-prices-card-editor", YandexFuelPricesCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "yandex-fuel-prices-card",
  name: "Yandex Fuel Prices Card",
  description: "Цены на топливо с Яндекс Карт: самая дешёвая заправка, разница, тренд и график",
  preview: true,
  documentationURL: "https://github.com/dobriys/yandex-fuel-prices-card",
});

console.info(
  `%c YANDEX-FUEL-PRICES-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#fc3f1d;font-weight:700",
  "color:#fc3f1d;background:#fff"
);
