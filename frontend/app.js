/* SouqPulse dashboard. Called as SouqPulse.init(DATA) once the data (fetched from ./data/*.json, or embedded
   inline in the standalone build) is ready. No external libraries: every chart is drawn as SVG here. */

const SouqPulse = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(n);
  const aed = (n) => `AED ${num(n)}`;
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const signed = (x) => (Math.abs(x) < 0.005 ? "0%" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(0)}%`);
  const FEATURES = { size_sqft: "Size", area: "Area", distance_to_downtown_km: "Distance to Downtown", building_age_years: "Building age",
    bedrooms: "Bedrooms", property_type: "Property type", furnished: "Furnishing", floor: "Floor", price_per_sqft: "Price per sqft" };
  let D, checker;

  // ------------------------------------------------------------------ checker (hero)
  // Fair value comes from the model's precomputed grid (area x type x size x furnishing), interpolated by size.
  function fairValue(area, type, size, furnished) {
    const rows = D.fair_value_grid.filter((r) => r.area === area && r.property_type === type && r.furnished === furnished)
      .sort((a, b) => a.size_sqft - b.size_sqft);
    if (!rows.length) return null;
    if (size <= rows[0].size_sqft) return rows[0].predicted_price_aed_month;
    if (size >= rows.at(-1).size_sqft) return rows.at(-1).predicted_price_aed_month;
    const i = rows.findIndex((r) => r.size_sqft >= size), lo = rows[i - 1], hi = rows[i];
    return lo.predicted_price_aed_month + ((size - lo.size_sqft) / (hi.size_sqft - lo.size_sqft)) * (hi.predicted_price_aed_month - lo.predicted_price_aed_month);
  }

  function sizeRange(type) {
    const sizes = D.fair_value_grid.filter((r) => r.property_type === type).map((r) => r.size_sqft);
    return [Math.min(...sizes), Math.max(...sizes)];
  }

  const THRESHOLD = () => D.metrics.fraud_detection.model_based.threshold ?? -0.3;

  function verdictFor(r) {
    const t = THRESHOLD(), mape = D.metrics.model.mape;
    if (r <= t) return { cls: "cheap", word: "Too cheap to trust",
      line: `${pct(-r)} below what this unit should rent for. On the labelled data, ${pct(D.metrics.fraud_detection.model_based.precision)} of listings priced this far below fair value were scams.` };
    if (r < -mape) return { cls: "deal", word: "A good deal", line: `${pct(-r)} below fair value: cheaper than usual, but not far enough below to look like a scam.` };
    if (r <= mape) return { cls: "fair", word: "Fair", line: `Within ${pct(mape)} of fair value, the model's typical error on listings it never saw.` };
    if (r < -t) return { cls: "over", word: "Above market", line: `${pct(r)} above fair value. Worth negotiating, or checking what justifies the premium.` };
    return { cls: "over", word: "Overpriced", line: `${pct(r)} above fair value for this area, type, size and furnishing.` };
  }

  function renderChecker() {
    const areas = [...new Set(D.fair_value_grid.map((r) => r.area))].sort();
    const types = [...new Set(D.fair_value_grid.map((r) => r.property_type))];
    $("c-area").innerHTML = areas.map((a) => `<option>${esc(a)}</option>`).join("");
    $("c-type").innerHTML = types.map((t) => `<option>${esc(t)}</option>`).join("");
    $("c-area").value = areas.includes("Dubai Marina") ? "Dubai Marina" : areas[0];
    $("c-type").value = types.includes("1BR Apartment") ? "1BR Apartment" : types[0];
    checker = { source: null };

    const furnished = () => Number(document.querySelector("input[name=furnished]:checked").value);
    const setSizeRange = (keep) => {
      const [lo, hi] = sizeRange($("c-type").value), s = $("c-size");
      s.min = lo; s.max = hi; s.step = 10;
      if (!keep) s.value = Math.round((lo + hi) / 2 / 10) * 10;
    };
    const resetPrice = () => { const f = fairValue($("c-area").value, $("c-type").value, +$("c-size").value, furnished()); $("c-price").value = Math.round(f / 50) * 50; };

    function update() {
      const area = $("c-area").value, type = $("c-type").value, size = +$("c-size").value, price = +$("c-price").value;
      $("c-size-out").textContent = `${num(size)} sqft`;
      const fair = fairValue(area, type, size, furnished());
      if (!fair || !price) return;
      const r = (price - fair) / fair, v = verdictFor(r);
      $("verdict").className = `verdict ${v.cls}`;
      $("v-word").textContent = v.word;
      $("v-line").textContent = v.line;
      $("v-fair").textContent = aed(Math.round(fair / 10) * 10);
      $("v-ask").textContent = aed(price);
      $("v-diff").textContent = signed(r);
      $("ruler").innerHTML = ruler(r, fair);
      $("v-source").textContent = checker.source
        ? `Loaded from flagged listing #${checker.source.listing_id}: “${checker.source.title}”. The estimate here uses only area, type, size and furnishing.`
        : "Estimate from area, type, size and furnishing, interpolated from the model's precomputed grid.";
    }

    const edited = () => { checker.source = null; update(); };
    $("c-area").addEventListener("change", () => { resetPrice(); edited(); });
    $("c-type").addEventListener("change", () => { setSizeRange(false); resetPrice(); edited(); });
    $("c-size").addEventListener("input", edited);
    $("c-price").addEventListener("input", edited);
    document.querySelectorAll("input[name=furnished]").forEach((r) => r.addEventListener("change", edited));
    $("checker").addEventListener("submit", (e) => e.preventDefault());
    $("load-fair").addEventListener("click", () => { resetPrice(); edited(); });

    let flaggedIndex = 0;
    $("load-flagged").addEventListener("click", () => {
      const pool = D.flagged_listings.filter((l) => l.is_suspicious_truth !== 0);
      const l = pool[flaggedIndex++ % pool.length];
      $("c-area").value = l.area; $("c-type").value = l.property_type; setSizeRange(true);
      $("c-size").value = l.size_sqft;
      document.querySelector(`input[name=furnished][value="${l.furnished ? 1 : 0}"]`).checked = true;
      $("c-price").value = l.price_aed_month;
      checker.source = l; update();
      if (matchMedia("(max-width: 1000px)").matches) $("verdict").scrollIntoView({ block: "start" });
    });

    checker.setArea = (area) => { $("c-area").value = area; resetPrice(); edited(); $("check").scrollIntoView({ behavior: "smooth" }); };
    setSizeRange(false); resetPrice(); update();
  }

  // Price ruler: residual from -60% to +60%, zones for scam / deal / fair / above, marker at the asking rent.
  function ruler(r, fair) {
    const W = 600, H = 74, L = 8, R = 8, lo = -0.6, hi = 0.6, t = THRESHOLD(), m = D.metrics.model.mape;
    const x = (v) => L + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - L - R);
    const zones = [[lo, t, "z-cheap"], [t, -m, "z-deal"], [-m, m, "z-fair"], [m, hi, "z-over"]];
    const ticks = [-0.6, t, -m, 0, m, 0.3, 0.6].filter((v, i, a) => a.indexOf(v) === i);
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${zones.map(([a, b, c]) => `<rect class="${c}" x="${x(a)}" y="22" width="${x(b) - x(a)}" height="14" />`).join("")}
      ${ticks.map((v) => `<line x1="${x(v)}" x2="${x(v)}" y1="36" y2="42" class="tick"/><text x="${x(v)}" y="56" text-anchor="middle" class="tick-label">${v === 0 ? "fair" : signed(v)}</text>`).join("")}
      <text x="${x(0)}" y="70" text-anchor="middle" class="tick-label dim">${aed(Math.round(fair / 10) * 10)}</text>
      <g class="marker" transform="translate(${x(r)},0)"><path d="M-7,4 L7,4 L0,16 Z"/><line x1="0" x2="0" y1="16" y2="40"/></g>
    </svg>`;
  }

  // ------------------------------------------------------------------ market map
  // Rough Dubai coastline (lat, lon), south-west to north-east. Schematic only.
  const COAST = [[24.97, 55.03], [25.0, 55.07], [25.03, 55.1], [25.06, 55.122], [25.08, 55.135], [25.1, 55.155], [25.125, 55.185],
    [25.15, 55.208], [25.175, 55.226], [25.2, 55.243], [25.225, 55.258], [25.25, 55.274], [25.27, 55.29]];
  // Which side of its circle each area's label sits on, chosen so the crowded western cluster stays readable.
  const LABEL_SIDE = { "Dubai Marina": "l", "Palm Jumeirah": "l", "Jumeirah Lake Towers": "l", "Discovery Gardens": "l", "Al Furjan": "r",
    "Jumeirah Village Circle": "t", "Dubai Sports City": "b", "Arabian Ranches": "r", "Business Bay": "l", "Downtown Dubai": "r",
    "Dubai Silicon Oasis": "b", "Mirdif": "t" };

  function rentColor(t) { // dusk violet -> lantern orange -> pale gold
    const stops = [[107, 96, 160], [245, 162, 93], [255, 221, 150]];
    const [a, b, u] = t < 0.6 ? [stops[0], stops[1], t / 0.6] : [stops[1], stops[2], (t - 0.6) / 0.4];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * u)).join(",")})`;
  }

  function renderMap() {
    const areas = D.area_summary.filter((a) => a.lat != null);
    const svg = $("area-map");
    if (!areas.length) { svg.outerHTML = `<p class="sub">Map data missing: re-run <code>python run_pipeline.py</code>.</p>`; return; }
    const W = 760, H = 560, lonMin = 55.03, lonMax = 55.46, latMin = 24.97, latMax = 25.27, k = Math.cos(25.1 * Math.PI / 180);
    const sx = (W - 40) / ((lonMax - lonMin) * k), sy = (H - 40) / (latMax - latMin), s = Math.min(sx, sy);
    const px = (lon) => 20 + (lon - lonMin) * k * s, py = (lat) => 20 + (latMax - lat) * s;
    const coast = COAST.map(([la, lo]) => `${px(lo).toFixed(1)},${py(la).toFixed(1)}`);
    const rents = areas.map((a) => a.avg_price_per_sqft_annual), rMin = Math.min(...rents), rMax = Math.max(...rents);
    const ranked = [...areas].sort((a, b) => b.avg_price_per_sqft_annual - a.avg_price_per_sqft_annual);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `
      <path class="sea" d="M0,0 L${coast[coast.length - 1].split(",")[0]},0 L${coast.slice().reverse().join(" L")} L0,${H} Z"/>
      <polyline class="coast" points="${coast.join(" ")}"/>
      <text class="sea-label" x="${px(55.07)}" y="${py(25.2)}">Arabian Gulf</text>
      ${ranked.map((a) => {
        const t = (a.avg_price_per_sqft_annual - rMin) / (rMax - rMin || 1), r = 8;
        const x = px(a.lon), y = py(a.lat), side = LABEL_SIDE[a.area] || "r";
        const [lx, ly, anchor] = { l: [x - r - 6, y + 4, "end"], r: [x + r + 6, y + 4, "start"], t: [x, y - r - 7, "middle"], b: [x, y + r + 15, "middle"] }[side];
        return `<g class="area-dot" tabindex="0" role="button" data-area="${esc(a.area)}" aria-label="${esc(a.area)}, AED ${Math.round(a.avg_price_per_sqft_annual)} per sqft a year">
          <circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${rentColor(t)}"/>
          <text x="${lx}" y="${ly}" text-anchor="${anchor}">${esc(a.area)}</text></g>`;
      }).join("")}
      <g class="legend" transform="translate(${W - 230},${H - 54})">
        <text x="0" y="0">Rent per sqft a year</text>
        ${[0, 0.25, 0.5, 0.75, 1].map((t, i) => `<rect x="${i * 40}" y="8" width="40" height="10" fill="${rentColor(t)}"/>`).join("")}
        <text x="0" y="34">AED ${Math.round(rMin)}</text><text x="200" y="34" text-anchor="end">AED ${Math.round(rMax)}</text>
      </g>`;
    const pick = (el) => selectArea(el.dataset.area);
    svg.querySelectorAll(".area-dot").forEach((g) => {
      g.addEventListener("click", () => pick(g));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(g); } });
    });
    selectArea(ranked[0].area);
  }

  function selectArea(name) {
    const ranked = [...D.area_summary].sort((a, b) => b.avg_price_per_sqft_annual - a.avg_price_per_sqft_annual);
    const a = ranked.find((r) => r.area === name), rank = ranked.indexOf(a) + 1;
    document.querySelectorAll(".area-dot").forEach((g) => g.classList.toggle("selected", g.dataset.area === name));
    const flagged = D.flagged_listings.filter((l) => l.area === name);
    const max = ranked[0].avg_price_per_sqft_annual;
    $("area-panel").innerHTML = `
      <h3>${esc(name)}</h3>
      <p class="area-figure"><strong>AED ${Math.round(a.avg_price_per_sqft_annual)}</strong> per sqft a year, ${ordinal(rank)} of ${ranked.length}</p>
      <dl class="area-facts">
        <div><dt>Listings after merging re-posts</dt><dd>${num(a.listing_count)}</dd></div>
        <div><dt>Flagged as too cheap</dt><dd>${flagged.length}</dd></div>
      </dl>
      <button type="button" class="link" id="check-here">Check a rent in ${esc(name)}</button>
      <ol class="rank">${ranked.map((r) => `<li class="${r.area === name ? "on" : ""}"><button type="button" data-area="${esc(r.area)}">
        <span>${esc(r.area)}</span><span class="bar"><span style="width:${(r.avg_price_per_sqft_annual / max * 100).toFixed(1)}%"></span></span><span class="v">${Math.round(r.avg_price_per_sqft_annual)}</span></button></li>`).join("")}</ol>`;
    $("check-here").addEventListener("click", () => checker.setArea(name));
    $("area-panel").querySelectorAll(".rank button").forEach((b) => b.addEventListener("click", () => selectArea(b.dataset.area)));
  }
  const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;

  // ------------------------------------------------------------------ duplicates
  function renderClusters() {
    const clusters = D.duplicate_clusters, total = D.duplicate_clusters_total || clusters.length, m = D.metrics.dedup;
    $("dup-sub").textContent = `${num(total)} groups of re-posted units found in ${m.runtime_seconds.toFixed(1)} s, with ${pct(m.precision, 1)} precision and ${pct(m.recall, 1)} recall against the known duplicates.`;
    let i = 0;
    const show = () => {
      const c = clusters[i], prices = c.members.map((x) => x.price_aed_month), agents = new Set(c.members.map((x) => x.agent_name));
      const best = Math.max(...c.pair_scores.map((p) => p.score));
      $("cluster").innerHTML = `
        <p class="cluster-head">${c.members.length} posts of one ${esc(c.members[0].property_type.toLowerCase())} in ${esc(c.members[0].area)}, by ${agents.size} agent${agents.size > 1 ? "s" : ""}.
          Asking rent ranges from ${aed(Math.min(...prices))} to ${aed(Math.max(...prices))}. Strongest match ${pct(best)}.</p>
        <ul>${c.members.map((x) => `<li><p class="t">${esc(x.title)}</p>
          <p class="meta"><span>${aed(x.price_aed_month)} a month</span><span>${num(x.size_sqft)} sqft</span><span>${esc(x.agent_name)}</span><span>${esc(x.listed_date)}</span></p></li>`).join("")}</ul>`;
      $("dup-pos").textContent = `${i + 1} of ${clusters.length}${clusters.length < total ? " shown here" : ""}`;
    };
    $("dup-prev").addEventListener("click", () => { i = (i - 1 + clusters.length) % clusters.length; show(); });
    $("dup-next").addEventListener("click", () => { i = (i + 1) % clusters.length; show(); });
    show();
  }

  // ------------------------------------------------------------------ fraud
  function renderFraud() {
    const fr = D.metrics.fraud_detection, n = fr.naive_baseline, m = fr.model_based;
    const row = (k, a, b, fmt, better) => `<tr><th scope="row">${k}</th><td>${fmt(a)}</td><td class="${better(a, b) ? "" : "win"}">${fmt(b)}</td></tr>`;
    const hi = (a, b) => a >= b, lo = (a, b) => a <= b;
    $("versus").innerHTML = `<thead><tr><th></th><th scope="col">Rule: under 65% of the area median</th><th scope="col">Model: 30% under fair value</th></tr></thead><tbody>
      ${row("Scams caught", n.recall, m.recall, (v) => pct(v, 1), hi)}
      ${row("Flags that were real scams", n.precision, m.precision, (v) => pct(v, 1), hi)}
      ${row("Honest listings wrongly flagged", n.false_positives, m.false_positives, String, lo)}
      ${row("Scams missed", n.false_negatives, m.false_negatives, String, lo)}</tbody>`;
    $("versus-note").textContent = `${fr.true_suspicious} labelled scams. Every listing is priced by a model trained on other folds, grouped by physical unit, so no listing is judged by a model that saw it or its re-posts.`;

    let all = false;
    const draw = () => {
      const rows = all ? D.flagged_listings : D.flagged_listings.slice(0, 8);
      $("flagged").innerHTML = `<thead><tr><th scope="col">Listing</th><th scope="col">Area</th><th scope="col" class="r">Asking</th><th scope="col" class="r">Fair value</th><th scope="col">Below fair value</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="lt">${esc(r.title)}</td><td class="la">${esc(r.area)}</td><td class="r" data-label="Asking">${aed(r.price_aed_month)}</td><td class="r" data-label="Fair value">${aed(Math.round(r.predicted_price_aed_month))}</td>
          <td data-label="Below fair value"><span class="gap"><span style="width:${Math.min(100, -r.residual_pct * 100).toFixed(0)}%"></span></span> ${pct(-r.residual_pct)}</td></tr>`).join("")}</tbody>`;
      $("flag-more").textContent = all ? "Show fewer" : `Show all ${D.flagged_listings.length} flagged listings`;
    };
    $("flag-more").addEventListener("click", () => { all = !all; draw(); });
    draw();
  }

  // ------------------------------------------------------------------ replay
  function renderReplay() {
    const feed = D.live_feed, st = D.metrics.streaming;
    $("replay-sub").textContent = `New listings in posting order, each priced by the trained model as it arrives. Average ${st.avg_latency_ms.toFixed(1)} ms per listing, 99th percentile ${st.p99_latency_ms.toFixed(1)} ms.`;
    const label = { underpriced: "Too cheap", overpriced: "Over value", fair: "At value" };
    const item = (r) => `<li class="${r.flag}"><span class="t">${esc(r.title)}</span><span class="p">${aed(r.price_aed_month)}</span><span class="r">${signed(r.residual_pct)}</span><span class="f">${label[r.flag] || r.flag}</span></li>`;
    $("feed").innerHTML = feed.slice(0, 6).map(item).join("");
    let timer;
    $("replay-btn").addEventListener("click", () => {
      clearInterval(timer); $("feed").innerHTML = ""; let i = 0;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) { $("feed").innerHTML = feed.slice(0, 8).map(item).join(""); return; }
      timer = setInterval(() => {
        if (i >= feed.length) return clearInterval(timer);
        $("feed").insertAdjacentHTML("afterbegin", item(feed[i++]));
        while ($("feed").children.length > 8) $("feed").lastElementChild.remove();
      }, 320);
    });
  }

  // ------------------------------------------------------------------ how it works
  function renderStages() {
    const m = D.metrics, w = m.etl_last_run;
    const stages = [
      [`${num(m.dedup.listings_scored)} listings`, "Raw batch loaded, with completeness and exact-duplicate checks."],
      [`${num(m.dedup.clusters_found)} re-post groups`, `Blocking, distance, price and size gates, then title similarity. F1 ${m.dedup.f1.toFixed(3)}.`],
      [`${num(m.model.n_train)} training units`, "One row per physical unit, known scams excluded."],
      [`${pct(m.model.mape, 1)} typical error`, `Gradient-boosted model on ${num(m.model.n_test)} held-out units, R² ${m.model.r2.toFixed(3)}.`],
      [`${m.fraud_detection.model_based.flagged} flagged`, "Every listing priced out-of-fold; more than 30% under fair value is flagged."],
      [`${num(w.rows_unchanged + w.rows_inserted + w.rows_updated)} rows in the warehouse`, `Incremental upsert: last run inserted ${w.rows_inserted}, updated ${w.rows_updated}, left ${num(w.rows_unchanged)} unchanged.`],
    ];
    $("stages").innerHTML = stages.map(([h, p]) => `<li><strong>${h}</strong><span>${p}</span></li>`).join("");
  }

  function renderScatter() {
    const m = D.metrics.model, pts = D.test_predictions;
    $("model-sub").textContent = `${num(m.n_test)} held-out listings. Average error ${aed(m.mae_aed)} a month (${pct(m.mape, 1)}). Points on the line are priced exactly right. Log scale.`;
    const W = 520, H = 360, L = 58, B = 40, T = 10, R = 10;
    const all = pts.flatMap((p) => [p.actual, p.predicted]), lo = Math.log10(Math.min(...all) * 0.9), hi = Math.log10(Math.max(...all) * 1.1);
    const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (W - L - R), y = (v) => H - B - ((Math.log10(v) - lo) / (hi - lo)) * (H - B - T);
    const ticks = [1000, 2000, 5000, 10000, 20000, 50000].filter((v) => Math.log10(v) >= lo && Math.log10(v) <= hi);
    const k = (v) => (v >= 1000 ? `${v / 1000}k` : v);
    $("scatter").setAttribute("viewBox", `0 0 ${W} ${H}`);
    $("scatter").innerHTML = `
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${k(v)}</text>
        <line class="grid" y1="${T}" y2="${H - B}" x1="${x(v)}" x2="${x(v)}"/><text class="axis" x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${k(v)}</text>`).join("")}
      <line class="ideal" x1="${x(10 ** lo)}" y1="${y(10 ** lo)}" x2="${x(10 ** hi)}" y2="${y(10 ** hi)}"/>
      ${pts.map((p) => `<circle class="pt" cx="${x(p.actual).toFixed(1)}" cy="${y(p.predicted).toFixed(1)}" r="2.6"/>`).join("")}
      <text class="axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">Actual rent, AED a month</text>
      <text class="axis" transform="translate(14,${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">Predicted</text>`;
  }

  function hbars(el, rows) {
    const max = Math.max(...rows.map((r) => r[1]), 1e-9);
    el.innerHTML = rows.map(([k, v, label]) => `<div class="hbar"><span class="k">${esc(k)}</span><span class="track"><span style="width:${(v / max * 100).toFixed(1)}%"></span></span><span class="v">${label}</span></div>`).join("");
  }

  function renderImportance() {
    hbars($("importance"), D.metrics.feature_importances.filter((f) => f.importance >= 0.001)
      .map((f) => [FEATURES[f.feature] || f.feature.replaceAll("_", " "), f.importance, pct(f.importance, 1)]));
  }

  function renderWarehouse() {
    const qs = D.warehouse_queries, tabs = $("query-tabs");
    const cell = (v) => (v == null ? "" : typeof v === "number" ? (Number.isInteger(v) ? num(v) : v.toFixed(1)) : esc(v));
    const show = (i) => {
      const q = qs[i];
      tabs.querySelectorAll("button").forEach((b, j) => { b.setAttribute("aria-selected", String(i === j)); b.tabIndex = i === j ? 0 : -1; });
      $("query-desc").textContent = q.description;
      $("query-sql").textContent = q.sql;
      const numeric = q.columns.map((_, c) => q.rows.every((r) => r[c] == null || typeof r[c] === "number"));
      $("query-table").innerHTML = `<thead><tr>${q.columns.map((c, j) => `<th scope="col" class="${numeric[j] ? "r" : ""}">${esc(c.replaceAll("_", " "))}</th>`).join("")}</tr></thead>
        <tbody>${q.rows.map((r) => `<tr>${r.map((v, j) => `<td class="${numeric[j] ? "r" : ""}">${cell(v)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    };
    tabs.innerHTML = qs.map((q, i) => `<button type="button" role="tab" data-i="${i}">${esc(q.title)}</button>`).join("");
    tabs.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => show(+b.dataset.i)));
    tabs.addEventListener("keydown", (e) => {
      const cur = [...tabs.children].findIndex((b) => b.getAttribute("aria-selected") === "true");
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { const n = (cur + (e.key === "ArrowRight" ? 1 : -1) + qs.length) % qs.length; show(n); tabs.children[n].focus(); }
    });
    show(0);
  }

  function renderHealth() {
    const dq = D.metrics.data_quality, wh = D.metrics.warehouse;
    hbars($("quality"), Object.entries(dq.field_completeness).map(([k, v]) => [k.replaceAll("_", " "), v, pct(v, 1)]));
    $("quality").insertAdjacentHTML("beforeend", `<p class="sub">${num(dq.exact_duplicate_rows)} exact-match duplicate rows; the fuzzy matcher finds ${num(D.metrics.dedup.predicted_duplicate_pairs)} duplicate pairs.</p>`);
    $("tables").innerHTML = Object.entries(wh).map(([t, n]) => `<div><dt><code>${esc(t)}</code></dt><dd>${num(n)}</dd></div>`).join("");
  }

  function init(data) {
    D = data;
    // Each panel renders independently, so one failure shows a notice instead of blanking the page.
    const panels = [[renderChecker, "#check"], [renderMap, "#map"], [renderClusters, "#trust"], [renderFraud, "#trust"], [renderReplay, "#trust"],
      [renderStages, "#how"], [renderScatter, "#how"], [renderImportance, "#how"], [renderWarehouse, "#how"], [renderHealth, "#how"]];
    for (const [render, sel] of panels) {
      try { render(); } catch (err) {
        console.error(`SouqPulse: ${render.name} failed`, err);
        document.querySelector(sel)?.insertAdjacentHTML("beforeend", `<p class="load-error">Part of this section couldn't be drawn (${esc(err.message)}).</p>`);
      }
    }
  }

  return { init };
})();
