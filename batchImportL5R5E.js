// batchImportL5R5E.js
// Legend of the Five Rings (L5R5e) compendium batch importer for Foundry VTT
// v1.1 (2025-10-16)
// - Safe IIFE wrapper
// - Duplicate-run guard
// - Exposes window.L5R5E.batchImport(opts)
// - Defaults to your GitHub raw URLs & file list

(() => {
  const VERSION = "1.1";

  // Prevent concurrent runs
  if (window.__L5R5E_BATCH_IMPORT_RUNNING__) {
    console.warn("[L5R5E] batch import already running; aborting new invocation.");
    return;
  }
  window.__L5R5E_BATCH_IMPORT_RUNNING__ = true;

  // Namespace + public API
  window.L5R5E = window.L5R5E || {};

  // ---------- Defaults (you can override via window.L5R5E.batchImport({...})) ----------
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
    CHUNK: 20,                 // batch size for delete/import
    SHOW_TOASTS: true,         // Foundry toasts
    UNLOCK_IF_LOCKED: true,    // auto-unlock pack before writing
    CREATE_IF_MISSING: false,  // require original packs to exist by collection id
    SLEEP_MS_BETWEEN_FILES: 300
  };

  const toast = (m, t="info", cfg=DEFAULTS) => cfg.SHOW_TOASTS && ui.notifications[t]?.(m);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function wipePack(pack, cfg) {
    const index = await pack.getIndex();
    const ids = index.map(e => e._id);
    for (let i = 0; i < ids.length; i += cfg.CHUNK) {
      const slice = ids.slice(i, i + cfg.CHUNK);
      try {
        await pack.documentClass.deleteDocuments(slice, { pack: pack.collection });
      } catch (err) {
        console.warn("[L5R5E] Batch delete failed, falling back to per-id", err);
        for (const id of slice) {
          try { await pack.deleteDocument(id); } catch (e) { console.error("[L5R5E] Delete failed", id, e); }
        }
      }
    }
  }

  async function importDocs(pack, docs, cfg) {
    let imported = 0;

    // Create temporary Item instances first so Foundry recognizes the document class (e.g., ItemL5r5e)
    async function buildTemp(raw) {
      const data = foundry.utils.duplicate(raw);
      return await pack.documentClass.create(data, { temporary: true });
    }

    for (let i = 0; i < docs.length; i += cfg.CHUNK) {
      const slice = docs.slice(i, i + cfg.CHUNK);

      // Build temp docs
      const temps = [];
      for (const d of slice) {
        try {
          const t = await buildTemp(d);
          temps.push(t);
        } catch (e) {
          console.error(`[L5R5E] Temp create failed for "${d?.name ?? d?._id}"`, e, d);
          toast(`Temp create failed: ${d?.name ?? d?._id}`, "warn", cfg);
        }
      }

      // Import
      for (const t of temps) {
        try {
          await pack.importDocument(t, { keepId: true });
          imported++;
        } catch (e) {
          console.error(`[L5R5E] Import failed for "${t?.name ?? t?.id}"`, e, t);
          toast(`Import error: ${t?.name ?? t?.id}`, "warn", cfg);
        }
      }
    }

    await pack.getIndex({ reload: true });
    return imported;
  }

  async function processOneFile(fname, cfg) {
    const url = cfg.BASE_URL + fname;
    toast(`Fetching ${fname}...`, "info", cfg);

    // Fetch JSON
    let payload;
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      payload = await resp.json();
    } catch (e) {
      console.error(`[L5R5E] Fetch/parse failed for ${fname}`, e);
      toast(`Failed to fetch/parse ${fname}: ${e.message}`, "error", cfg);
      return { file: fname, status: "error", error: e.message };
    }

    if (!payload?.documents || !payload?.pack?.collection) {
      toast(`Invalid JSON shape in ${fname}`, "error", cfg);
      return { file: fname, status: "error", error: "invalid-json-shape" };
    }

    const collection = payload.pack.collection;
    let pack = game.packs.get(collection);
    if (!pack) {
      if (!cfg.CREATE_IF_MISSING) {
        toast(`Compendium missing: ${collection}`, "error", cfg);
        return { file: fname, status: "missing-pack", collection };
      }
      try {
        const created = await CompendiumCollection.createCompendium({
          label: payload.pack.label ?? collection.split(".").pop(),
          type: payload.pack.type ?? "Item",
          package: "world",
          system: payload.pack.system || game.system.id
        });
        pack = game.packs.get(created.collection);
      } catch (e) {
        toast(`Failed to create pack for ${collection}`, "error", cfg);
        return { file: fname, status: "error", error: "create-pack-failed", collection };
      }
    }

    // Warnings only
    if (payload.pack.type && pack.documentName !== payload.pack.type) {
      console.warn(`[L5R5E] Type mismatch for ${collection}: JSON=${payload.pack.type}, Pack=${pack.documentName}`);
    }
    if (payload.pack.system && pack.metadata.system !== payload.pack.system) {
      console.warn(`[L5R5E] System mismatch for ${collection}: JSON=${payload.pack.system}, Pack=${pack.metadata.system}`);
    }

    // Unlock if needed
    if (pack.locked && cfg.UNLOCK_IF_LOCKED) {
      try {
        await pack.configure({ locked: false });
        toast(`Unlocked "${pack.metadata.label}"`, "info", cfg);
      } catch (e) {
        console.warn("[L5R5E] Could not unlock pack:", e);
      }
    }

    // Wipe
    toast(`Clearing "${pack.metadata.label}"...`, "info", cfg);
    await wipePack(pack, cfg);

    // Import
    toast(`Importing ${payload.documents.length} into "${pack.metadata.label}"...`, "info", cfg);
    const imported = await importDocs(pack, payload.documents, cfg);
    toast(`Imported ${imported}/${payload.documents.length} into "${pack.metadata.label}".`, "info", cfg);

    return { file: fname, status: "ok", imported, collection };
  }

  async function main(opts = {}) {
    const cfg = Object.assign({}, DEFAULTS, opts);
    const results = [];

    console.info(`[L5R5E] Batch importer v${VERSION} starting…`);
    for (const fname of cfg.FILES) {
      const res = await processOneFile(fname, cfg);
      results.push(res);
      await sleep(cfg.SLEEP_MS_BETWEEN_FILES);
    }

    console.table(results);
    console.log("[L5R5E] Batch complete:", results);
    toast("Batch import complete. Check console for summary.", "info", cfg);
    return results;
  }

  // Expose API and auto-run once on load
  window.L5R5E.batchImport = main;

  // Auto-run with defaults
  main().finally(() => {
    window.__L5R5E_BATCH_IMPORT_RUNNING__ = false;
  });

})();
