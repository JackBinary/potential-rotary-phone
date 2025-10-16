// Batch overwrite multiple compendiums from your GitHub raw JSON files.
// Paste into Foundry console while your world is open.

(async () => {
  // ======== CONFIG ========
  const BASE_URL = "https://raw.githubusercontent.com/JackBinary/potential-rotary-phone/refs/heads/main/";
  const FILES = [
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
  ];
  const CHUNK = 20;                 // batch size for delete/import
  const SHOW_TOASTS = true;
  const UNLOCK_IF_LOCKED = true;    // auto-unlock before writing
  const CREATE_IF_MISSING = false;  // keep false to require originals exist
  const SLEEP_MS_BETWEEN_FILES = 300; // small breather between packs
  // ========================

  const toast = (m, t="info") => SHOW_TOASTS && ui.notifications[t]?.(m);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function wipePack(pack) {
    const index = await pack.getIndex();
    const ids = index.map(e => e._id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      try {
        await pack.documentClass.deleteDocuments(slice, { pack: pack.collection });
      } catch (err) {
        console.warn("Batch delete failed, falling back to singles", err);
        for (const id of slice) {
          try { await pack.deleteDocument(id); } catch (e) { console.error("Delete failed", id, e); }
        }
      }
    }
  }

  async function importDocs(pack, docs) {
    let imported = 0;

    // build temp Item documents first so Foundry treats them as the right class
    async function buildTemp(raw) {
      const data = foundry.utils.duplicate(raw);
      return await pack.documentClass.create(data, { temporary: true });
    }

    for (let i = 0; i < docs.length; i += CHUNK) {
      const slice = docs.slice(i, i + CHUNK);
      const temps = [];
      for (const d of slice) {
        try {
          const t = await buildTemp(d);
          temps.push(t);
        } catch (e) {
          console.error(`Temp create failed for "${d?.name ?? d?._id}"`, e, d);
          toast(`Temp create failed: ${d?.name ?? d?._id}`, "warn");
        }
      }
      for (const t of temps) {
        try {
          await pack.importDocument(t, { keepId: true });
          imported++;
        } catch (e) {
          console.error(`Import failed for "${t?.name ?? t?.id}"`, e, t);
          toast(`Import error: ${t?.name ?? t?.id}`, "warn");
        }
      }
    }
    await pack.getIndex({ reload: true });
    return imported;
  }

  const results = [];
  for (const fname of FILES) {
    const url = BASE_URL + fname;
    toast(`Fetching ${fname}...`);
    let payload;
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      payload = await resp.json();
    } catch (e) {
      console.error(`Fetch/parse failed for ${fname}`, e);
      toast(`Failed to fetch/parse ${fname}: ${e.message}`, "error");
      results.push({ file: fname, status: "error", error: e.message });
      await sleep(SLEEP_MS_BETWEEN_FILES);
      continue;
    }

    if (!payload?.documents || !payload?.pack?.collection) {
      toast(`Invalid JSON shape in ${fname}`, "error");
      results.push({ file: fname, status: "error", error: "Invalid JSON shape" });
      await sleep(SLEEP_MS_BETWEEN_FILES);
      continue;
    }

    const collection = payload.pack.collection;
    let pack = game.packs.get(collection);
    if (!pack) {
      if (!CREATE_IF_MISSING) {
        toast(`Compendium missing: ${collection}`, "error");
        results.push({ file: fname, status: "missing-pack", collection });
        await sleep(SLEEP_MS_BETWEEN_FILES);
        continue;
      }
      // optional pack creation (kept off by default)
      try {
        const created = await CompendiumCollection.createCompendium({
          label: payload.pack.label ?? collection.split(".").pop(),
          type: payload.pack.type ?? "Item",
          package: "world",
          system: payload.pack.system || game.system.id
        });
        pack = game.packs.get(created.collection);
      } catch (e) {
        toast(`Failed to create pack for ${collection}`, "error");
        results.push({ file: fname, status: "error", error: "create-pack-failed" });
        await sleep(SLEEP_MS_BETWEEN_FILES);
        continue;
      }
    }

    // Optional sanity warnings
    if (payload.pack.type && pack.documentName !== payload.pack.type) {
      console.warn(`Type mismatch for ${collection}: JSON=${payload.pack.type}, Pack=${pack.documentName}`);
    }
    if (payload.pack.system && pack.metadata.system !== payload.pack.system) {
      console.warn(`System mismatch for ${collection}: JSON=${payload.pack.system}, Pack=${pack.metadata.system}`);
    }

    // Unlock if needed
    if (pack.locked && UNLOCK_IF_LOCKED) {
      try {
        await pack.configure({ locked: false });
        toast(`Unlocked "${pack.metadata.label}"`);
      } catch (e) {
        console.warn("Could not unlock pack:", e);
      }
    }

    // Wipe
    toast(`Clearing "${pack.metadata.label}"...`);
    await wipePack(pack);

    // Import
    toast(`Importing ${payload.documents.length} into "${pack.metadata.label}"...`);
    const imported = await importDocs(pack, payload.documents);
    toast(`Imported ${imported}/${payload.documents.length} into "${pack.metadata.label}".`);
    results.push({ file: fname, status: "ok", imported, collection });

    await sleep(SLEEP_MS_BETWEEN_FILES);
  }

  console.table(results);
  console.log("Batch complete:", results);
  toast("Batch import complete. Check console for summary.");
})();
