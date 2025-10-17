(() => {
  if (window.__L5R5E_BATCH_RUNNING__) {
    console.warn("[L5R5E] batch upsert already running");
    return;
  }
  window.__L5R5E_BATCH_RUNNING__ = true;

  window.L5R5E = window.L5R5E || {};

  const DEFAULTS = {
    BASE_URL: "https://raw.githubusercontent.com/JackBinary/potential-rotary-phone/refs/heads/main/",
    FILES: [
      "l5r5e.core-bonds_Bonds.json",
      "l5r5e.core-peculiarities-adversities_Adversities.json",
      "l5r5e.core-peculiarities-anxieties_Anxieties.json",
      "l5r5e.core-peculiarities-distinctions_Distinctions.json",
      "l5r5e.core-peculiarities-passions_Passions.json",
      "l5r5e.core-techniques-inversions_Techniques_Inversions.json",
      "l5r5e.core-techniques-invocations_Techniques_Invocations.json",
      "l5r5e.core-techniques-kata_Techniques_Kata.json",
      "l5r5e.core-techniques-kiho_Techniques_Kih_.json",
      "l5r5e.core-techniques-maho_Techniques_Mah_.json",
      "l5r5e.core-techniques-mantra_Techniques_Mantra.json",
      "l5r5e.core-techniques-mastery_Mastery_Abilities.json",
      "l5r5e.core-techniques-ninjutsu_Techniques_Ninjutsu.json",
      "l5r5e.core-techniques-rituals_Techniques_Rituals.json",
      "l5r5e.core-techniques-school_School_Abilities.json",
      "l5r5e.core-techniques-shuji_Techniques_Shuji.json",
      "l5r5e.core-titles_Titles.json",
    ],
    // --- Upsert behavior ---
    MATCH_BY_NAME_FIRST: true,       // <== key change: match by name+type before _id
    NAME_COLLAPSE_WHITESPACE: true,
    NAME_REMOVE_DIACRITICS: true,
    PATCH_ONLY: true,                // only update selected fields below
    PATCH_PATHS: ["system.description"],
    // --- Runtime ---
    CHUNK: 25,
    UNLOCK_IF_LOCKED: true,
    SHOW_TOASTS: true,
    SLEEP_BETWEEN_FILES: 300
  };

  const toast = (m,t="info",cfg=DEFAULTS)=>cfg.SHOW_TOASTS&&ui.notifications[t]?.(m);
  const sleep = ms => new Promise(r=>setTimeout(r,ms));

  // ---------- Name normalization & keys ----------
  const removeDiacritics = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  function normName(s, cfg) {
    if (!s) return "";
    let out = String(s);
    if (cfg.NAME_REMOVE_DIACRITICS) out = removeDiacritics(out);
    out = out.toLowerCase();
    if (cfg.NAME_COLLAPSE_WHITESPACE) out = out.replace(/\s+/g, " ");
    return out.trim();
  }
  const nameKey = (name, type, cfg, pack) => `${normName(name, cfg)}::${type || pack.documentName}`;

  // ---------- Object path helpers ----------
  const getByPath=(obj,p)=>p.split(".").reduce((a,c)=>a?.[c],obj);
  const setByPath=(obj,p,v)=>p.split(".").reduce((a,c,i,arr)=>(i===arr.length-1?a[c]=v:(a[c]??={}),a[c]),obj);
  const buildPatch=(src,paths)=>{const o={};for(const p of paths){const v=getByPath(src,p);if(v!==undefined)setByPath(o,p,v);}return o;};

  async function buildPackIndexes(pack, cfg) {
    const idx = await pack.getIndex();
    // Build: id set, and name->id map (first seen wins)
    const idSet = new Set(idx.map(e => e._id));
    const nameMap = new Map(); // key: nameKey -> id
    const dupNames = new Map(); // key -> array of ids (for info)
    for (const e of idx) {
      const key = nameKey(e.name, e.type, cfg, pack);
      if (!nameMap.has(key)) {
        nameMap.set(key, e._id);
      } else {
        // track duplicates for logging
        const arr = dupNames.get(key) || [];
        arr.push(e._id);
        dupNames.set(key, arr);
      }
    }
    if (dupNames.size) {
      console.warn("[L5R5E] Duplicate names detected in pack:", pack.collection, dupNames);
    }
    return { idSet, nameMap };
  }

  async function processFile(fname, cfg) {
    const url = cfg.BASE_URL + fname;
    toast(`Fetching ${fname}…`, "info", cfg);

    // Fetch JSON
    let payload;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      payload = await r.json();
    } catch (e) {
      console.error("[L5R5E] Fetch fail", e);
      toast(`Fetch failed: ${fname}`, "error", cfg);
      return { file: fname, status: "fetch-failed" };
    }

    if (!payload?.documents || !payload?.pack?.collection) {
      toast(`Invalid JSON in ${fname}`, "error", cfg);
      return { file: fname, status: "bad-json" };
    }

    const collection = payload.pack.collection;
    const pack = game.packs.get(collection);
    if (!pack) {
      toast(`Pack missing: ${collection}`, "error", cfg);
      return { file: fname, status: "no-pack", collection };
    }

    if (pack.locked && cfg.UNLOCK_IF_LOCKED) {
      try { await pack.configure({ locked:false }); toast(`Unlocked ${pack.metadata.label}`,"info",cfg); }
      catch(e){ console.warn("Unlock failed", e); }
    }

    // Build indexes
    const { idSet, nameMap } = await buildPackIndexes(pack, cfg);

    let updatedByName = 0, updatedById = 0, created = 0, failed = 0;

    const buildTemp = async d => pack.documentClass.create(foundry.utils.duplicate(d), { temporary:true });

    // Process in batches
    for (let i = 0; i < payload.documents.length; i += cfg.CHUNK) {
      const slice = payload.documents.slice(i, i + cfg.CHUNK);

      for (const d of slice) {
        try {
          const key = nameKey(d.name, d.type, cfg, pack);
          let targetDoc = null;

          // 1) Prefer matching by NAME+TYPE
          if (cfg.MATCH_BY_NAME_FIRST && nameMap.has(key)) {
            const targetId = nameMap.get(key);
            targetDoc = await pack.getDocument(targetId);
            if (targetDoc) {
              if (cfg.PATCH_ONLY) {
                const patch = buildPatch(d, cfg.PATCH_PATHS);
                patch._id = targetDoc.id;
                await targetDoc.update(patch, { pack: pack.collection });
              } else {
                await targetDoc.update(d, { pack: pack.collection });
              }
              updatedByName++;
              continue;
            }
          }

          // 2) Fallback: exact _id match
          if (idSet.has(d._id)) {
            const byId = await pack.getDocument(d._id);
            if (byId) {
              if (cfg.PATCH_ONLY) {
                const patch = buildPatch(d, cfg.PATCH_PATHS);
                patch._id = d._id;
                await byId.update(patch, { pack: pack.collection });
              } else {
                await byId.update(d, { pack: pack.collection });
              }
              updatedById++;
              continue;
            }
          }

          // 3) Neither matched → create new (keepId)
          const tmp = await buildTemp(d);
          await pack.importDocument(tmp, { keepId:true });
          created++;

          // Update indexes so later items in this batch can match by name
          const newId = tmp.id || d._id;
          idSet.add(newId);
          if (!nameMap.has(key)) nameMap.set(key, newId);

        } catch (e) {
          failed++;
          console.error(`[L5R5E] Upsert fail for ${d?.name ?? d?._id}`, e);
          toast(`Fail: ${d?.name ?? d?._id}`, "warn", cfg);
        }
      }
    }

    await pack.getIndex({ reload:true });
    toast(`${pack.metadata.label}: ${updatedByName} name-updated, ${updatedById} id-updated, ${created} created, ${failed} failed`, "info", cfg);
    return { file: fname, updatedByName, updatedById, created, failed, collection };
  }

  async function main(opts={}) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const results = [];
    console.info("[L5R5E] Batch UPSERT (name-first) starting…");
    for (const f of cfg.FILES) {
      results.push(await processFile(f, cfg));
      await sleep(cfg.SLEEP_BETWEEN_FILES);
    }
    console.table(results);
    toast("Batch upsert complete — see console for summary", "info", cfg);
    window.__L5R5E_BATCH_RUNNING__ = false;
    return results;
  }

  window.L5R5E.batchUpsert = main;
  main();
})();
